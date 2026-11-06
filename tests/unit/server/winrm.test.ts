import { createHmac } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LineEditor } from '../../../server/src/winrm/line-editor.js';
import { md4, NtlmSession, Rc4 } from '../../../server/src/winrm/ntlm.js';
import { envelope, parseReceive, xmlText } from '../../../server/src/winrm/winrm-client.js';
import { WinrmTransport } from '../../../server/src/winrm/winrm-transport.js';
import type { ConnectIo } from '../../../server/src/ssh/connection-manager.js';

const PASSWORD = 'Secret#1';
const SERVER_CHALLENGE = Buffer.from('0123456789abcdef', 'hex');

/** The server's view of an NTLM session: the client's keys, mirrored. */
function serverSession(exportedKey: Buffer, flags: number): NtlmSession {
  const session = new NtlmSession(exportedKey, flags) as unknown as Record<string, unknown>;
  [session.clientSeal, session.serverSeal] = [session.serverSeal, session.clientSeal];
  [session.clientSign, session.serverSign] = [session.serverSign, session.clientSign];
  return session as unknown as NtlmSession;
}

function challengeMessage(): Buffer {
  const info = Buffer.from([2, 0, 4, 0, 0x43, 0, 0x4f, 0, 0, 0, 0, 0]); // NbDomainName "CO", EOL
  const message = Buffer.alloc(56 + info.length);
  message.write('NTLMSSP\0', 0, 'latin1');
  message.writeUInt32LE(2, 8);
  message.writeUInt32LE(0xe28a8235, 20);
  SERVER_CHALLENGE.copy(message, 24);
  message.writeUInt16LE(info.length, 40);
  message.writeUInt16LE(info.length, 42);
  message.writeUInt32LE(56, 44);
  info.copy(message, 56);
  return message;
}

function field(message: Buffer, at: number): Buffer {
  const length = message.readUInt16LE(at);
  const offset = message.readUInt32LE(at + 4);
  return message.subarray(offset, offset + length);
}

/** Check the client's proof against the password; returns the session or undefined. */
function acceptAuthenticate(message: Buffer, password: string): NtlmSession | undefined {
  const nt = field(message, 20);
  const domain = field(message, 28).toString('utf16le');
  const user = field(message, 36).toString('utf16le');
  const key = createHmac('md5', md4(Buffer.from(password, 'utf16le')))
    .update(Buffer.from(user.toUpperCase() + domain, 'utf16le'))
    .digest();
  const proof = createHmac('md5', key).update(SERVER_CHALLENGE).update(nt.subarray(16)).digest();
  if (!proof.equals(nt.subarray(0, 16))) return undefined;
  const sessionBaseKey = createHmac('md5', key).update(proof).digest();
  const flags = message.readUInt32LE(60);
  const exported = new Rc4(sessionBaseKey).update(field(message, 52));
  return serverSession(exported, flags);
}

interface FakeWinrm {
  port: number;
  inputs: string[];
  logins: number;
  close(): Promise<void>;
}

/**
 * A WinRM service with NTLM over HTTP and message encryption, whose "shell"
 * answers each stdin line with `out:<line>` and ends on `exit`.
 */
