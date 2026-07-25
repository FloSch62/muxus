export type FileIconKind =
  | 'archive'
  | 'audio'
  | 'binary'
  | 'build'
  | 'c'
  | 'certificate'
  | 'code'
  | 'config'
  | 'cpp'
  | 'csharp'
  | 'css'
  | 'csv'
  | 'database'
  | 'docker'
  | 'env'
  | 'font'
  | 'git'
  | 'go'
  | 'graphql'
  | 'html'
  | 'image'
  | 'java'
  | 'javascript'
  | 'json'
  | 'key'
  | 'kotlin'
  | 'license'
  | 'lock'
  | 'log'
  | 'markdown'
  | 'npm'
  | 'pdf'
  | 'php'
  | 'pnpm'
  | 'powershell'
  | 'proto'
  | 'python'
  | 'react'
  | 'ruby'
  | 'rust'
  | 'sass'
  | 'shell'
  | 'sql'
  | 'svelte'
  | 'swift'
  | 'terraform'
  | 'text'
  | 'toml'
  | 'typescript'
  | 'video'
  | 'vue'
  | 'xml'
  | 'yaml'
  | 'yarn'
  | 'file';

export type FolderIconKind =
  | 'assets'
  | 'build'
  | 'cloud'
  | 'config'
  | 'database'
  | 'dependencies'
  | 'docker'
  | 'docs'
  | 'git'
  | 'public'
  | 'scripts'
  | 'secure'
  | 'source'
  | 'tests'
  | 'folder';

const EXACT_FILE_ICONS: Readonly<Record<string, FileIconKind>> = {
  '.babelrc': 'javascript',
  '.dockerignore': 'docker',
  '.editorconfig': 'config',
  '.eslintignore': 'config',
  '.eslintrc': 'javascript',
  '.gitattributes': 'git',
  '.gitconfig': 'git',
  '.gitignore': 'git',
  '.gitmodules': 'git',
  '.npmrc': 'npm',
  '.nvmrc': 'javascript',
  '.prettierignore': 'config',
  '.prettierrc': 'config',
  '.profile': 'shell',
  '.python-version': 'python',
  '.ruby-version': 'ruby',
  '.tool-versions': 'config',
  '.yarnrc': 'yarn',
  '.zshrc': 'shell',
  'bun.lock': 'lock',
  'bun.lockb': 'lock',
  'cargo.lock': 'lock',
  'cargo.toml': 'rust',
  'composer.json': 'php',
  'composer.lock': 'lock',
  'containerfile': 'docker',
  'copying': 'license',
  'dockerfile': 'docker',
  'gemfile': 'ruby',
  'gemfile.lock': 'lock',
  'go.mod': 'go',
  'go.sum': 'lock',
  'gradle.properties': 'java',
  'gradlew': 'build',
  'gradlew.bat': 'build',
  'justfile': 'build',
  'license': 'license',
  'makefile': 'build',
  'package-lock.json': 'npm',
  'package.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  'poetry.lock': 'lock',
  'pyproject.toml': 'python',
  'readme': 'markdown',
  'requirements.txt': 'python',
  'tsconfig.json': 'typescript',
  'vite.config.js': 'javascript',
  'vite.config.mjs': 'javascript',
  'vite.config.ts': 'typescript',
  'webpack.config.js': 'javascript',
  'webpack.config.ts': 'typescript',
  'yarn.lock': 'yarn',
};

