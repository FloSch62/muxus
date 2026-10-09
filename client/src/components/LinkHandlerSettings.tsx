import { useCallback, useEffect, useState } from 'react';
import Button from '@mui/material/Button';
import type { ConnectionLinkScheme, LinkHandlerState, LinkHandlerStatus } from '@muxus/shared';
import { showToast } from '../state/toast.js';
import { SettingRow, SettingsGroup, StatusText } from './SettingsLayout.js';

const SCHEMES: ReadonlyArray<{ scheme: ConnectionLinkScheme; label: string }> = [
  { scheme: 'ssh', label: 'SSH links' },
  { scheme: 'telnet', label: 'Telnet links' },
];

function handlerStatus(
  scheme: ConnectionLinkScheme,
  state: LinkHandlerState | undefined,
  status: LinkHandlerStatus | undefined,
): React.ReactNode {
  if (!state || !status) return 'Checking which program opens them…';
  if (state.unavailable) return <StatusText tone="warning">{state.unavailable}</StatusText>;
  if (status.isDefault) {
    return <StatusText tone="success">Muxus opens {scheme}:// links.</StatusText>;
  }
  return (
    <StatusText tone="info">
      {status.currentHandler
        ? `${status.currentHandler} opens ${scheme}:// links now.`
        : `No program is set to open ${scheme}:// links.`}
    </StatusText>
  );
}

/**
 * Desktop only: make Muxus the system handler for ssh:// and telnet:// links.
 * Each row shows the current handler, since the choice changes a system default.
 */
export function LinkHandlerSettings() {
  const desktop = window.muxusDesktop;
  const [state, setState] = useState<LinkHandlerState>();
  const [busy, setBusy] = useState<ConnectionLinkScheme>();

  const refresh = useCallback(() => {
    void desktop?.getLinkHandlers?.().then(setState, () => undefined);
  }, [desktop]);

  useEffect(() => {
    refresh();
    // Another program or the system settings may take the links back meanwhile.
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);

  if (!desktop?.getLinkHandlers || !desktop.registerLinkHandler) return null;

  const register = (scheme: ConnectionLinkScheme) => {
    setBusy(scheme);
    void desktop
      .registerLinkHandler?.(scheme)
      .then((result) => {
        if (!result) return;
        setState(result.state);
        if (result.error) showToast('error', result.error);
        else if (result.openedSystemSettings) {
          showToast('info', `Choose Muxus for ${scheme.toUpperCase()} in the default apps settings that opened.`);
        } else showToast('success', `Muxus now opens ${scheme}:// links.`);
      })
      .catch(() => showToast('error', `Could not make Muxus the handler for ${scheme}:// links.`))
      .finally(() => setBusy(undefined));
  };

  return (
    <SettingsGroup
      title="Links"
      description="Open links such as ssh://admin@10.0.0.1:2222 from a browser, wiki or monitoring dashboard as a tab in Muxus. Choosing Muxus changes a system-wide default; pick another program in the system settings to undo it."
    >
      {SCHEMES.map(({ scheme, label }) => {
        const status = state?.[scheme];
        return (
          <SettingRow
            key={scheme}
            label={label}
            description={handlerStatus(scheme, state, status)}
            control={
              <Button
                size="small"
                variant="outlined"
                disabled={!state || !!state.unavailable || status?.isDefault || busy !== undefined}
                onClick={() => register(scheme)}
              >
                Use Muxus for {scheme}:// links
              </Button>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}
