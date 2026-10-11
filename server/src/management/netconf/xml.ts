/**
 * The little XML the backend has to understand: which reply a message
 * answers, and what a hello advertises. Everything else stays text for the
 * client, which parses and renders it.
 */

export const NETCONF_BASE_NS = 'urn:ietf:params:xml:ns:netconf:base:1.0';
export const NETCONF_BASE_1_0 = 'urn:ietf:params:netconf:base:1.0';
export const NETCONF_BASE_1_1 = 'urn:ietf:params:netconf:base:1.1';

export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (char) =>
    char === '<' ? '&lt;' : char === '>' ? '&gt;' : char === '&' ? '&amp;' : char === '"' ? '&quot;' : '&apos;',
  );
}

export function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

export interface RootElement {
  /** Element name without its namespace prefix. */
  name: string;
  attributes: Record<string, string>;
}

/** The document element's name and attributes, skipping the prolog. */
export function rootElement(xml: string): RootElement | undefined {
  let index = 0;
  for (;;) {
    while (index < xml.length && /\s/.test(xml[index]!)) index++;
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index);
      if (end < 0) return undefined;
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index);
      if (end < 0) return undefined;
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<!', index)) {
      const end = xml.indexOf('>', index);
      if (end < 0) return undefined;
      index = end + 1;
      continue;
    }
    break;
  }
  if (xml[index] !== '<') return undefined;
  const tag = /^<([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/.exec(
    xml.slice(index, index + 8192),
  );
  if (!tag) return undefined;
  const qualified = tag[1]!;
  const attributes: Record<string, string> = {};
  for (const attribute of tag[2]!.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    const attributeName = attribute[1]!;
    const local = attributeName.includes(':') && !attributeName.startsWith('xmlns') ? attributeName.split(':')[1]! : attributeName;
    attributes[local] = decodeXmlEntities(attribute[2] ?? attribute[3] ?? '');
  }
  return { name: qualified.includes(':') ? qualified.split(':')[1]! : qualified, attributes };
}

function elementTexts(xml: string, name: string): string[] {
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}\\s*>`, 'g');
  return [...xml.matchAll(pattern)].map((match) => decodeXmlEntities(match[1]!.trim()));
}

export interface Hello {
  capabilities: string[];
  sessionId?: string;
}

export function parseHello(xml: string): Hello {
  const root = rootElement(xml);
  if (root?.name !== 'hello') throw new Error('The server did not start with a NETCONF <hello>.');
  const capabilities = elementTexts(xml, 'capability').filter(Boolean);
  const sessionId = elementTexts(xml, 'session-id')[0];
  return { capabilities, ...(sessionId ? { sessionId } : {}) };
}

export function clientHello(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<hello xmlns="${NETCONF_BASE_NS}"><capabilities>` +
    `<capability>${NETCONF_BASE_1_0}</capability>` +
    `<capability>${NETCONF_BASE_1_1}</capability>` +
    '</capabilities></hello>'
  );
}

export function wrapRpc(messageId: string, body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<rpc message-id="${escapeXml(messageId)}" xmlns="${NETCONF_BASE_NS}">${body}</rpc>`
  );
}

export function notificationEventTime(xml: string): string | undefined {
  return elementTexts(xml, 'eventTime')[0];
}
