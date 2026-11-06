import { useEffect, useState } from 'react';
import { setWindowDialHandlers } from '../dial-prompts.js';
import { AuthPromptDialog, type AuthPromptRequest, type AuthPromptResult } from './AuthPromptDialog.js';
import { HostKeyDialog, type HostKeyRequest } from './HostKeyDialog.js';

type Pending =
  | { kind: 'auth'; request: AuthPromptRequest; resolve: (result: AuthPromptResult | null) => void }
  | { kind: 'host-key'; request: HostKeyRequest; resolve: (accept: boolean) => void };

/**
 * Answers sign-in and host-key prompts for connections opened outside a
 * tab, from anywhere in the window. Several hosts may ask at once; their
 * questions queue and are shown one at a time.
 */
export function WindowDialPrompts() {
  const [queue, setQueue] = useState<Pending[]>([]);

  useEffect(() => {
    const enqueue = (item: Pending) => setQueue((current) => [...current, item]);
    setWindowDialHandlers({
      onAuthPrompt: (request) => new Promise((resolve) => enqueue({ kind: 'auth', request, resolve })),
      onHostKey: (request) => new Promise((resolve) => enqueue({ kind: 'host-key', request, resolve })),
    });
    return () => setWindowDialHandlers(undefined);
  }, []);

  const current = queue[0];
  const done = () => setQueue((items) => items.slice(1));
  return (
    <>
      <AuthPromptDialog
        request={current?.kind === 'auth' ? current.request : null}
        onSubmit={(result) => {
          if (current?.kind === 'auth') current.resolve(result);
          done();
        }}
      />
      <HostKeyDialog
        request={current?.kind === 'host-key' ? current.request : null}
        onAnswer={(accept) => {
          if (current?.kind === 'host-key') current.resolve(accept);
          done();
        }}
      />
    </>
  );
}