const EXTENSION_FILE_ICONS: Readonly<Record<string, FileIconKind>> = {
  '7z': 'archive',
  aac: 'audio',
  apk: 'binary',
  avi: 'video',
  bat: 'powershell',
  bin: 'binary',
  bmp: 'image',
  bz2: 'archive',
  c: 'c',
  cc: 'cpp',
  cer: 'certificate',
  cert: 'certificate',
  cjs: 'javascript',
  class: 'binary',
  cmd: 'powershell',
  conf: 'config',
  cpp: 'cpp',
  crt: 'certificate',
  cs: 'csharp',
  css: 'css',
  csv: 'csv',
  cts: 'typescript',
  cxx: 'cpp',
  dart: 'code',
  db: 'database',
  deb: 'binary',
  der: 'certificate',
  dll: 'binary',
  dmg: 'binary',
  doc: 'text',
  docx: 'text',
  eot: 'font',
  env: 'env',
  exe: 'binary',
  flac: 'audio',
  gif: 'image',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  gz: 'archive',
  h: 'c',
  hpp: 'cpp',
  htm: 'html',
  html: 'html',
  ico: 'image',
  ini: 'config',
  jar: 'archive',
  java: 'java',
  jpeg: 'image',
  jpg: 'image',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'react',
  key: 'key',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'css',
  lock: 'lock',
  log: 'log',
  lua: 'code',
  m4a: 'audio',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'react',
  mjs: 'javascript',
  mkv: 'video',
  mov: 'video',
  mp3: 'audio',
  mp4: 'video',
  mpeg: 'video',
  mpg: 'video',
  mts: 'typescript',
  odt: 'text',
  ogg: 'audio',
  otf: 'font',
  pdf: 'pdf',
  pem: 'certificate',
  php: 'php',
  png: 'image',
  ppt: 'text',
  pptx: 'text',
  proto: 'proto',
  ps1: 'powershell',
  psd1: 'powershell',
  psm1: 'powershell',
  py: 'python',
  pyc: 'binary',
  rar: 'archive',
  rb: 'ruby',
  rpm: 'binary',
  rs: 'rust',
  sass: 'sass',
  scss: 'sass',
  sh: 'shell',
  so: 'binary',
  sql: 'sql',
  sqlite: 'database',
  sqlite3: 'database',
  svg: 'image',
  swift: 'swift',
  tar: 'archive',
  tf: 'terraform',
  tfstate: 'terraform',
  tfvars: 'terraform',
  tgz: 'archive',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'react',
  ttf: 'font',
  txt: 'text',
  vue: 'vue',
  wav: 'audio',
  webm: 'video',
  webp: 'image',
  woff: 'font',
  woff2: 'font',
  xls: 'csv',
  xlsx: 'csv',
  xml: 'xml',
  xz: 'archive',
  yaml: 'yaml',
  yml: 'yaml',
  zip: 'archive',
};

const FOLDER_ICONS: Readonly<Record<string, FolderIconKind>> = {
  '.aws': 'cloud',
  '.config': 'config',
  '.devcontainer': 'docker',
  '.git': 'git',
  '.github': 'git',
  '.gitlab': 'git',
  '.kube': 'cloud',
  '.ssh': 'secure',
  '.vscode': 'config',
  '__tests__': 'tests',
  api: 'source',
  app: 'source',
  assets: 'assets',
  bin: 'scripts',
  build: 'build',
  config: 'config',
  coverage: 'tests',
  database: 'database',
  db: 'database',
  dist: 'build',
  docker: 'docker',
  docs: 'docs',
  fixtures: 'tests',
  fonts: 'assets',
  images: 'assets',
  lib: 'source',
  migrations: 'database',
  node_modules: 'dependencies',
  packages: 'dependencies',
  public: 'public',
  scripts: 'scripts',
  server: 'source',
  src: 'source',
  static: 'public',
  styles: 'assets',
  test: 'tests',
  tests: 'tests',
  vendor: 'dependencies',
  web: 'public',
};

// Remote listings re-render on every navigation, selection, and transfer
// tick, and a name always resolves to the same icon.
const RESOLVED_FILE_ICONS = new Map<string, FileIconKind>();
const FILE_ICON_CACHE_LIMIT = 4_000;

/** Resolve a filename without touching file contents, suitable for large remote listings. */
export function fileIconKind(name: string): FileIconKind {
  const cached = RESOLVED_FILE_ICONS.get(name);
  if (cached !== undefined) return cached;
  const kind = resolveFileIconKind(name);
  if (RESOLVED_FILE_ICONS.size >= FILE_ICON_CACHE_LIMIT) RESOLVED_FILE_ICONS.clear();
  RESOLVED_FILE_ICONS.set(name, kind);
  return kind;
}

function resolveFileIconKind(name: string): FileIconKind {
  const lowerName = name.toLowerCase();

  if (/^\.env(?:\.|$)/.test(lowerName)) return 'env';
  if (lowerName.startsWith('docker-compose.') || lowerName.startsWith('compose.')) return 'docker';
  if (lowerName.startsWith('readme.')) return 'markdown';
  if (/^(?:licen[cs]e|copying)(?:\.|$)/.test(lowerName)) return 'license';
  if (/^(?:eslint|prettier|stylelint|tailwind|postcss)\.config\./.test(lowerName)) return 'config';
  if (/^(?:tsconfig|jsconfig)(?:\.[^.]+)*\.json$/.test(lowerName)) return 'typescript';

  const exact = EXACT_FILE_ICONS[lowerName];
  if (exact) return exact;

  const extensionIndex = lowerName.lastIndexOf('.');
  if (extensionIndex === -1 || extensionIndex === lowerName.length - 1) return 'file';
  return EXTENSION_FILE_ICONS[lowerName.slice(extensionIndex + 1)] ?? 'file';
}

/** Resolve familiar developer folder names to a stable visual category. */
export function folderIconKind(name: string): FolderIconKind {
  return FOLDER_ICONS[name.toLowerCase()] ?? 'folder';
}
