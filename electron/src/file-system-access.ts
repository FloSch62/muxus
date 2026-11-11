import type { Session } from 'electron';

/**
 * Let the app windows write to a folder that Chromium restricts, such as
 * Downloads itself, because the user picked it in the native dialog and,
 * without a listener, Electron never settles the picker.
 */
export function allowRestrictedFolders(appSession: Session): void {
  appSession.on('file-system-access-restricted', (_event, _details, callback) => callback('allow'));
}
