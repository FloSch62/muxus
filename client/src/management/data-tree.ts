import {
  formatGnmiElem,
  formatGnmiPath,
  stripModulePrefix,
  type GnmiPath,
  type GnmiPathElem,
} from '@muxus/shared';

/**
 * One tree for everything a device returns: gNMI notifications (paths plus
 * JSON values) and NETCONF <data> (XML) both land here, so the explorer,
 * the result views and "copy path" work the same for either protocol.
 *
 * YANG list keys are not in the data itself. They are learned from keyed
 * paths the device sends (subscriptions, keyed requests) and otherwise
 * guessed from the entries' leaves.
 */

export type DataNodeKind = 'root' | 'container' | 'list' | 'entry' | 'leaf' | 'leaf-list';

export interface DataNode {
  /** Unique within its tree: the node's path with module prefixes dropped. */
  id: string;
  /** Element name as the device wrote it (module-qualified when it was). */
  name: string;
  kind: DataNodeKind;
  path: GnmiPath;
  /** List entries: their key leaves. */
  keys?: Record<string, string>;
  /** The keys were guessed from the leaves rather than learned from the device. */
  guessedKeys?: boolean;
  /** Leaves and leaf-lists. */
  value?: unknown;
  /** XML namespace of the element (NETCONF). */
  namespace?: string;
  children: DataNode[];
  /** Explorer: children have been fetched from the device. */
  loaded?: boolean;
}

/** The well-known key leaf names, in the order a guess prefers them. */
const KEY_NAMES = [
  'name',
  'index',
  'id',
  'key',
  'sequence-id',
  'sequence',
  'ip-prefix',
  'prefix',
  'address',
  'ip-address',
  'neighbor-address',
  'peer-address',
  'interface-name',
  'interface',
  'vlan-id',
  'mac-address',
  'mac',
  'type',
  'priority',
  'number',
  'identifier',
];

/** Key leaf names per schema path (`/interface/subinterface`), learned from keyed paths. */
export class KeyRegistry {
  private readonly keys = new Map<string, string[]>();

  learn(path: GnmiPath): void {
    let schema = '';
    for (const elem of path.elems) {
      schema += `/${stripModulePrefix(elem.name)}`;
      if (elem.keys && Object.keys(elem.keys).length) this.keys.set(schema, Object.keys(elem.keys));
    }
  }

  lookup(schemaPath: string): string[] | undefined {
    return this.keys.get(schemaPath);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(scalarText).join(',');
  return String(value);
}

/** Key leaves that tell `entries` apart, preferring well-known key names. */
export function guessListKeys(entries: readonly Record<string, unknown>[]): string[] {
  if (entries.length === 0) return [];
  const scalarFields = Object.keys(entries[0]!).filter((field) =>
    entries.every((entry) => field in entry && isScalar(entry[field])),
  );
  const unique = (fields: string[]) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const signature = fields.map((field) => scalarText(entry[field])).join('\u0000');
      if (seen.has(signature)) return false;
      seen.add(signature);
    }
    return true;
  };
  const byPreference = (field: string) => {
    const index = KEY_NAMES.indexOf(stripModulePrefix(field));
    return index < 0 ? KEY_NAMES.length : index;
  };
  const preferred = scalarFields
    .filter((field) => byPreference(field) < KEY_NAMES.length)
    .sort((a, b) => byPreference(a) - byPreference(b));
  // The most key-like leaf is most likely (part of) the key: prefer it alone,
  // then paired with another, before settling for a less key-like leaf.
  const [first, ...rest] = preferred;
  if (first !== undefined) {
    if (unique([first])) return [first];
    for (const second of rest) if (unique([first, second])) return [first, second];
  }
  for (const field of rest) if (unique([field])) return [field];
  for (let i = 0; i < rest.length; i++) {
    for (let j = i + 1; j < rest.length; j++) {
      if (unique([rest[i]!, rest[j]!])) return [rest[i]!, rest[j]!];
    }
  }
  for (const field of scalarFields) if (unique([field])) return [field];
  // A single entry, or no distinguishing leaf: take the most key-like one.
  return preferred[0] ? [preferred[0]] : scalarFields[0] ? [scalarFields[0]] : [];
}

function elemIdentity(elem: GnmiPathElem): string {
  return formatGnmiElem({ name: stripModulePrefix(elem.name), ...(elem.keys ? { keys: elem.keys } : {}) });
}

function childId(parent: DataNode, elem: GnmiPathElem): string {
  return `${parent.kind === 'root' ? '' : parent.id}/${elemIdentity(elem)}`;
}

export function createRoot(path: GnmiPath = { elems: [] }): DataNode {
  return { id: '', name: '', kind: 'root', path, children: [] };
}

function findChild(parent: DataNode, id: string): DataNode | undefined {
  return parent.children.find((child) => child.id === id);
}

function addChild(parent: DataNode, child: DataNode): DataNode {
  parent.children.push(child);
  return child;
}

