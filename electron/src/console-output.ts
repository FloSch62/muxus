/**
 * Nobody reads the console once the program or terminal on the other end has
 * gone (EPIPE, or EIO from a closed terminal); a failed write must not become
 * an uncaught exception, which Electron shows as a modal dialog.
 */
export function ignoreClosedConsole(
  streams: readonly NodeJS.WritableStream[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) stream.on('error', () => undefined);
}
