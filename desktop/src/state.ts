import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export class ClientState {
  private values: Record<string, string> = {};
  private timer?: ReturnType<typeof setTimeout>;
  private dirty = false;

  constructor(private file: string, private onError: (error: unknown) => void) {
    try {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.values = Object.fromEntries(Object.entries(value).filter((entry) => typeof entry[1] === 'string'));
      }
    } catch { /* First launch or corrupt state. */ }
  }

  snapshot(): Record<string, string> { return { ...this.values }; }

  change(name: string, value: string | null): void {
    if (typeof name !== 'string' || (value !== null && typeof value !== 'string')) return;
    // Define a data property even for keys such as __proto__.
    if (value === null) delete this.values[name];
    else Object.defineProperty(this.values, name, { value, enumerable: true, configurable: true, writable: true });
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), 150);
  }

  flush(retry = true): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.file}.tmp`, `${JSON.stringify(this.values)}\n`, { mode: 0o600 });
      renameSync(`${this.file}.tmp`, this.file);
      this.dirty = false;
    } catch (error) {
      this.onError(error);
      if (retry) this.timer = setTimeout(() => this.flush(), 5000);
    }
  }
}