/** The list node `name` under `parent`, created on first use. */
function listNode(parent: DataNode, name: string): DataNode {
  const elem = { name };
  const id = childId(parent, elem);
  const existing = findChild(parent, id);
  if (existing) {
    if (existing.kind !== 'list') existing.kind = 'list';
    return existing;
  }
  return addChild(parent, {
    id,
    name,
    kind: 'list',
    path: { ...parent.path, elems: [...parent.path.elems, elem] },
    children: [],
  });
}

function entryNode(list: DataNode, keys: Record<string, string>, guessed: boolean): DataNode {
  const elem = { name: list.name, keys };
  const parentPath = { ...list.path, elems: list.path.elems.slice(0, -1) };
  const id = `${list.id.slice(0, list.id.lastIndexOf('/'))}/${elemIdentity(elem)}`;
  const existing = findChild(list, id);
  if (existing) {
    if (!guessed) existing.guessedKeys = false;
    return existing;
  }
  return addChild(list, {
    id,
    name: list.name,
    kind: 'entry',
    keys,
    ...(guessed ? { guessedKeys: true } : {}),
    path: { ...parentPath, elems: [...parentPath.elems, elem] },
    children: [],
  });
}

function containerNode(parent: DataNode, name: string): DataNode {
  const elem = { name };
  const id = childId(parent, elem);
  const existing = findChild(parent, id);
  if (existing) return existing;
  return addChild(parent, {
    id,
    name,
    kind: 'container',
    path: { ...parent.path, elems: [...parent.path.elems, elem] },
    children: [],
  });
}

function schemaPathOf(node: DataNode): string {
  return `/${node.path.elems.map((elem) => stripModulePrefix(elem.name)).join('/')}`;
}

/** Walk (and create) the nodes for `path` below `root`. */
export function nodeAt(root: DataNode, path: GnmiPath, registry?: KeyRegistry): DataNode {
  registry?.learn(path);
  let node = root;
  for (const elem of path.elems.slice(root.path.elems.length)) {
    if (elem.keys && Object.keys(elem.keys).length) {
      node = entryNode(listNode(node, elem.name), elem.keys, false);
    } else {
      node = containerNode(node, elem.name);
    }
  }
  return node;
}

function setLeaf(parent: DataNode, name: string, value: unknown): void {
  const elem = { name };
  const id = childId(parent, elem);
  const existing = findChild(parent, id);
  const kind: DataNodeKind = Array.isArray(value) ? 'leaf-list' : 'leaf';
  if (existing) {
    existing.kind = kind;
    existing.value = value;
    existing.children = [];
    return;
  }
  addChild(parent, {
    id,
    name,
    kind,
    value,
    path: { ...parent.path, elems: [...parent.path.elems, elem] },
    children: [],
  });
}

/** Merge a JSON value (RFC 7951 or plain JSON) into `node`. */
export function mergeJson(node: DataNode, value: unknown, registry?: KeyRegistry): void {
  if (node.kind === 'list' && Array.isArray(value)) {
    mergeListEntries(node, value, registry);
    return;
  }
  if (!isPlainObject(value)) {
    // A scalar at a path: the node itself is a leaf.
    node.kind = Array.isArray(value) ? 'leaf-list' : 'leaf';
    node.value = value;
    return;
  }
  if (node.kind === 'leaf' || node.kind === 'leaf-list') {
    node.kind = 'container';
    delete node.value;
  }
  for (const [name, child] of Object.entries(value)) {
    if (Array.isArray(child) && child.length > 0 && child.every(isPlainObject)) {
      mergeListEntries(listNode(node, name), child, registry);
    } else if (isPlainObject(child)) {
      mergeJson(containerNode(node, name), child, registry);
    } else {
      setLeaf(node, name, child);
    }
  }
}

function mergeListEntries(list: DataNode, entries: unknown[], registry?: KeyRegistry): void {
  const objects = entries.filter(isPlainObject);
  const learned = registry?.lookup(schemaPathOf(list));
  const keyNames = learned ?? guessListKeys(objects);
  for (const entry of objects) {
    const keys: Record<string, string> = {};
    for (const key of keyNames) {
      // JSON may qualify the key leaf with its module; the path never does.
      const field = key in entry ? key : Object.keys(entry).find((name) => stripModulePrefix(name) === key);
      keys[stripModulePrefix(key)] = field === undefined ? '' : scalarText(entry[field]);
    }
    mergeJson(entryNode(list, keys, !learned), entry, registry);
  }
}

/** Sort for display: leaves first (they describe the node), then containers and lists by name. */
export function displayChildren(node: DataNode): DataNode[] {
  if (node.kind === 'list') return node.children;
  const leaves = node.children.filter((child) => child.kind === 'leaf' || child.kind === 'leaf-list');
  const branches = node.children.filter((child) => child.kind !== 'leaf' && child.kind !== 'leaf-list');
  return [...leaves, ...branches];
}

