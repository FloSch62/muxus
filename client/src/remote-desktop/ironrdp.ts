import initIronRdp, { setup } from '../vendor/ironrdp/ironrdp_web.js';

export {
  ClipboardData,
  DesktopSize,
  DeviceEvent,
  Extension,
  InputTransaction,
  IronErrorKind,
  RotationUnit,
  SessionBuilder,
  type IronError,
  type Session,
} from '../vendor/ironrdp/ironrdp_web.js';

let loading: Promise<void> | undefined;

/** Compile the WebAssembly module once per renderer, on the first RDP tab. */
export function loadIronRdp(): Promise<void> {
  loading ??= initIronRdp()
    .then(() => setup(import.meta.env.DEV ? 'info' : 'warn'))
    .catch((err: unknown) => {
      loading = undefined;
      throw err;
    });
  return loading;
}
