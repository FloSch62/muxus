import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// The "Open with" list on Linux, read straight from the freedesktop.org data
// files every desktop uses: Desktop Entry files for the programs,
// shared-mime-info for file types, and mimeapps.list for associations.

type Environment = Record<string, string | undefined>;

/** One program a file can be opened with. */
export interface DesktopApplication {
  /** Desktop file ID, e.g. `org.gnome.TextEditor.desktop`. */
  id: string;
  /** Absolute path of the .desktop file, for the `%k` field code. */
  file: string;
  name: string;
  exec: string;
  icon?: string;
  workingDirectory?: string;
  /** A program that must exist for the entry to count as installed. */
  tryExec?: string;
  /** NoDisplay: offered only where an association names it explicitly. */
  hidden?: boolean;
  mimeTypes: string[];
}

export interface ApplicationChoice {
  application: DesktopApplication;
  recommended: boolean;
  isDefault: boolean;
}

export interface MimeGlob {
  weight: number;
  mimeType: string;
  pattern: string;
  matches: (name: string) => boolean;
}

export interface MimeAppsList {
  defaults: Map<string, string[]>;
  added: Map<string, string[]>;
  removed: Map<string, string[]>;
}

export interface IconThemeIndex {
  inherits: string[];
  /** Folders of program icons, relative to the theme, best fit first. */
  directories: { path: string; score: number }[];
}

const MAX_DESKTOP_FILE_BYTES = 256 * 1024;
const MAX_APPLICATION_DIRECTORY_DEPTH = 3;
const CATALOG_TTL_MS = 60_000;
// The chooser draws icons at 24px; 48px stays sharp on HiDPI screens.
const ICON_SIZE = 48;
const SMALL_ICON_PENALTY = 2_000;
// Spec order ends with hicolor; the others cover icons a desktop's default
// theme provides when the user's theme could not be determined.
const FALLBACK_ICON_THEMES = ['hicolor', 'Adwaita', 'breeze'];

/** `de_DE.UTF-8@euro` → the Desktop Entry locale keys to try, most specific first. */
export function desktopLocaleKeys(locale: string | undefined): string[] {
  if (!locale || /^(C|POSIX)([.@]|$)/.test(locale)) return [];
  const match = /^([A-Za-z]+)(?:_([A-Za-z0-9]+))?(?:\.[^@]*)?(?:@(.+))?$/.exec(locale);
  if (!match) return [];
  const [, language, country, modifier] = match;
  const keys: string[] = [];
  if (country && modifier) keys.push(`${language}_${country}@${modifier}`);
  if (country) keys.push(`${language}_${country}`);
  if (modifier) keys.push(`${language}@${modifier}`);
  keys.push(language!);
  return keys;
}

/** Every group of a freedesktop key file; localized keys are kept as `Name[de]`. */
export function parseKeyFile(text: string): Map<string, Map<string, string>> {
  const groups = new Map<string, Map<string, string>>();
  let values: Map<string, string> | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const group = line.slice(1, -1);
      // A repeated group is a malformed file; the first one wins.
      values = groups.has(group) ? undefined : new Map();
      if (values) groups.set(group, values);
      continue;
    }
    if (!values) continue;
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim();
    if (!values.has(key)) values.set(key, line.slice(equals + 1).trim());
  }
  return groups;
}

export function parseKeyFileGroup(text: string, group: string): Map<string, string> {
  return parseKeyFile(text).get(group) ?? new Map();
}

/** Undo the escapes a Desktop Entry `string` value may contain. */
export function unescapeDesktopString(value: string): string {
  return value.replaceAll(/\\([sntr\\])/g, (_, code: string) =>
    code === 's' ? ' ' : code === 'n' ? '\n' : code === 't' ? '\t' : code === 'r' ? '\r' : '\\',
  );
}

/** Split a `;`-separated Desktop Entry list, honouring `\;`. */
export function desktopList(value: string | undefined): string[] {
  if (!value) return [];
  const items: string[] = [];
  let current = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === '\\' && value[index + 1] === ';') {
      current += ';';
      index++;
    } else if (char === ';') {
      items.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  items.push(current);
  return items.map((item) => unescapeDesktopString(item).trim()).filter(Boolean);
}