export function nodeLabel(node: DataNode): string {
  if (node.kind === 'entry') {
    const values = Object.values(node.keys ?? {});
    return values.length ? values.join(' · ') : stripModulePrefix(node.name);
  }
  return stripModulePrefix(node.name) || '/';
}

export function nodePathText(node: DataNode): string {
  return formatGnmiPath(node.path);
}

export interface LeafRow {
  path: string;
  node: DataNode;
  value: unknown;
}

export function collectLeaves(node: DataNode, out: LeafRow[] = [], limit = Number.POSITIVE_INFINITY): LeafRow[] {
  if (out.length >= limit) return out;
  if (node.kind === 'leaf' || node.kind === 'leaf-list') {
    out.push({ path: nodePathText(node), node, value: node.value });
    return out;
  }
  for (const child of displayChildren(node)) {
    collectLeaves(child, out, limit);
    if (out.length >= limit) break;
  }
  return out;
}

export function countLeaves(node: DataNode): number {
  if (node.kind === 'leaf' || node.kind === 'leaf-list') return 1;
  let total = 0;
  for (const child of node.children) total += countLeaves(child);
  return total;
}

/** The tree as plain JSON, for the raw view and the clipboard. */
export function nodeToJson(node: DataNode): unknown {
  if (node.kind === 'leaf' || node.kind === 'leaf-list') return node.value;
  if (node.kind === 'list') return node.children.map(nodeToJson);
  const out: Record<string, unknown> = {};
  for (const child of node.children) out[child.name] = nodeToJson(child);
  return out;
}

export function findNode(root: DataNode, id: string): DataNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    if (id === child.id || id.startsWith(`${child.id}/`) || child.kind === 'list') {
      const found = findNode(child, id);
      if (found) return found;
    }
  }
  return undefined;
}

// XML (NETCONF)

function elementChildren(element: Element): Element[] {
  return Array.from(element.children);
}

function isLeafElement(element: Element): boolean {
  return element.children.length === 0;
}

/** Leaves of an XML list entry that most likely form its key. */
function guessElementKeys(siblings: readonly Element[]): string[] {
  const entries = siblings.map((sibling) => {
    const leaves: Record<string, unknown> = {};
    for (const child of elementChildren(sibling)) {
      if (isLeafElement(child)) leaves[child.localName] = child.textContent?.trim() ?? '';
    }
    return leaves;
  });
  return guessListKeys(entries);
}

/**
 * Merge the element children of `container` (an XML element such as
 * <data>) into `node`. Repeated siblings become list entries; a lone
 * element with a well-known key leaf (`name`, `index`, …) is treated as a
 * list entry too, which is what it almost always is.
 */
export function mergeXml(node: DataNode, container: Element): void {
  const groups = new Map<string, Element[]>();
  for (const child of elementChildren(container)) {
    const key = `${child.namespaceURI ?? ''} ${child.localName}`;
    const group = groups.get(key);
    if (group) group.push(child);
    else groups.set(key, [child]);
  }
  for (const elements of groups.values()) {
    const first = elements[0]!;
    const name = first.localName;
    if (elements.length === 1 && isLeafElement(first)) {
      setLeaf(node, name, first.textContent?.trim() ?? '');
      tagNamespace(node, name, first.namespaceURI);
      continue;
    }
    if (elements.every(isLeafElement)) {
      setLeaf(node, name, elements.map((element) => element.textContent?.trim() ?? ''));
      tagNamespace(node, name, first.namespaceURI);
      continue;
    }
    const keyNames = guessElementKeys(elements);
    const looksLikeEntry =
      elements.length > 1 ||
      keyNames.some((key) => KEY_NAMES.slice(0, 6).includes(key) && first.getElementsByTagName(key).length > 0);
    if (!looksLikeEntry) {
      const child = containerNode(node, name);
      child.namespace ??= first.namespaceURI ?? undefined;
      mergeXml(child, first);
      continue;
    }
    const list = listNode(node, name);
    list.namespace ??= first.namespaceURI ?? undefined;
    for (const element of elements) {
      const keys: Record<string, string> = {};
      for (const key of keyNames) {
        const leaf = elementChildren(element).find((child) => child.localName === key && isLeafElement(child));
        keys[key] = leaf?.textContent?.trim() ?? '';
      }
      const entry = entryNode(list, keys, true);
      entry.namespace ??= element.namespaceURI ?? undefined;
      mergeXml(entry, element);
    }
  }
}

function tagNamespace(parent: DataNode, name: string, namespace: string | null): void {
  if (!namespace) return;
  const child = findChild(parent, childId(parent, { name }));
  if (child) child.namespace ??= namespace;
}

/** Nearest namespace on the node or its ancestors in `root`. */
export function namespaceChain(root: DataNode, target: DataNode): DataNode[] {
  const chain: DataNode[] = [];
  const visit = (node: DataNode): boolean => {
    if (node === target) return true;
    for (const child of node.children) {
      chain.push(child);
      if (visit(child)) return true;
      chain.pop();
    }
    return false;
  };
  visit(root);
  return chain;
}
