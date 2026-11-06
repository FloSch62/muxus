import { useEffect, useState } from 'react';
import { setWindowPromptHost, type WindowPrompt } from '../dial-prompts.js';
import { AuthPromptDialog } from './AuthPromptDialog.js';
import { HostKeyDialog } from './HostKeyDialog.js';

/**
 * Answers sign-in and host-key prompts for connections opened outside a
 * tab, from anywhere in the window. Several hosts may ask at once; their
 * questions queue and are shown one at a time. A prompt whose dial gave up
 * leaves the queue without being shown.
 */
export function WindowDialPrompts() {
  const [queue, setQueue] = useState<WindowPrompt[]>([]);

  useEffect(() => {
    setWindowPromptHost((prompt) => {
      setQueue((current) => [...current, prompt]);
      return () => setQueue((current) => current.filter((item) => item !== prompt));
    });
    return () => setWindowPromptHost(undefined);
  }, []);

  const current = queue[0];
  const done = () => setQueue((items) => items.filter((item) => item !== current));
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
