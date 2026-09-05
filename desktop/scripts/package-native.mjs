import { cpSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Freeze exact installed native dependency trees; no pnpm symlinks enter releases. */
export function packageNativeModules(destination) {
  const copyPackage = (name, from, target, ancestry = new Set()) => {
    const require = createRequire(path.join(from, 'package.json'));
    let source = path.dirname(realpathSync(require.resolve(name)));
    let metadata;
    for (;;) {
      try {
        metadata = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
        if (metadata.name === name) break;
      } catch { /* The exported entrypoint may live in a nested directory. */ }
      const parent = path.dirname(source);
      if (parent === source) throw new Error(`Package metadata missing for ${name}`);
      source = parent;
    }
    if (metadata.os && !metadata.os.includes(process.platform)) return;
    if (metadata.cpu && !metadata.cpu.includes(process.arch)) return;
    if (metadata.libc && !metadata.libc.includes('glibc')) return;
    if (ancestry.has(source)) throw new Error(`Native dependency cycle at ${name}`);
    if (name === '@serialport/bindings-cpp') {
      // A prebuild would silently drop both our Bun poller and Windows USB fix.
      readFileSync(path.join(source, 'build/Release/bindings.node'));
    }
    const next = new Set(ancestry).add(source);
    const output = path.join(target, name);
    mkdirSync(path.dirname(output), { recursive: true });
    cpSync(source, output, { recursive: true, dereference: true, filter: (file) => {
      const relative = path.relative(source, file);
      const segments = relative.split(path.sep);
      if (name === '@serialport/bindings-cpp' && segments[0] === 'prebuilds') return false;
      if (segments[0] === 'build' && segments[1] && (segments[1] !== 'Release' || (segments[2] && !segments[2].endsWith('.node')))) return false;
      if (segments.some((part) => ['node_modules', '.git', 'test', 'tests'].includes(part))) return false;
      const prebuild = segments.indexOf('prebuilds');
      if (prebuild >= 0 && segments[prebuild + 1] && !segments[prebuild + 1].startsWith(`${process.platform}-${process.arch}`)) return false;
      return true;
    } });
    for (const dependency of Object.keys(metadata.dependencies ?? {})) copyPackage(dependency, source, path.join(output, 'node_modules'), next);
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
      try { copyPackage(dependency, source, path.join(output, 'node_modules'), next); }
      catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
    }
  };
  for (const name of ['serialport', '@napi-rs/keyring']) copyPackage(name, process.cwd(), destination);
}
