import type { DataNode } from './data-tree.js';

/**
 * NETCONF XML in the renderer: replies are parsed with DOMParser for the
 * tree and error views, pretty-printed for the raw view, and requests are
 * assembled from editor state.
 */

export const NETCONF_BASE_NS = 'urn:ietf:params:xml:ns:netconf:base:1.0';

export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (char) =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : char === '"' ? '&quot;' : '&apos;',
  );
}

export interface XmlParseResult {
  document?: Document;
  error?: string;
}

export function parseXml(text: string): XmlParseResult {
  const document = new DOMParser().parseFromString(text, 'application/xml');
  const failure = document.getElementsByTagName('parsererror')[0];
  if (failure) {
    const detail = failure.textContent?.replace(/\s+/g, ' ').trim() ?? 'not well-formed';
    // Chromium wraps the message: "This page contains the following errors: … Below is a rendering …".
    const message = /error on line [^:]*:\s*(.*?)(?:Below is a rendering|$)/i.exec(detail)?.[1] ?? detail;
    return { error: message.trim() };
  }
  return { document };
}

/** Check a fragment (several top-level elements allowed) by wrapping it. */
export function xmlFragmentError(text: string): string | undefined {
  if (!text.trim()) return undefined;
  return parseXml(`<muxus-fragment>${text}</muxus-fragment>`).error;
}

/** Indent XML for reading; text-only elements stay on one line. Unparseable input is returned as is. */
export function prettyXml(text: string, indent = '  '): string {
  const { document } = parseXml(text);
  if (!document) return text;
  const lines: string[] = [];
  const declaration = /^\s*<\?xml[^>]*\?>/.exec(text)?.[0]?.trim();
  if (declaration) lines.push(declaration);
  const attributes = (element: Element) =>
    Array.from(element.attributes)
      .map((attribute) => ` ${attribute.name}="${escapeXml(attribute.value)}"`)
      .join('');
  const visit = (node: Node, depth: number) => {
    const pad = indent.repeat(depth);
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element;
      const children = Array.from(element.childNodes).filter(
        (child) =>
          child.nodeType === Node.ELEMENT_NODE ||
          child.nodeType === Node.COMMENT_NODE ||
          child.nodeType === Node.CDATA_SECTION_NODE ||
          (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()),
      );
      const open = `<${element.tagName}${attributes(element)}`;
      if (children.length === 0) {
        lines.push(`${pad}${open}/>`);
        return;
      }
      const onlyText = children.every((child) => child.nodeType === Node.TEXT_NODE);
      if (onlyText) {
        lines.push(`${pad}${open}>${escapeXml(element.textContent?.trim() ?? '')}</${element.tagName}>`);
        return;
      }
      lines.push(`${pad}${open}>`);
      for (const child of children) visit(child, depth + 1);
      lines.push(`${pad}</${element.tagName}>`);
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      lines.push(`${pad}${escapeXml(node.textContent?.trim() ?? '')}`);
    } else if (node.nodeType === Node.CDATA_SECTION_NODE) {
      lines.push(`${pad}<![CDATA[${node.textContent ?? ''}]]>`);
    } else if (node.nodeType === Node.COMMENT_NODE) {
      lines.push(`${pad}<!--${node.textContent ?? ''}-->`);
    }
  };
  visit(document.documentElement, 0);
  return lines.join('\n');
}

export interface RpcErrorInfo {
  type?: string;
  tag?: string;
  severity?: string;
  path?: string;
  message?: string;
  /** <error-info> children as name/value pairs. */
  info: Array<{ name: string; value: string }>;
}

export interface RpcReply {
  ok: boolean;
  /** <data>, for retrievals. */
  data?: Element;
  errors: RpcErrorInfo[];
  /** Reply content that is neither <ok/>, <data> nor <rpc-error>. */
  other: Element[];
}

function childText(element: Element, name: string): string | undefined {
  const child = Array.from(element.children).find((candidate) => candidate.localName === name);
  return child?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
}

