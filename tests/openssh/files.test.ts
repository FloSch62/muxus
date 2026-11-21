import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { SFTP_NO_SUCH_FILE, SshError, type SftpClient } from '../../server/src/ssh/engine.js';
import { fixture, inContainer, recordingIo, ssh, useScratchHome } from './harness.js';

const ALICE = ['User alice', 'IdentitiesOnly yes', `IdentityFile ${fixture('id_ed25519')}`];
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function download(sftp: SftpClient, file: string, start = 0): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of sftp.createReadStream(await sftp.open(file, 'r'), { start })) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe('files over SFTP on OpenSSH', () => {
  const home = useScratchHome();

  async function browser() {
    const lease = await home.manager({ box: ALICE }).connect(ssh('box'), recordingIo().io, 'sftp');
    return { lease, sftp: await lease.connection.sftp() };
  }

  it('uploads and downloads a large file intact, and continues one from where it stopped', async () => {
    const { lease, sftp } = await browser();
    const content = randomBytes(24 * 1024 * 1024 + 123);
    const file = '/home/alice/large-upload.bin';
    // Fed in pieces of uneven size, as a browser's request body arrives.
    const pieces = function* () {
      for (let at = 0, size = 1; at < content.length; at += size, size = (size * 7) % 200_000 + 1) {
        yield content.subarray(at, at + size);
      }
    };
    await pipeline(Readable.from(pieces()), sftp.createWriteStream(await sftp.open(file, 'wx', 0o640)));

    expect(inContainer('sha256sum', file).split(' ')[0]).toBe(sha256(content));
    const attrs = await sftp.stat(file);
    expect(attrs.size).toBe(content.length);
    expect(attrs.isFile()).toBe(true);
    expect((attrs.mode ?? 0) & 0o777).toBe(0o640);

    expect(sha256(await download(sftp, file))).toBe(sha256(content));
    const from = 20_000_000;
    expect((await download(sftp, file, from)).equals(content.subarray(from))).toBe(true);
    // Past the end there is nothing, not an error.
    expect((await download(sftp, file, content.length)).length).toBe(0);

    // The rest of an interrupted upload goes in at its offset, through the same handle.
    const partial = '/home/alice/partial.bin';
    await sftp.writeFile(partial, content.subarray(0, 1_000_000), 0o600);
    const handle = await sftp.open(partial, 'r+');
    await pipeline(
      Readable.from([content.subarray(1_000_000, 3_000_000)]),
      sftp.createWriteStream(handle, { start: 1_000_000, autoClose: false }),
    );
    expect((await sftp.fstat(handle)).size).toBe(3_000_000);
    expect((await sftp.read(handle, 2_999_990, 100))?.equals(content.subarray(2_999_990, 3_000_000))).toBe(true);
    expect(await sftp.read(handle, 3_000_000, 100)).toBeUndefined();
    await sftp.closeHandle(handle);
    lease.release();
  }, 60_000);

  it('lists, creates, renames and removes, and says what the server refused', async () => {
    const { lease, sftp } = await browser();
    expect(await sftp.realpath('.')).toBe('/home/alice');
    await sftp.mkdir('/home/alice/work', 0o700);
    await sftp.writeFile('/home/alice/work/notes.txt', 'first\n', 0o600);
    await sftp.writeFile('/home/alice/work/other.txt', 'second\n', 0o600);
    inContainer('ln', '-s', 'notes.txt', '/home/alice/work/link');

    const listing = await sftp.readdir('/home/alice/work');
    const byName = Object.fromEntries(listing.map((entry) => [entry.filename, entry]));
    expect(Object.keys(byName).sort()).toEqual(['.', '..', 'link', 'notes.txt', 'other.txt']);
    expect(byName['notes.txt']!.attrs.isFile()).toBe(true);
    expect(byName['notes.txt']!.attrs.size).toBe(6);
    expect(byName['link']!.attrs.isSymbolicLink()).toBe(true);
    expect(byName['.']!.attrs.isDirectory()).toBe(true);
    // Owner and group for the file panel come from the server's `ls -l` line.
    expect(byName['notes.txt']!.longname).toMatch(/alice\s+alice/);
    // A link is followed by stat and seen by lstat.
    expect((await sftp.stat('/home/alice/work/link')).isFile()).toBe(true);
    expect((await sftp.lstat('/home/alice/work/link')).isSymbolicLink()).toBe(true);

    // The protocol's own rename will not replace a file; OpenSSH's does, in one step.
    await expect(sftp.rename('/home/alice/work/other.txt', '/home/alice/work/notes.txt')).rejects.toMatchObject({
      code: 'SFTP_STATUS',
    });
    await sftp.posixRename('/home/alice/work/other.txt', '/home/alice/work/notes.txt');
    expect((await download(sftp, '/home/alice/work/notes.txt')).toString()).toBe('second\n');

    const missing = await sftp.stat('/home/alice/work/other.txt').catch((err: unknown) => err);
    expect(missing).toBeInstanceOf(SshError);
    expect(missing).toMatchObject({ code: 'SFTP_STATUS', detail: SFTP_NO_SUCH_FILE, message: 'No such file' });
    await expect(sftp.open('/root/not-allowed', 'w')).rejects.toMatchObject({ code: 'SFTP_STATUS', detail: 3 });
    await expect(sftp.rmdir('/home/alice/work')).rejects.toMatchObject({ code: 'SFTP_STATUS' });

    await sftp.unlink('/home/alice/work/link');
    await sftp.unlink('/home/alice/work/notes.txt');
    await sftp.rmdir('/home/alice/work');
    await expect(sftp.lstat('/home/alice/work')).rejects.toMatchObject({ detail: SFTP_NO_SUCH_FILE });
    lease.release();
  });

  it('gives a new file the mode asked for less the umask, and an open one exactly what is set', async () => {
    const { lease, sftp } = await browser();
    const handle = await sftp.open('/home/alice/modes.txt', 'wx', 0o666);
    // Never more than was asked for, and the server's umask took at least others' write bit.
    const created = ((await sftp.fstat(handle)).mode ?? 0) & 0o777;
    expect(created & ~0o666).toBe(0);
    expect(created & 0o002).toBe(0);
    // Setting it on the open file puts that bit back: no umask applies there.
    await sftp.fchmod(handle, 0o606);
    expect(((await sftp.fstat(handle)).mode ?? 0) & 0o777).toBe(0o606);
    await sftp.closeHandle(handle);
    await expect(sftp.open('/home/alice/modes.txt', 'wx')).rejects.toMatchObject({ code: 'SFTP_STATUS' });
    lease.release();
  });

  it('fails what is waiting when the connection goes, and starts a new session on the next connection', async () => {
    const manager = home.manager({ box: ['User kbd'] });
    const lease = await manager.connect(ssh('box'), recordingIo([['kbd-pass']]).io, 'sftp');
    const sftp = await lease.connection.sftp();
    expect(await sftp.realpath('.')).toBe('/home/kbd');
    const ended = new Promise<void>((resolve) => sftp.onClose(resolve));
    const lost = new Promise<void>((resolve) => lease.connection.onClose(() => resolve()));
    inContainer('pkill', '-u', 'kbd');
    await ended;
    await lost;
    expect(sftp.closed).toBe(true);
    await expect(sftp.realpath('.')).rejects.toMatchObject({ code: 'SFTP_CLOSED' });
    lease.release();

    const again = await manager.connect(ssh('box'), recordingIo([['kbd-pass']]).io, 'sftp');
    expect(await (await again.connection.sftp()).realpath('.')).toBe('/home/kbd');
    again.release();
  });
});
