import { beforeEach, describe, expect, it } from 'vitest';
import { useToastStore } from '../../../client/src/state/toast.js';
import {
  CONNECTION_LOST,
  reportStoppedTransfer,
  TRANSFER_CANCELLED,
} from '../../../client/src/transfer-progress.js';

const messages = { cancelled: 'Upload cancelled', connectionLost: 'Upload stopped: connection lost' };
// What an aborted upload rejects with, whatever the reason.
const aborted = new DOMException('Transfer cancelled', 'AbortError');

function abortedSignal(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

const toast = () => useToastStore.getState().toast;

describe('a stopped transfer', () => {
  beforeEach(() => {
    useToastStore.setState({ toast: null });
  });

  it('reads as cancelled only after Cancel', () => {
    reportStoppedTransfer(aborted, abortedSignal(TRANSFER_CANCELLED), messages);
    expect(toast()).toMatchObject({ severity: 'info', message: 'Upload cancelled' });
  });

  it('says nothing when its file browser closed', () => {
    reportStoppedTransfer(aborted, abortedSignal(), messages);
    expect(toast()).toBeNull();
  });

  it('says so when the connection was lost', () => {
    reportStoppedTransfer(aborted, abortedSignal(CONNECTION_LOST), messages);
    expect(toast()).toMatchObject({ severity: 'error', message: 'Upload stopped: connection lost' });
  });

  it('shows a failure, also one that arrives as the browser closes', () => {
    reportStoppedTransfer(new Error('permission denied'), new AbortController().signal, messages);
    expect(toast()).toMatchObject({ severity: 'error', message: 'permission denied' });

    reportStoppedTransfer(new Error('no program opens this file'), abortedSignal(), messages);
    expect(toast()).toMatchObject({ severity: 'error', message: 'no program opens this file' });

    // An AbortError the transfer did not ask for is a failure too.
    reportStoppedTransfer(new DOMException('The user aborted a request.', 'AbortError'), new AbortController().signal, messages);
    expect(toast()).toMatchObject({ severity: 'error', message: 'The user aborted a request.' });
  });
});