export function parseRpcReply(xml: string): RpcReply | undefined {
  const { document } = parseXml(xml);
  const root = document?.documentElement;
  if (!root || root.localName !== 'rpc-reply') return undefined;
  const reply: RpcReply = { ok: false, errors: [], other: [] };
  for (const child of Array.from(root.children)) {
    if (child.localName === 'ok') reply.ok = true;
    else if (child.localName === 'data') reply.data = child;
    else if (child.localName === 'rpc-error') {
      const info = Array.from(child.children).find((candidate) => candidate.localName === 'error-info');
      reply.errors.push({
        type: childText(child, 'error-type'),
        tag: childText(child, 'error-tag'),
        severity: childText(child, 'error-severity'),
        path: childText(child, 'error-path'),
        message: childText(child, 'error-message'),
        info: info
          ? Array.from(info.children).map((item) => ({
              name: item.localName,
              value: item.textContent?.replace(/\s+/g, ' ').trim() ?? '',
            }))
          : [],
      });
    } else reply.other.push(child);
  }
  return reply;
}

/** `<rpc>…</rpc>` pasted whole: keep what is inside, carrying namespace declarations down. */
export function unwrapRpc(text: string): string {
  const { document } = parseXml(text.trim());
  const root = document?.documentElement;
  if (!root || root.localName !== 'rpc') return text;
  const serializer = new XMLSerializer();
  const declarations = Array.from(root.attributes).filter(
    (attribute) => attribute.name.startsWith('xmlns:') && attribute.value !== NETCONF_BASE_NS,
  );
  return Array.from(root.children)
    .map((child) => {
      for (const declaration of declarations) {
        if (!child.hasAttribute(declaration.name)) child.setAttribute(declaration.name, declaration.value);
      }
      return serializer.serializeToString(child).replace(` xmlns="${NETCONF_BASE_NS}"`, '');
    })
    .join('');
}

