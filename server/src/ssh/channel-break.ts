import type { ClientChannel } from 'ssh2';
// ssh2 has no helper for RFC 4335 `break`, so the request is framed like its
// own channel requests and sent through the same rekey-aware packet path. A
// static import keeps this internal module in the Electron bundle.
// @ts-expect-error -- no declaration exists for this ssh2 internal module.
import protocolUtils from 'ssh2/lib/protocol/utils.js';

const SSH_MSG_CHANNEL_REQUEST = 98;
const BREAK_REQUEST = Buffer.from('break', 'ascii');
/** Long enough for a console server that answers only after holding the break. */
const REPLY_GRACE_MS = 5_000;

interface PacketWriter {
  allocStart: number;
  alloc(size: number): Buffer;
  finalize(packet: Buffer): Buffer;
}

interface ChannelInternals {
  outgoing: { id: number; state: string };
  /** Replies to want-reply channel requests, answered in the order they were sent. */
  _callbacks: Array<(failed: unknown) => void>;
  _client: { _protocol: { _packetRW: { write: PacketWriter } } };
}

const { sendPacket } = protocolUtils as {
  sendPacket: (protocol: unknown, packet: Buffer) => boolean;
};

/** `refused`: SSH_MSG_CHANNEL_FAILURE; `unanswered`: no reply within the grace period. */
export type ChannelBreakResult = 'accepted' | 'refused' | 'unanswered';

/**
 * Send RFC 4335 `break` on a session channel with want-reply set, so a server
 * that cannot pass the BREAK on (OpenSSH without a pty, for one) says so.
 */
export function requestChannelBreak(
  channel: ClientChannel,
  durationMs: number,
  replyGraceMs = REPLY_GRACE_MS,
): Promise<ChannelBreakResult> {
  const internals = channel as unknown as ChannelInternals;
  if (internals.outgoing.state !== 'open') {
    return Promise.reject(new Error('the SSH channel is closed'));
  }
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: ChannelBreakResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Some servers never answer a request they do not know. The callback stays
    // queued anyway, so a late reply still lines up with the request it answers.
    const timer = setTimeout(() => settle('unanswered'), durationMs + replyGraceMs);
    internals._callbacks.push((failed) => settle(failed ? 'refused' : 'accepted'));

    const protocol = internals._client._protocol;
    const writer = protocol._packetRW.write;
    let offset = writer.allocStart;
    const packet = writer.alloc(1 + 4 + 4 + BREAK_REQUEST.length + 1 + 4);
    packet[offset] = SSH_MSG_CHANNEL_REQUEST;
    packet.writeUInt32BE(internals.outgoing.id, ++offset);
    packet.writeUInt32BE(BREAK_REQUEST.length, (offset += 4));
    BREAK_REQUEST.copy(packet, (offset += 4));
    packet[(offset += BREAK_REQUEST.length)] = 1;
    packet.writeUInt32BE(durationMs, ++offset);
    sendPacket(protocol, writer.finalize(packet));
  });
}
