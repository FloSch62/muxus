import type { AppUpdater } from 'electron-updater';
import type { DesktopUpdateState } from '@muxus/shared';
import { mainLog } from './main-log.js';

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export function updateDisabledReason({ packaged, platform, store, appImage }: {
  packaged: boolean; platform: string; store: boolean; appImage: boolean;
}): DesktopUpdateState['reason'] {
  if (!packaged) return 'development';
  if (store) return 'store';
  if (platform === 'linux' && !appImage) return 'package-manager';
  return undefined;
}

/** Background checks run only while the renderer's update notifications are on. */
export class UpdateSchedule {
  private initialTimer?: NodeJS.Timeout;
  private interval?: NodeJS.Timeout;

  constructor(private readonly check: () => unknown) {}

  get running(): boolean { return this.interval !== undefined; }

  start(): void {
    if (this.interval) return;
    // Let the first window and its sessions settle before network/disk work.
    this.initialTimer = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    this.interval = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    this.initialTimer.unref();
    this.interval.unref();
  }

  stop(): void {
    clearTimeout(this.initialTimer);
    clearInterval(this.interval);
    this.initialTimer = undefined;
    this.interval = undefined;
  }
}

/** Owns one update operation for the entire app, independent of window lifetimes. */
export class DesktopUpdater {
  private state: DesktopUpdateState;
  private pendingCheck?: Promise<DesktopUpdateState>;
  private pendingDownload?: Promise<DesktopUpdateState>;
  private readonly schedule = new UpdateSchedule(() => this.check());

  constructor(private readonly options: {
    version: string;
    reason?: DesktopUpdateState['reason'];
    updater?: AppUpdater;
    broadcast(state: DesktopUpdateState): void;
    prepareInstall(): void;
    recoverInstall(): void;
  }) {
    this.state = { currentVersion: options.version, status: options.reason ? 'disabled' : 'idle', reason: options.reason };
    const updater = options.updater;
    if (!updater || options.reason) return;
    updater.autoDownload = false;
    // On macOS this also defers Squirrel's signature validation/staging until
    // quitAndInstall. Staging earlier would install on quit without consent.
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = {
      info: (message: unknown) => mainLog('info', `updater: ${String(message)}`),
      warn: (message: unknown) => mainLog('warn', `updater: ${String(message)}`),
      error: (message: unknown) => mainLog('error', `updater: ${String(message)}`),
    };
    updater.on('error', (error) => this.fail(error));
    updater.on('update-not-available', () => this.set({ status: 'up-to-date' }));
    updater.on('update-available', (info) => this.set({ status: 'available', version: info.version }));
    updater.on('download-progress', (progress) => {
      if (this.state.status !== 'downloading') return;
      const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
      if (percent !== this.state.percent) this.set({ ...this.state, percent });
    });
    updater.on('update-downloaded', (info) => {
      if (this.state.status === 'downloading') this.set({ status: 'ready', version: info.version, percent: 100 });
    });
  }

  getState(): DesktopUpdateState { return this.state; }

  setAutomaticChecks(enabled: boolean): void {
    if (!enabled) this.schedule.stop();
    else if (this.state.status !== 'disabled' && !['ready', 'installing'].includes(this.state.status)) this.schedule.start();
  }

  stop(): void {
    this.schedule.stop();
  }

  check(): Promise<DesktopUpdateState> {
    if (this.pendingDownload) return this.pendingDownload;
    if (this.pendingCheck) return this.pendingCheck;
    if (['disabled', 'ready', 'installing'].includes(this.state.status)) return Promise.resolve(this.state);
    this.pendingCheck = this.runCheck().finally(() => { this.pendingCheck = undefined; });
    return this.pendingCheck;
  }

  download(): Promise<DesktopUpdateState> {
    if (this.pendingDownload) return this.pendingDownload;
    this.pendingDownload = this.runDownload().finally(() => { this.pendingDownload = undefined; });
    return this.pendingDownload;
  }

  requestInstall(): boolean {
    if (this.state.status !== 'ready') return false;
    this.set({ ...this.state, status: 'installing' });
    this.stop();
    this.options.prepareInstall();
    return true;
  }

  /** Called only after the embedded server and persisted state have been closed. */
  finishInstall(): boolean {
    if (this.state.status !== 'installing') return false;
    try {
      this.options.updater!.quitAndInstall(false, true);
    } catch (error) {
      this.fail(error);
    }
    return true;
  }

  private async runCheck(): Promise<DesktopUpdateState> {
    this.set({ status: 'checking' });
    try {
      const result = await this.options.updater!.checkForUpdates();
      if (!result) throw new Error('The update service is unavailable.');
    } catch (error) {
      this.fail(error);
    }
    return this.state;
  }

  private async runDownload(): Promise<DesktopUpdateState> {
    // A click can arrive while a check is finishing in another window.
    if (this.pendingCheck) await this.pendingCheck;
    if (!this.state.version || !['available', 'error'].includes(this.state.status)) return this.state;
    this.set({ status: 'downloading', version: this.state.version, percent: 0 });
    try {
      await this.options.updater!.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.state;
  }

  private fail(error: unknown): void {
    const installing = this.state.status === 'installing';
    mainLog('error', 'desktop update failed', error);
    this.set({ status: 'error', version: this.state.version, error: 'The update could not be completed. Check your connection and try again.' });
    // The server has already shut down; reopen the installed version if its
    // installer fails so the user does not remain in a disconnected window.
    if (installing) this.options.recoverInstall();
  }

  private set(state: Omit<DesktopUpdateState, 'currentVersion'>): void {
    this.state = { currentVersion: this.options.version, ...state };
    this.options.broadcast(this.state);
  }
}