/** The full message as it goes on the wire, for copying. */
export function rpcEnvelope(body: string, messageId = '101'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rpc message-id="${messageId}" xmlns="${NETCONF_BASE_NS}">\n${body}\n</rpc>`;
}

/** A node without a namespace of its own inherits its nearest ancestor's. */
function effectiveNamespace(chain: readonly DataNode[], index: number): string | undefined {
  for (let at = index; at >= 0; at--) if (chain[at]!.namespace) return chain[at]!.namespace;
  return undefined;
}

function parentElementIndex(chain: readonly DataNode[], index: number): number {
  for (let at = index - 1; at >= 0; at--) if (chain[at]!.kind !== 'list') return at;
  return -1;
}

function keyElements(node: DataNode): string {
  return Object.entries(node.keys ?? {})
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join('');
}

/**
 * A subtree filter that selects `target` (a node of a NETCONF tree): every
 * ancestor with its namespace, list entries narrowed by their key leaves.
 * `inner` replaces the target's own content (empty selects all of it).
 */
export function subtreeFilterFor(chain: readonly DataNode[], inner = ''): string {
  let xml = inner;
  for (let index = chain.length - 1; index >= 0; index--) {
    const node = chain[index]!;
    // A list is written through its entries; as the target it selects them all.
    if (node.kind === 'list' && index !== chain.length - 1) continue;
    const name = node.name.includes(':') ? node.name.slice(node.name.indexOf(':') + 1) : node.name;
    const namespace = effectiveNamespace(chain, index);
    // List nodes are not elements: the parent element is the nearest non-list ancestor.
    const parent = parentElementIndex(chain, index);
    const parentNamespace = parent >= 0 ? effectiveNamespace(chain, parent) : undefined;
    const xmlns = namespace && namespace !== parentNamespace ? ` xmlns="${escapeXml(namespace)}"` : '';
    const content = (node.kind === 'entry' ? keyElements(node) : '') + xml;
    xml = content ? `<${name}${xmlns}>${content}</${name}>` : `<${name}${xmlns}/>`;
  }
  return xml;
}

/** An XPath that selects the node, for servers with :xpath. */
export function xpathFor(chain: readonly DataNode[]): string {
  return (
    '/' +
    chain
      .filter((node, index) => node.kind !== 'list' || index === chain.length - 1)
      .map((node) => {
        const name = node.name.includes(':') ? node.name.slice(node.name.indexOf(':') + 1) : node.name;
        const predicates = Object.entries(node.keys ?? {})
          .map(([key, value]) => `[${key}=${value.includes("'") ? `"${value}"` : `'${value}'`}]`)
          .join('');
        return `${name}${predicates}`;
      })
      .join('/')
  );
}

/** Serialize the config subtree of a node back to XML, wrapped in its ancestors, for edit-config. */
export function configSkeletonFor(chain: readonly DataNode[], leafValue?: string): string {
  const target = chain[chain.length - 1];
  if (!target) return '';
  const inner = leafValue !== undefined ? escapeXml(leafValue) : '';
  if (target.kind === 'leaf') {
    const name = target.name;
    return subtreeFilterFor(chain.slice(0, -1), `<${name}>${inner}</${name}>`);
  }
  return subtreeFilterFor(chain);
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return '';
}

function localName(node: DataNode): string {
  return node.name.includes(':') ? node.name.slice(node.name.indexOf(':') + 1) : node.name;
}

/** A tree node and everything below it as XML, the way the device would send it. */
export function dataNodeXml(node: DataNode, inheritedNamespace: string | undefined, indent = ''): string {
  const namespace = node.namespace ?? inheritedNamespace;
  const xmlns = node.namespace && node.namespace !== inheritedNamespace ? ` xmlns="${escapeXml(node.namespace)}"` : '';
  const name = localName(node);
  if (node.kind === 'list') {
    return node.children.map((entry) => dataNodeXml(entry, inheritedNamespace, indent)).join('\n');
  }
  if (node.kind === 'leaf') return `${indent}<${name}${xmlns}>${escapeXml(scalarText(node.value))}</${name}>`;
  if (node.kind === 'leaf-list') {
    const values: unknown[] = Array.isArray(node.value) ? node.value : [node.value];
    return values.map((value) => `${indent}<${name}${xmlns}>${escapeXml(scalarText(value))}</${name}>`).join('\n');
  }
  const inner = node.children.map((child) => dataNodeXml(child, namespace, `${indent}  `)).join('\n');
  return inner ? `${indent}<${name}${xmlns}>\n${inner}\n${indent}</${name}>` : `${indent}<${name}${xmlns}/>`;
}

/**
 * edit-config content for a node: its ancestors (list entries with their
 * keys) around either the node's current content or a delete operation.
 */
export function editConfigFor(chain: readonly DataNode[], mode: 'edit' | 'delete'): string {
  const target = chain[chain.length - 1];
  if (!target) return '';
  const ancestors = chain.slice(0, -1);
  const parent = parentElementIndex(chain, chain.length - 1);
  const inherited = parent >= 0 ? effectiveNamespace(chain, parent) : undefined;
  let inner: string;
  if (mode === 'delete') {
    const name = localName(target);
    const namespace = target.namespace && target.namespace !== inherited ? ` xmlns="${escapeXml(target.namespace)}"` : '';
    const keys = target.kind === 'entry' ? keyElements(target) : '';
    inner = `<${name}${namespace} xmlns:nc="${NETCONF_BASE_NS}" nc:operation="delete">${keys}</${name}>`;
  } else {
    inner = dataNodeXml(target, inherited).trim();
  }
  return prettyXml(`<muxus-wrap>${subtreeFilterFor(ancestors, inner)}</muxus-wrap>`)
    .split('\n')
    .slice(1, -1)
    .map((line) => line.slice(2))
    .join('\n');
}
