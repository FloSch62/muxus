import type { Readable, Writable } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';
import { SFTP } from './ssh2-internals.js';

/**
 * Speak SFTP to an `sftp-server` reached through a byte stream, with ssh2's own
 * protocol code, so the file routes use one SFTP API whichever client carries
 * it. The channel fields ssh2 expects are stubbed: the pipe has no SSH window
 * or packet size, and ssh2 already bounds how much it has in flight per file.
 */
export function sftpOverStdio(input: Writable, output: Readable): Promise<SFTPWrapper> {
  const channel = {
    type: 'sftp',
    incoming: { id: 0, state: 'open' },
    outgoing: {
      id: 0,
      state: 'open',
      window: Number.MAX_SAFE_INTEGER,
      packetSize: Number.MAX_SAFE_INTEGER,
    },
  };
  const sftp = new SFTP(
    {
      _protocol: {
        channelData: (_id: number, data: Buffer) => input.write(data),
        channelClose: () => input.end(),
      },
    },
    channel,
  ) as SFTPWrapper & {
    push(data: Buffer | null): void;
    _init(): void;
  };

  // The end of the stream fails whatever is still waiting for a reply.
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    channel.incoming.state = 'closed';
    channel.outgoing.state = 'closed';
    sftp.push(null);
    sftp.emit('close');
  };
  output.on('data', (data: Buffer) => sftp.push(data));
  output.once('close', close);
  output.once('end', close);
  // A write after the far end left arrives here; the close above reports it.
  input.on('error', () => undefined);
  output.on('error', close);

  return new Promise((resolve, reject) => {
    const settle = (finish: () => void) => {
      sftp.off('ready', onReady);
      sftp.off('error', onError);
      sftp.off('close', onClose);
      finish();
    };
    const onReady = () => settle(() => resolve(sftp));
    const onError = (error: Error) => settle(() => reject(error));
    const onClose = () =>
      settle(() => reject(new Error('The SFTP session ended before it was ready.')));
    sftp.on('ready', onReady);
    sftp.on('error', onError);
    sftp.on('close', onClose);
    sftp._init();
  });
}
