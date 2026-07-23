import fs from 'node:fs';
import path from 'node:path';
import type { ConfigForward, HostUpsertRequest } from '@muxus/shared';
import { HttpProblem } from '../util/errors.js';
import {
  defaultSshConfigPath,
  isConcreteAlias,
  loadConfigDocument,
  type ConfigDocument,
  type HostBlock,
} from './ssh-config.js';

/**
 * Editing side of the ssh_config engine: serialize a Host block from the
 * editor's DTO and splice it into the user's config files, touching nothing
 * but the edited block's lines. Every write is atomic (tmp + rename), keeps
 * the file's mode, and leaves a `.muxus.bak` copy of the previous content.
 */

const ALIAS_RE = /^[^\s#*?!]+$/;
const KEYWORD_RE = /^[A-Za-z][A-Za-z0-9]*$/;
/** Keywords that would change the file's structure if smuggled in via extras. */
const FORBIDDEN_EXTRAS = new Set(['host', 'match']);

export interface UpsertResult {
  file: string;
}

export function findHostBlock(doc: ConfigDocument, alias: string): HostBlock | undefined {
  return doc.blocks.find((b) => b.patterns.some((p) => isConcreteAlias(p) && p === alias));
}

export function upsertHost(req: HostUpsertRequest, rootPath = defaultSshConfigPath()): UpsertResult {
  validateUpsert(req);
  const doc = loadConfigDocument(rootPath);

  let block: HostBlock | undefined;
  if (req.previousAlias) {
    block = findHostBlock(doc, req.previousAlias);
    if (!block) throw new HttpProblem(404, `no Host block for "${req.previousAlias}" in ${path.basename(doc.rootPath)}`);
  }
  for (const alias of req.aliases) {
    const other = findHostBlock(doc, alias);
    if (other && other !== block) {
      throw new HttpProblem(409, `Host "${alias}" already exists in ${path.basename(other.file)}`, 'host-exists');
    }
  }

  const targetFile = resolveTargetFile(req.file ?? block?.file ?? doc.rootPath, doc.rootPath);
  // Wildcard/negation patterns sharing the edited block's Host line survive edits.
  const extraPatterns = block ? block.patterns.filter((p) => !isConcreteAlias(p)) : [];
  const rendered = renderHostBlock(req, detectIndent(doc, targetFile), extraPatterns);

  const changed = new Set<string>();
  if (block && block.file === targetFile) {
    const lines = doc.files.get(block.file) ?? [];
    lines.splice(block.commentStart, block.end - block.commentStart, ...rendered);
    doc.files.set(block.file, lines);
    changed.add(block.file);
  } else {
    if (block) {
      removeBlock(doc, block);
      changed.add(block.file);
    }
    appendBlock(doc, targetFile, rendered);
    changed.add(targetFile);
    if (ensureIncluded(doc, targetFile)) changed.add(doc.rootPath);
  }

  for (const file of changed) writeConfigFile(file, doc.files.get(file) ?? []);
  return { file: targetFile };
}

export function deleteHost(alias: string, rootPath = defaultSshConfigPath()): void {
  const doc = loadConfigDocument(rootPath);
  const block = findHostBlock(doc, alias);
  if (!block) throw new HttpProblem(404, `no Host block for "${alias}"`);
  removeBlock(doc, block);
  writeConfigFile(block.file, doc.files.get(block.file) ?? []);
}

/** The exact text upsertHost would write, for the editor's live preview. */
export function previewHost(req: HostUpsertRequest, rootPath = defaultSshConfigPath()): string {
  validateUpsert(req);
  const doc = loadConfigDocument(rootPath);
  const block = req.previousAlias ? findHostBlock(doc, req.previousAlias) : undefined;
  const targetFile = resolveTargetFile(req.file ?? block?.file ?? doc.rootPath, doc.rootPath);
  const extraPatterns = block ? block.patterns.filter((p) => !isConcreteAlias(p)) : [];
  return renderHostBlock(req, detectIndent(doc, targetFile), extraPatterns).join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function bad(message: string): never {
  throw new HttpProblem(400, message);
}

function validateUpsert(req: HostUpsertRequest): void {
  if (!req.aliases.length) bad('at least one alias is required');
  for (const alias of req.aliases) {
    if (!ALIAS_RE.test(alias)) bad(`invalid alias "${alias}" — no spaces, wildcards or "!"`);
  }
  const o = req.options;
  for (const v of [o.hostname, o.user, ...(o.identityFiles ?? [])]) {
    // These are re-quoted as single tokens on render, so quotes can't nest.
    if (v !== undefined && (!v.trim() || /[\r\n"]/.test(v))) bad('option values must be non-empty single-line text without quotes');
  }
  if (o.port !== undefined && !(Number.isInteger(o.port) && o.port > 0 && o.port < 65536)) bad('port must be 1–65535');
  for (const hop of o.proxyJump ?? []) {
    if (!hop.trim() || /[\s,]/.test(hop)) bad(`invalid jump host "${hop}"`);
  }
  for (const f of o.forwards ?? []) validateForward(f);
  for (const extra of o.extras ?? []) {
    if (!KEYWORD_RE.test(extra.keyword) || FORBIDDEN_EXTRAS.has(extra.keyword.toLowerCase())) bad(`invalid option keyword "${extra.keyword}"`);
    // Extras are written verbatim (they may carry their own quoting) — only newlines are off-limits.
    if (/[\r\n]/.test(extra.value)) bad(`invalid value for ${extra.keyword}`);
  }
}

function validateForward(f: ConfigForward): void {
  const portOk = (p: unknown): p is number => Number.isInteger(p) && (p as number) > 0 && (p as number) < 65536;
  if (!portOk(f.bindPort)) bad('forward listen port must be 1–65535');
  if (f.type === 'dynamic') return;
  if (!f.targetHost?.trim() || /\s/.test(f.targetHost)) bad('forward target host is required');
  if (!portOk(f.targetPort)) bad('forward target port must be 1–65535');
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Quote one token when it contains whitespace. Never applied to multi-arg values. */
function quoteToken(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

function forwardTarget(host: string, port: number): string {
  return `${host.includes(':') ? `[${host}]` : host}:${port}`;
}

export function renderHostBlock(req: HostUpsertRequest, indent: string, extraPatterns: string[] = []): string[] {
  const lines: string[] = [];
  const description = (req.description ?? '').replace(/\r/g, '').trim();
  if (description) {
    for (const line of description.split('\n')) lines.push(line.trim() ? `# ${line.trim()}` : '#');
  }
  lines.push(`Host ${[...req.aliases, ...extraPatterns].join(' ')}`);
  const opt = (keyword: string, value: string | undefined) => {
    if (value !== undefined && value !== '') lines.push(`${indent}${keyword} ${value}`);
  };
  const singleToken = (v: string | undefined) => (v === undefined ? undefined : quoteToken(v.trim()));

  const o = req.options;
  opt('HostName', singleToken(o.hostname));
  opt('User', singleToken(o.user));
  opt('Port', o.port?.toString());
  for (const file of o.identityFiles ?? []) opt('IdentityFile', singleToken(file));
  if (o.identitiesOnly !== undefined) opt('IdentitiesOnly', o.identitiesOnly ? 'yes' : 'no');
  if (o.proxyJump !== undefined) opt('ProxyJump', o.proxyJump.length ? o.proxyJump.join(',') : 'none');
  if (o.forwardAgent !== undefined) opt('ForwardAgent', o.forwardAgent ? 'yes' : 'no');
  if (o.passwordOnly) {
    opt('PubkeyAuthentication', 'no');
    opt('PreferredAuthentications', 'keyboard-interactive,password');
  }
  for (const f of o.forwards ?? []) {
    if (f.type === 'dynamic') opt('DynamicForward', String(f.bindPort));
    else opt(f.type === 'local' ? 'LocalForward' : 'RemoteForward', `${f.bindPort} ${forwardTarget(f.targetHost!, f.targetPort!)}`);
  }
  for (const extra of o.extras ?? []) opt(extra.keyword, extra.value.trim());
  return lines;
}

/** Match the file's existing option indentation; default to two spaces. */
function detectIndent(doc: ConfigDocument, file: string): string {
  for (const line of doc.files.get(file) ?? []) {
    const m = /^([ \t]+)\S/.exec(line);
    if (m) return m[1] ?? '  ';
  }
  return '  ';
}

// ---------------------------------------------------------------------------
// File surgery
// ---------------------------------------------------------------------------

/** Config edits stay inside the root config's directory (normally ~/.ssh). */
function resolveTargetFile(file: string, rootPath: string): string {
  const resolved = path.resolve(file);
  const rel = path.relative(path.dirname(rootPath), resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new HttpProblem(400, `config files must live under ${path.dirname(rootPath)}`);
  }
  return resolved;
}

function removeBlock(doc: ConfigDocument, block: HostBlock): void {
  const lines = doc.files.get(block.file) ?? [];
  lines.splice(block.commentStart, block.end - block.commentStart);
  // Collapse the blank seam the removal leaves behind.
  if ((lines[block.commentStart] ?? '').trim() === '' && (block.commentStart === 0 || (lines[block.commentStart - 1] ?? '').trim() === '')) {
    lines.splice(block.commentStart, 1);
  }
  while (lines.length && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
  doc.files.set(block.file, lines);
}

function appendBlock(doc: ConfigDocument, file: string, rendered: string[]): void {
  const lines = doc.files.get(file) ?? [];
  if (lines.length && (lines[lines.length - 1] ?? '').trim() !== '') lines.push('');
  lines.push(...rendered);
  doc.files.set(file, lines);
}

/** Reachable-from-root check; adds an Include to the root config when needed. */
function ensureIncluded(doc: ConfigDocument, targetFile: string): boolean {
  if (targetFile === doc.rootPath || doc.fileOrder.includes(targetFile)) return false;
  const rootLines = doc.files.get(doc.rootPath) ?? [];
  const rel = path.relative(path.dirname(doc.rootPath), targetFile);
  // Insert before the first directive (appending could land inside the last
  // Host block, where Include has per-block semantics). Top placement is the
  // conventional spot for Includes in per-user configs.
  let at = 0;
  while (at < rootLines.length && ((rootLines[at] ?? '').trim() === '' || (rootLines[at] ?? '').trim().startsWith('#'))) at++;
  rootLines.splice(at, 0, `Include ${rel}`, '');
  doc.files.set(doc.rootPath, rootLines);
  return true;
}

function writeConfigFile(filePath: string, lines: string[]): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
    fs.copyFileSync(filePath, `${filePath}.muxus.bak`);
    fs.chmodSync(`${filePath}.muxus.bak`, 0o600);
  } catch {
    // New file — nothing to back up.
  }
  const tmp = `${filePath}.muxus.tmp`;
  fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', { mode });
  fs.renameSync(tmp, filePath);
}
