/** Writes bytes to a session's transport; false when it cannot take input yet or any more. */
export type TerminalInputWriter = (data: Buffer) => boolean;

/**
 * Live terminal sessions the backend can type into, by terminal id. A writer
 * sends bytes straight to the session's transport, the way keystrokes travel,
 * but never through session logging: nothing written here reaches session
 * history or a log file unless the remote side echoes it.
 */
export class TerminalInputs {
  private readonly writers = new Map<string, TerminalInputWriter>();

  register(terminalId: string, writer: TerminalInputWriter): () => void {
    this.writers.set(terminalId, writer);
    return () => {
      if (this.writers.get(terminalId) === writer) this.writers.delete(terminalId);
    };
  }

  writer(terminalId: string): TerminalInputWriter | undefined {
    return this.writers.get(terminalId);
  }
}
