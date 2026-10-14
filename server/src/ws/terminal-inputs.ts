import type { TerminalEnterKey } from '@muxus/shared';

/** Writes bytes to a session's transport; false when it cannot take input yet or any more. */
export type TerminalInputWriter = (data: Buffer) => boolean;

/** A session to type into, with what Enter sends on its host. */
export interface TerminalInputTarget {
  write: TerminalInputWriter;
  enterKey: TerminalEnterKey;
}

/**
 * Live terminal sessions the backend can type into, by terminal id. A writer
 * sends bytes straight to the session's transport, the way keystrokes travel,
 * but never through session logging: nothing written here reaches session
 * history or a log file unless the remote side echoes it.
 */
export class TerminalInputs {
  private readonly inputs = new Map<
    string,
    { write: TerminalInputWriter; enterKey: () => TerminalEnterKey }
  >();

  /** `enterKey` is read each time text is typed, so a change to the host reaches open sessions. */
  register(
    terminalId: string,
    writer: TerminalInputWriter,
    enterKey: () => TerminalEnterKey = () => 'cr',
  ): () => void {
    const input = { write: writer, enterKey };
    this.inputs.set(terminalId, input);
    return () => {
      if (this.inputs.get(terminalId) === input) this.inputs.delete(terminalId);
    };
  }

  writer(terminalId: string): TerminalInputWriter | undefined {
    return this.inputs.get(terminalId)?.write;
  }

  target(terminalId: string): TerminalInputTarget | undefined {
    const input = this.inputs.get(terminalId);
    return input && { write: input.write, enterKey: input.enterKey() };
  }
}