function localizedValue(
  values: Map<string, string>,
  key: string,
  localeKeys: readonly string[],
): string | undefined {
  for (const locale of localeKeys) {
    const value = values.get(`${key}[${locale}]`);
    if (value) return value;
  }
  return values.get(key);
}

/**
 * A program the chooser may offer, or undefined for entries that cannot
 * open a file: links, deleted entries, terminal programs, and entries meant
 * for other desktops. NoDisplay entries are kept but marked hidden, since
 * mimeapps.list may still name one as the default.
 */
export function desktopApplicationFromText(
  text: string,
  id: string,
  file: string,
  options: { localeKeys?: readonly string[]; currentDesktops?: readonly string[] } = {},
): DesktopApplication | undefined {
  const values = parseKeyFileGroup(text, 'Desktop Entry');
  if (values.get('Type') !== 'Application') return undefined;
  if (values.get('Hidden') === 'true') return undefined;
  // Muxus cannot know which terminal emulator to wrap these in.
  if (values.get('Terminal') === 'true') return undefined;
  const desktops = options.currentDesktops ?? [];
  const onlyShowIn = desktopList(values.get('OnlyShowIn'));
  if (onlyShowIn.length > 0 && !onlyShowIn.some((desktop) => desktops.includes(desktop))) {
    return undefined;
  }
  if (desktopList(values.get('NotShowIn')).some((desktop) => desktops.includes(desktop))) {
    return undefined;
  }
  const exec = unescapeDesktopString(values.get('Exec') ?? '');
  const name = unescapeDesktopString(localizedValue(values, 'Name', options.localeKeys ?? []) ?? '');
  if (!exec || !name) return undefined;
  const icon = unescapeDesktopString(localizedValue(values, 'Icon', options.localeKeys ?? []) ?? '');
  const workingDirectory = unescapeDesktopString(values.get('Path') ?? '');
  const tryExec = unescapeDesktopString(values.get('TryExec') ?? '');
  return {
    id,
    file,
    name,
    exec,
    ...(icon ? { icon } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(tryExec ? { tryExec } : {}),
    ...(values.get('NoDisplay') === 'true' ? { hidden: true } : {}),
    mimeTypes: desktopList(values.get('MimeType')),
  };
}

/** Split an (already unescaped) Exec value into arguments; undefined when it is malformed. */
export function splitExec(exec: string): string[] | undefined {
  const args: string[] = [];
  let current = '';
  let inArgument = false;
  let quoted = false;
  for (let index = 0; index < exec.length; index++) {
    const char = exec[index]!;
    if (quoted) {
      const next = exec[index + 1];
      if (char === '\\' && next !== undefined && '"`$\\'.includes(next)) {
        current += next;
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      inArgument = true;
    } else if (char === ' ' || char === '\t' || char === '\n') {
      if (inArgument) args.push(current);
      current = '';
      inArgument = false;
    } else if (char === '\\' && index + 1 < exec.length) {
      current += exec[++index];
      inArgument = true;
    } else {
      current += char;
      inArgument = true;
    }
  }
  if (quoted) return undefined;
  if (inArgument) args.push(current);
  return args.length > 0 ? args : undefined;
}

/**
 * The argument vector that opens `target` with `application`, following the
 * Exec field codes. Programs that take no file argument get it appended, as
 * an explicit "Open with" asks them to open this file.
 */
export function expandExec(
  application: Pick<DesktopApplication, 'exec' | 'name' | 'icon' | 'file'>,
  target: string,
): string[] | undefined {
  const args = splitExec(application.exec);
  if (!args) return undefined;
  const uri = pathToFileURL(target).href;
  let targetUsed = false;
  const expanded: string[] = [];
  for (const arg of args) {
    if (arg === '%f' || arg === '%F') {
      expanded.push(target);
      targetUsed = true;
      continue;
    }
    if (arg === '%u' || arg === '%U') {
      expanded.push(uri);
      targetUsed = true;
      continue;
    }
    if (arg === '%i') {
      if (application.icon) expanded.push('--icon', application.icon);
      continue;
    }
    // Deprecated codes expand to nothing; a lone one leaves no argument.
    if (/^%[dDnNvm]$/.test(arg)) continue;
    let value = '';
    for (let index = 0; index < arg.length; index++) {
      const char = arg[index];
      const code = arg[index + 1];
      if (char !== '%' || code === undefined) {
        value += char;
        continue;
      }
      index++;
      if (code === '%') value += '%';
      else if (code === 'f' || code === 'F') {
        value += target;
        targetUsed = true;
      } else if (code === 'u' || code === 'U') {
        value += uri;
        targetUsed = true;
      } else if (code === 'c') value += application.name;
      else if (code === 'k') value += application.file;
      else if (!'idDnNvm'.includes(code)) value += `%${code}`;
    }
    expanded.push(value);
  }
  if (!targetUsed) expanded.push(target);
  return expanded[0] ? expanded : undefined;
}

function globMatcher(pattern: string, caseSensitive: boolean): (name: string) => boolean {
  const normalize = (value: string) => (caseSensitive ? value : value.toLowerCase());
  const wanted = normalize(pattern);
  if (!/[*?[]/.test(pattern)) return (name) => normalize(name) === wanted;
  if (/^\*[^*?[]+$/.test(pattern)) {
    const suffix = wanted.slice(1);
    return (name) => normalize(name).endsWith(suffix);
  }
  let source = '';
  for (let index = 0; index < wanted.length; index++) {
    const char = wanted[index]!;
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else if (char === '[') {
      const close = wanted.indexOf(']', index + 2);
      if (close < 0) {
        source += '\\[';
        continue;
      }
      const body = wanted.slice(index + 1, close).replaceAll('\\', '\\\\');
      source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
      index = close;
    } else source += char.replaceAll(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try {
    const expression = new RegExp(`^${source}$`, 's');
    return (name) => expression.test(normalize(name));
  } catch {
    return () => false;
  }
}

/** shared-mime-info `globs2`: `weight:type:pattern[:flags]` per line. */
export function parseMimeGlobs(text: string): MimeGlob[] {
  const globs: MimeGlob[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const [weight, mimeType, pattern, flags] = line.split(':');
    const parsedWeight = Number(weight);
    if (!mimeType || !pattern || !Number.isFinite(parsedWeight)) continue;
    if (pattern === '__NOGLOBS__') continue;
    const caseSensitive = (flags ?? '').split(',').includes('cs');
    globs.push({ weight: parsedWeight, mimeType, pattern, matches: globMatcher(pattern, caseSensitive) });
  }
  return globs;
}

/** The file type a name implies: highest weight first, then the most specific pattern. */
export function mimeTypeForFileName(name: string, globs: readonly MimeGlob[]): string | undefined {
  let best: MimeGlob | undefined;
  for (const glob of globs) {
    if (!glob.matches(name)) continue;
    if (
      !best ||
      glob.weight > best.weight ||
      (glob.weight === best.weight && glob.pattern.length > best.pattern.length)
    ) {
      best = glob;
    }
  }
  return best?.mimeType;
}

/** shared-mime-info `subclasses` (`child parent`) or `aliases` (`alias type`) lines. */
export function parseMimePairs(text: string): Map<string, string[]> {
  const pairs = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const [left, right] = line.trim().split(/\s+/);
    if (!left || !right || left.startsWith('#')) continue;
    pairs.set(left, [...(pairs.get(left) ?? []), right]);
  }
  return pairs;
}

/** Broader types whose programs also handle `mimeType`, nearest first. */
export function mimeTypeAncestors(
  mimeType: string,
  subclasses: ReadonlyMap<string, readonly string[]>,
): string[] {
  const ancestors: string[] = [];
  const queue = [mimeType];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const parents = [...(subclasses.get(current) ?? [])];
    if (current.startsWith('text/') && current !== 'text/plain') parents.push('text/plain');
    for (const parent of parents) {
      if (parent === mimeType || ancestors.includes(parent)) continue;
      ancestors.push(parent);
      queue.push(parent);
    }
  }
  return ancestors;
}

/** One `mimeapps.list` (or legacy `defaults.list`) file. */
export function parseMimeAppsList(text: string): MimeAppsList {
  const read = (group: string) => {
    const entries = new Map<string, string[]>();
    for (const [mimeType, value] of parseKeyFileGroup(text, group)) {
      entries.set(mimeType, desktopList(value));
    }
    return entries;
  };
  return {
    defaults: read('Default Applications'),
    added: read('Added Associations'),
    removed: read('Removed Associations'),
  };
}

/**
 * Order every program for a file of `mimeType`: the desktop's default first,
 * then programs that declare the type (or a broader one), then the rest.
 */
export function rankApplications(
  applications: readonly DesktopApplication[],
  mimeType: string | undefined,
  subclasses: ReadonlyMap<string, readonly string[]>,
  aliases: ReadonlyMap<string, readonly string[]>,
  mimeApps: readonly MimeAppsList[],
): ApplicationChoice[] {
  const canonical = (type: string) => aliases.get(type)?.[0] ?? type;
  const byId = new Map(applications.map((application) => [application.id, application]));
  const types = mimeType ? [canonical(mimeType), ...mimeTypeAncestors(canonical(mimeType), subclasses)] : [];
  const removed = new Set<string>();
  const rankById = new Map<string, number>();
  const associated = new Set<string>();
  let defaultId: string | undefined;

  types.forEach((type, rank) => {
    removed.clear();
    for (const list of mimeApps) {
      for (const [listedType, ids] of list.removed) {
        if (canonical(listedType) === type) ids.forEach((id) => removed.add(id));
      }
    }
    const consider = (id: string, explicit: boolean) => {
      if (!byId.has(id) || removed.has(id)) return;
      if (explicit) associated.add(id);
      if (!rankById.has(id)) rankById.set(id, rank);
    };
    for (const list of mimeApps) {
      for (const [listedType, ids] of list.defaults) {
        if (canonical(listedType) !== type) continue;
        if (rank === 0 && !defaultId) defaultId = ids.find((id) => byId.has(id));
        ids.forEach((id) => consider(id, true));
      }
      for (const [listedType, ids] of list.added) {
        if (canonical(listedType) === type) ids.forEach((id) => consider(id, true));
      }
    }
    for (const application of applications) {
      if (application.mimeTypes.some((declared) => canonical(declared) === type)) {
        consider(application.id, false);
      }
    }
  });

  const byName = (left: DesktopApplication, right: DesktopApplication) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  return applications
    .filter((application) => !application.hidden || associated.has(application.id))
    .map((application) => ({
      application,
      recommended: rankById.has(application.id),
      isDefault: application.id === defaultId,
    }))
    .toSorted((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      if (left.recommended !== right.recommended) return left.recommended ? -1 : 1;
      if (left.recommended) {
        const rankDifference =
          rankById.get(left.application.id)! - rankById.get(right.application.id)!;
        if (rankDifference !== 0) return rankDifference;
      }
      return byName(left.application, right.application);
    });
}

async function readText(file: string, maxBytes = MAX_DESKTOP_FILE_BYTES): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > maxBytes) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Where a program name resolves on PATH, as the launcher would find it. */
export async function findProgram(program: string, environment: Environment): Promise<string | undefined> {
  if (program.includes('/')) {
    return path.isAbsolute(program) && (await isExecutable(program)) ? program : undefined;
  }
  for (const directory of (environment.PATH ?? '').split(':')) {
    if (!path.isAbsolute(directory)) continue;
    const candidate = path.join(directory, program);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function absolutePaths(value: string | undefined): string[] {
  return (value ?? '').split(':').filter((entry) => path.isAbsolute(entry));
}

/** XDG data directories, most important first. */
export function dataDirectories(environment: Environment, home: string): string[] {
  const dataHome = path.isAbsolute(environment.XDG_DATA_HOME ?? '')
    ? environment.XDG_DATA_HOME!
    : path.join(home, '.local', 'share');
  const dataDirs = absolutePaths(environment.XDG_DATA_DIRS);
  return [...new Set([dataHome, ...(dataDirs.length > 0 ? dataDirs : ['/usr/local/share', '/usr/share'])])];
}

function configDirectories(environment: Environment, home: string): string[] {
  const configHome = path.isAbsolute(environment.XDG_CONFIG_HOME ?? '')
    ? environment.XDG_CONFIG_HOME!
    : path.join(home, '.config');
  const configDirs = absolutePaths(environment.XDG_CONFIG_DIRS);
  return [...new Set([configHome, ...(configDirs.length > 0 ? configDirs : ['/etc/xdg'])])];
}

/** Desktops named by XDG_CURRENT_DESKTOP, as OnlyShowIn/NotShowIn compare them. */
export function currentDesktops(environment: Environment): string[] {
  const value = environment.ORIGINAL_XDG_CURRENT_DESKTOP || environment.XDG_CURRENT_DESKTOP;
  return (value ?? '').split(':').filter(Boolean);
}

async function desktopFiles(
  directory: string,
  prefix: string,
  depth: number,
  found: Map<string, string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_APPLICATION_DIRECTORY_DEPTH) {
        await desktopFiles(file, `${prefix}${entry.name}-`, depth + 1, found);
      }
    } else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith('.desktop')) {
      const id = `${prefix}${entry.name}`;
      // An earlier data directory shadows the same ID later on, even when
      // that earlier entry is Hidden — that is how users delete an entry.
      if (!found.has(id)) found.set(id, file);
    }
  }
}

function commaList(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

/** An icon theme's `index.theme`, keeping only its program icon folders. */
export function parseIconThemeIndex(text: string): IconThemeIndex {
  const groups = parseKeyFile(text);
  const theme = groups.get('Icon Theme') ?? new Map<string, string>();
  const names = [
    ...new Set([...commaList(theme.get('Directories')), ...commaList(theme.get('ScaledDirectories'))]),
  ];
  const directories: IconThemeIndex['directories'] = [];
  for (const name of names) {
    const group = groups.get(name);
    if (!group) continue;
    const context = group.get('Context');
    const programs = context
      ? context === 'Applications' || context === 'Apps'
      : /(^|\/)apps(\/|$)/.test(name);
    if (!programs) continue;
    const size = Number(group.get('Size')) * Number(group.get('Scale') ?? 1);
    if (!Number.isFinite(size) || size <= 0) continue;
    // Exact fits first, then a vector, then larger icons (they scale down
    // cleanly), and smaller ones only when nothing else exists.
    const score =
      group.get('Type') === 'Scalable'
        ? 0.5
        : size >= ICON_SIZE
          ? size - ICON_SIZE
          : SMALL_ICON_PENALTY + ICON_SIZE - size;
    directories.push({ path: name, score });
  }
  return {
    inherits: commaList(theme.get('Inherits')),
    directories: directories.toSorted((left, right) => left.score - right.score),
  };
}

/** The icon theme the desktop is using, as far as it can be told without a toolkit. */
export async function detectIconTheme(environment: Environment, home: string): Promise<string | undefined> {
  const configHome = configDirectories(environment, home)[0]!;
  if (currentDesktops(environment).includes('KDE')) {
    const kde = await readText(path.join(configHome, 'kdeglobals'));
    return (kde ? parseKeyFile(kde).get('Icons')?.get('Theme') : undefined) || 'breeze';
  }
  const fromSettings = await new Promise<string | undefined>((resolve) => {
    execFile(
      'gsettings',
      ['get', 'org.gnome.desktop.interface', 'icon-theme'],
      { env: environment, timeout: 2_000 },
      (error, stdout) => resolve(error ? undefined : stdout.trim().replace(/^'(.*)'$/, '$1') || undefined),
    );
  });
  if (fromSettings) return fromSettings;
  const gtk = await readText(path.join(configHome, 'gtk-3.0', 'settings.ini'));
  return (gtk ? parseKeyFile(gtk).get('Settings')?.get('gtk-icon-theme-name') : undefined) || undefined;
}

/**
 * The installed programs and file-type data, read once and reused for a
 * minute so reopening the chooser stays instant.
 */
export class LinuxApplicationCatalog {
  private loaded?: Promise<{
    applications: DesktopApplication[];
    globs: MimeGlob[];
    subclasses: Map<string, string[]>;
    aliases: Map<string, string[]>;
    mimeApps: MimeAppsList[];
    icons: Map<string, string>;
  }>;
  private loadedAt = 0;

  constructor(
    private readonly environment: Environment,
    private readonly home: string,
    private readonly options: {
      iconTheme?: () => Promise<string | undefined>;
      now?: () => number;
    } = {},
  ) {}

  /** Every program, ranked for a file called `fileName`. */
  async applicationsFor(fileName: string): Promise<{ mimeType?: string; choices: ApplicationChoice[] }> {
    const catalog = await this.load();
    const mimeType = mimeTypeForFileName(fileName, catalog.globs);
    return {
      ...(mimeType ? { mimeType } : {}),
      choices: rankApplications(
        catalog.applications,
        mimeType,
        catalog.subclasses,
        catalog.aliases,
        catalog.mimeApps,
      ),
    };
  }

  async find(id: string): Promise<DesktopApplication | undefined> {
    return (await this.load()).applications.find((application) => application.id === id);
  }

  /** The PNG or SVG file of the program's icon, when one was found. */
  async iconFile(application: DesktopApplication): Promise<string | undefined> {
    const icon = application.icon;
    if (!icon) return undefined;
    if (path.isAbsolute(icon)) return /\.(png|svg)$/.test(icon) ? icon : undefined;
    return (await this.load()).icons.get(icon.replace(/\.(png|svg|xpm)$/, ''));
  }

  private load() {
    const now = this.options.now?.() ?? Date.now();
    if (!this.loaded || now - this.loadedAt > CATALOG_TTL_MS) {
      this.loadedAt = now;
      this.loaded = this.read();
      this.loaded.catch(() => {
        this.loaded = undefined;
      });
    }
    return this.loaded;
  }

  private async read() {
    const dataDirs = dataDirectories(this.environment, this.home);
    const desktops = currentDesktops(this.environment);
    const localeKeys = desktopLocaleKeys(
      this.environment.LC_ALL || this.environment.LC_MESSAGES || this.environment.LANG,
    );

    const files = new Map<string, string>();
    for (const directory of dataDirs) {
      await desktopFiles(path.join(directory, 'applications'), '', 0, files);
    }
    const programs = new Map<string, Promise<string | undefined>>();
    const resolve = (program: string) => {
      let found = programs.get(program);
      if (!found) {
        found = findProgram(program, this.environment);
        programs.set(program, found);
      }
      return found;
    };
    const applications = (
      await Promise.all(
        [...files].map(async ([id, file]) => {
          const text = await readText(file);
          if (text === undefined) return undefined;
          const application = desktopApplicationFromText(text, id, file, {
            localeKeys,
            currentDesktops: desktops,
          });
          if (!application) return undefined;
          // Leftovers of uninstalled programs name a binary that is gone.
          if (application.tryExec && !(await resolve(application.tryExec))) return undefined;
          const program = splitExec(application.exec)?.[0];
          if (!program || !(await resolve(program))) return undefined;
          return application;
        }),
      )
    ).filter((application): application is DesktopApplication => !!application);

    const mimeDirs = dataDirs.map((directory) => path.join(directory, 'mime'));
    const globs = (
      await Promise.all(mimeDirs.map((directory) => readText(path.join(directory, 'globs2'), 4 * 1024 * 1024)))
    ).flatMap((text) => (text ? parseMimeGlobs(text) : []));
    const mergePairs = async (name: string) => {
      const merged = new Map<string, string[]>();
      for (const directory of mimeDirs) {
        const text = await readText(path.join(directory, name), 4 * 1024 * 1024);
        if (!text) continue;
        for (const [key, values] of parseMimePairs(text)) {
          if (!merged.has(key)) merged.set(key, values);
        }
      }
      return merged;
    };

    const desktopPrefixes = desktops.map((desktop) => `${desktop.toLowerCase()}-`);
    const listFiles = [
      ...configDirectories(this.environment, this.home),
      ...dataDirs.map((directory) => path.join(directory, 'applications')),
    ].flatMap((directory) => [
      ...desktopPrefixes.map((prefix) => path.join(directory, `${prefix}mimeapps.list`)),
      path.join(directory, 'mimeapps.list'),
    ]);
    // The legacy defaults.list only ever supplies defaults, after everything else.
    listFiles.push(
      ...dataDirs.map((directory) => path.join(directory, 'applications', 'defaults.list')),
    );
    const mimeApps = (await Promise.all(listFiles.map((file) => readText(file)))).flatMap((text) =>
      text ? [parseMimeAppsList(text)] : [],
    );

    return {
      applications,
      globs,
      subclasses: await mergePairs('subclasses'),
      aliases: await mergePairs('aliases'),
      mimeApps,
      icons: await this.iconIndex(dataDirs),
    };
  }

  /** Icon name → best file, searching the user's theme, what it inherits, then hicolor. */
  private async iconIndex(dataDirs: readonly string[]): Promise<Map<string, string>> {
    const bases = [path.join(this.home, '.icons'), ...dataDirs.map((directory) => path.join(directory, 'icons'))];
    const themes: { name: string; index: IconThemeIndex }[] = [];
    const visit = async (name: string) => {
      if (themes.some((theme) => theme.name === name)) return;
      for (const base of bases) {
        const text = await readText(path.join(base, name, 'index.theme'), 1024 * 1024);
        if (!text) continue;
        const index = parseIconThemeIndex(text);
        themes.push({ name, index });
        for (const parent of index.inherits) {
          if (parent !== 'hicolor') await visit(parent);
        }
        return;
      }
    };
    const preferred = await this.options.iconTheme?.().catch(() => undefined);
    if (preferred && preferred !== 'hicolor') await visit(preferred);
    for (const fallback of FALLBACK_ICON_THEMES) await visit(fallback);

    const index = new Map<string, { file: string; rank: number }>();
    const consider = (name: string, file: string, rank: number) => {
      const current = index.get(name);
      if (!current || rank < current.rank) index.set(name, { file, rank });
    };
    // Theme order first, then the folder's fit, then PNG over SVG; an earlier
    // base breaks a tie, so icons the user installed win over the system's.
    await Promise.all(
      themes.flatMap(({ name: theme, index: themeIndex }, themeRank) =>
        themeIndex.directories.flatMap(({ path: directory, score }) =>
          bases.map(async (base, baseRank) => {
            let names: string[];
            try {
              names = await readdir(path.join(base, theme, directory));
            } catch {
              return;
            }
            for (const name of names) {
              const extension = path.extname(name);
              if (extension !== '.png' && extension !== '.svg') continue;
              const fit = themeRank * 10_000 + Math.round(score * 2);
              const quality = fit * 2 + (extension === '.png' ? 0 : 1);
              consider(
                name.slice(0, -extension.length),
                path.join(base, theme, directory, name),
                quality * bases.length + baseRank,
              );
            }
          }),
        ),
      ),
    );
    const pixmapRank = Number.MAX_SAFE_INTEGER;
    for (const directory of dataDirs) {
      let names: string[];
      try {
        names = await readdir(path.join(directory, 'pixmaps'));
      } catch {
        continue;
      }
      for (const name of names) {
        const extension = path.extname(name);
        if (extension !== '.png' && extension !== '.svg') continue;
        consider(name.slice(0, -extension.length), path.join(directory, 'pixmaps', name), pixmapRank);
      }
    }
    return new Map([...index].map(([name, { file }]) => [name, file]));
  }
}
