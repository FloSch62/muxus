import type { LocalOpenApplication, LocalOpenTarget } from '@muxus/shared';

type DesktopBridge = NonNullable<Window['muxusDesktop']>;

export type LocalCopyBridge = Required<
  Pick<DesktopBridge, 'beginLocalCopy' | 'writeLocalCopy' | 'cancelLocalCopy' | 'openLocalCopy'>
>;

/** How "Open with…" picks the program on this platform. */
export type OpenWithChooser =
  /** Windows' own "How do you want to open this file?" dialog. */
  | 'system'
  /** The native file picker, starting in Applications (macOS). */
  | 'program-picker'
  /** Muxus' list of installed programs (Linux). */
  | 'application-list';

// Electron IPC messages have a size ceiling; large files cross in slices.
const LOCAL_COPY_CHUNK_BYTES = 8 * 1024 * 1024;

function localCopyBridge(desktop = window.muxusDesktop): LocalCopyBridge | undefined {
  if (
    !desktop?.beginLocalCopy ||
    !desktop.writeLocalCopy ||
    !desktop.cancelLocalCopy ||
    !desktop.openLocalCopy
  ) {
    return undefined;
  }
  return desktop as LocalCopyBridge;
}

/** Remote files can be opened with local programs only in the desktop app. */
export function canOpenLocally(desktop = window.muxusDesktop): boolean {
  return localCopyBridge(desktop) !== undefined;
}

export function openWithChooser(desktop = window.muxusDesktop): OpenWithChooser | undefined {
  if (!desktop || !canOpenLocally(desktop)) return undefined;
  if (desktop.platform === 'win32') return 'system';
  if (!desktop.chooseLocalProgram) return undefined;
  if (desktop.platform === 'darwin') return 'program-picker';
  return desktop.listLocalApplications ? 'application-list' : undefined;
}

/**
 * Pick a program with the native file picker. Resolves undefined when the
 * picker is cancelled and rejects when the picked file cannot be used.
 */
export async function chooseLocalProgram(
  desktop = window.muxusDesktop,
): Promise<LocalOpenApplication | undefined> {
  const choice = await desktop?.chooseLocalProgram?.();
  if (!choice) return undefined;
  if ('message' in choice) throw new Error(choice.message);
  return choice.application;
}

/** Hand a downloaded remote file to the desktop app and open it; resolves to the copy's id. */
export async function openDownloadedFile(
  name: string,
  blob: Blob,
  target: LocalOpenTarget,
  bridge = localCopyBridge(),
): Promise<string> {
  if (!bridge) throw new Error('Opening files with local programs needs the Muxus desktop app.');
  const id = await bridge.beginLocalCopy(name);
  if (!id) throw new Error(`Could not create a local copy of ${name}.`);
  try {
    for (let offset = 0; offset < blob.size; offset += LOCAL_COPY_CHUNK_BYTES) {
      const slice = blob.slice(offset, offset + LOCAL_COPY_CHUNK_BYTES);
      if (!(await bridge.writeLocalCopy(id, new Uint8Array(await slice.arrayBuffer())))) {
        throw new Error(`Could not write the local copy of ${name}.`);
      }
    }
  } catch (error) {
    void bridge.cancelLocalCopy(id).catch(() => undefined);
    throw error;
  }
  const result = await bridge.openLocalCopy(id, target);
  if (!result.ok) throw new Error(`Could not open ${name}: ${result.message}`);
  return id;
}