async function startFakeWinrm(): Promise<FakeWinrm> {
  const state = { inputs: [] as string[], logins: 0, pendingOutput: [] as string[], done: false };
  const sessions = new WeakMap<net.Socket, NtlmSession>();
  const waiters: Array<() => void> = [];
  const wakeAll = () => waiters.splice(0).forEach((wake) => wake());

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        const socket = req.socket;
        const authorization = req.headers.authorization ?? '';
        const token = /^Negotiate (.+)$/.exec(authorization)?.[1];
        if (token) {
          const message = Buffer.from(token, 'base64');
          const type = message.readUInt32LE(8);
          if (type === 1) {
            res.writeHead(401, { 'WWW-Authenticate': `Negotiate ${challengeMessage().toString('base64')}` });
            res.end();
            return;
          }
          const session = acceptAuthenticate(message, PASSWORD);
          if (!session) {
            res.writeHead(401);
            res.end();
            return;
          }
          state.logins += 1;
          sessions.set(socket, session);
        }
        const session = sessions.get(socket);
        if (!session) {
          res.writeHead(401);
          res.end();
          return;
        }
        // Decrypt the request.
        const marker = Buffer.from('\tContent-Type: application/octet-stream\r\n', 'latin1');
        const start = body.indexOf(marker) + marker.length;
        const part = body.subarray(start, body.lastIndexOf(Buffer.from('--Encrypted Boundary', 'latin1')));
        const sigLength = part.readUInt32LE(0);
        const xml = session
          .unseal(part.subarray(4 + sigLength), part.subarray(4, 4 + sigLength))
          .toString('utf8');

        let reply: string;
        let status = 200;
        if (xml.includes('transfer/Create')) {
          reply = '<rsp:Shell><rsp:ShellId>SHELL-1</rsp:ShellId></rsp:Shell>';
        } else if (xml.includes('shell/Command')) {
          reply = '<rsp:CommandResponse><rsp:CommandId>CMD-1</rsp:CommandId></rsp:CommandResponse>';
        } else if (xml.includes('shell/Send')) {
          const data = /<rsp:Stream[^>]*>([^<]*)</.exec(xml)?.[1] ?? '';
          const text = Buffer.from(data, 'base64').toString('utf8');
          for (const line of text.split('\r\n').filter(Boolean)) {
            state.inputs.push(line);
            if (line === 'exit') state.done = true;
            else state.pendingOutput.push(`out:${line}\r\n`);
          }
          wakeAll();
          reply = '<rsp:SendResponse/>';
        } else if (xml.includes('shell/Receive')) {
          if (state.pendingOutput.length === 0 && !state.done) {
            await new Promise<void>((resolve) => {
              waiters.push(resolve);
              setTimeout(resolve, 150);
            });
          }
          if (state.pendingOutput.length > 0) {
            const out = Buffer.from(state.pendingOutput.splice(0).join('')).toString('base64');
            reply = `<rsp:ReceiveResponse><rsp:Stream Name="stdout" CommandId="CMD-1">${out}</rsp:Stream></rsp:ReceiveResponse>`;
          } else if (state.done) {
            reply =
              '<rsp:ReceiveResponse><rsp:Stream Name="stdout" CommandId="CMD-1" End="true"/>' +
              '<rsp:CommandState CommandId="CMD-1" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"><rsp:ExitCode>0</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>';
          } else {
            status = 500;
            reply =
              '<s:Fault><s:Code><s:Value>s:Receiver</s:Value><s:Subcode><s:Value>w:TimedOut</s:Value></s:Subcode></s:Code><s:Reason><s:Text xml:lang="">The WS-Management service cannot complete the operation within the time specified in OperationTimeout.</s:Text></s:Reason></s:Fault>';
          }
        } else {
          reply = '<rsp:Done/>';
        }
        const plain = Buffer.from(`<s:Envelope><s:Body>${reply}</s:Body></s:Envelope>`);
        const { signature, sealed } = session.seal(plain);
        const length = Buffer.alloc(4);
        length.writeUInt32LE(signature.length);
        const out = Buffer.concat([
          Buffer.from(
            '--Encrypted Boundary\r\n\tContent-Type: application/HTTP-SPNEGO-session-encrypted\r\n' +
              `\tOriginalContent: type=application/soap+xml;charset=UTF-8;Length=${plain.length}\r\n` +
              '--Encrypted Boundary\r\n\tContent-Type: application/octet-stream\r\n',
            'latin1',
          ),
          length,
          signature,
          sealed,
          Buffer.from('--Encrypted Boundary--\r\n', 'latin1'),
        ]);
        res.writeHead(status, {
          'Content-Type':
            'multipart/encrypted;protocol="application/HTTP-SPNEGO-session-encrypted";boundary="Encrypted Boundary"',
          'Content-Length': out.length,
        });
        res.end(out);
      })();
    });
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    get inputs() {
      return state.inputs;
    },
    get logins() {
      return state.logins;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function deps(answers: string[][]) {
  const prompts: string[][] = [];
  const io: ConnectIo = {
    status: () => undefined,
    prompt: (info) => {
      prompts.push(info.prompts.map((prompt) => prompt.prompt));
      return Promise.resolve({ answers: answers.shift() ?? [], rememberPassword: false });
    },
    hostKey: () => Promise.resolve(false),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    prompts,
    deps: { connections: { connect: vi.fn() }, vault: undefined, io, log: log as never, closed: () => false },
  };
}

function collect(transport: WinrmTransport): { text: () => string; closed: Promise<void> } {
  const parts: Buffer[] = [];
  transport.onData((data) => parts.push(data));
  const closed = new Promise<void>((resolve) => transport.onClose(resolve));
  return { text: () => Buffer.concat(parts).toString('utf8'), closed };
}

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('WinRM shell over NTLM-encrypted HTTP', () => {
  let server: FakeWinrm | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('signs in, runs typed lines and ends with the shell', async () => {
    server = await startFakeWinrm();
    const { deps: d, prompts } = deps([['CORP\\alice', PASSWORD]]);
    const transport = await WinrmTransport.connect(
      { kind: 'winrm', host: '127.0.0.1', port: server.port },
      d,
    );
    const output = collect(transport);
    expect(prompts).toEqual([['User name', 'Password']]);

    transport.write(Buffer.from('dir'));
    transport.write(Buffer.from('\x7fr\r'));
    await until(() => output.text().includes('out:dir'));
    expect(server.inputs).toEqual(['dir']);
    // Receiving and sending each log in on their own connection; the second
    // finishes its login with its first message.
    expect(server.logins).toBe(2);
    // Typed text is echoed locally, Backspace included.
    expect(output.text()).toContain('dir\b \br\r\n');

    transport.write(Buffer.from('exit\r'));
    await output.closed;
    expect(server.inputs).toEqual(['dir', 'exit']);
  }, 15_000);

  it('asks again after a rejected password', async () => {
    server = await startFakeWinrm();
    const { deps: d, prompts } = deps([['wrong'], [PASSWORD]]);
    const transport = await WinrmTransport.connect(
      { kind: 'winrm', host: '127.0.0.1', port: server.port, username: 'alice' },
      d,
    );
    expect(prompts).toEqual([['Password'], ['Password']]);
    transport.close();
  }, 15_000);

  it('refuses Basic authentication over plain HTTP', async () => {
    const { deps: d } = deps([]);
    await expect(
      WinrmTransport.connect({ kind: 'winrm', host: '127.0.0.1', port: 1, auth: 'basic' }, d),
    ).rejects.toThrow(/HTTPS/);
  });
});

describe('WinRM messages', () => {
  it('reads output, exit state and escaped text', () => {
    const result = parseReceive(
      '<rsp:Stream Name="stdout" CommandId="c">' +
        Buffer.from('hi').toString('base64') +
        '</rsp:Stream><rsp:Stream Name="stderr" CommandId="c">' +
        Buffer.from('oops').toString('base64') +
        '</rsp:Stream><rsp:Stream Name="stdout" CommandId="c" End="true"/>' +
        '<rsp:CommandState CommandId="c" State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done"><rsp:ExitCode>3</rsp:ExitCode></rsp:CommandState>',
    );
    expect(result.chunks.map((chunk) => `${chunk.stream}:${chunk.data.toString()}`)).toEqual(['stdout:hi', 'stderr:oops']);
    expect(result).toMatchObject({ done: true, exitCode: 3 });
    expect(xmlText('a &lt;b&gt; &amp;amp; &#x41;')).toBe('a <b> &amp; A');
  });

  it('escapes what it puts in an envelope', () => {
    const text = envelope('http://h:5985/wsman', 'urn:a', '<x/>', { shellId: 'a"<b' });
    expect(text).toContain('<wsman:Selector Name="ShellId">a&quot;&lt;b</wsman:Selector>');
  });
});

describe('line editor', () => {
  function editor() {
    const echoed: string[] = [];
    const lines: string[] = [];
    const interrupts: number[] = [];
    const ed = new LineEditor({
      echo: (text) => echoed.push(text),
      line: (text) => lines.push(text),
      interrupt: () => interrupts.push(1),
    });
    return { ed, echoed, lines, interrupts };
  }

  it('sends lines on Enter, once for CR LF', () => {
    const { ed, lines } = editor();
    ed.input('one\r\ntwo\nthree\r');
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('edits with Backspace, Ctrl+W and Ctrl+U', () => {
    const { ed, lines } = editor();
    ed.input('abc\x7f\x7fx\r');
    ed.input('git push origin\x17main\r');
    ed.input('nothing\x15yes\r');
    expect(lines).toEqual(['ax', 'git push main', 'yes']);
  });

  it('walks history with the arrow keys, in either cursor mode', () => {
    const { ed, lines } = editor();
    ed.input('first\rsecond\r');
    ed.input('\x1b[A\x1b[A\r');
    ed.input('\x1bOA\r');
    expect(lines).toEqual(['first', 'second', 'first', 'first']);
  });

  it('interrupts on Ctrl+C and drops bracketed-paste markers', () => {
    const { ed, lines, interrupts } = editor();
    ed.input('half\x03');
    ed.input('\x1b[200~pasted\x1b[201~\r');
    expect(interrupts).toHaveLength(1);
    expect(lines).toEqual(['pasted']);
  });
});
