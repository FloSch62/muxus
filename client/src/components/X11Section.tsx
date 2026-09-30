import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Switch from '@mui/material/Switch';
import type { X11Status } from '@muxus/shared';
import { useAppInfo } from '../api/queries.js';
import { useX11Status } from '../api/x11.js';
import { usePrefsStore } from '../state/prefs.js';
import { SettingRow, SettingsGroup, SettingsPage } from './SettingsLayout.js';

const XQUARTZ_URL = 'https://www.xquartz.org';

const DESCRIPTION =
  'Graphical programs started in SSH sessions open their windows on this computer.';

/**
 * Application-wide X11 forwarding: the master switch (off by default on
 * macOS, which needs XQuartz first), the default for hosts without their own
 * ForwardX11, and clipboard sharing for the X server built into Windows.
 */
export function X11Section() {
  const status = useX11Status().data;
  const platform = useAppInfo().data?.platform;
  const x11Enabled = usePrefsStore((s) => s.x11Enabled);
  const x11ForwardByDefault = usePrefsStore((s) => s.x11ForwardByDefault);
  const x11ClipboardSharing = usePrefsStore((s) => s.x11ClipboardSharing);
  const set = usePrefsStore((s) => s.set);

  if (!status) {
    return (
      <SettingsPage title="X11 forwarding" description={DESCRIPTION}>
        <Skeleton variant="rounded" height={88} />
        <Skeleton variant="rounded" height={72} />
      </SettingsPage>
    );
  }
  const enabled = x11Enabled ?? status.defaults.enabled;
  const forwardByDefault = x11ForwardByDefault ?? status.defaults.forwardByDefault;

  return (
    <SettingsPage title="X11 forwarding" description={DESCRIPTION}>
      <SettingsGroup>
        <SettingRow
          label="Enable X11 forwarding"
          labelFor="settings-x11-enabled"
          description="Off: Muxus never requests X11, whatever a host's ForwardX11 says, and shows no X11 hints."
          control={
            <Switch
              id="settings-x11-enabled"
              size="small"
              checked={enabled}
              onChange={(e) => set({ x11Enabled: e.target.checked })}
            />
          }
        >
          {enabled ? <ServerStatus status={status} platform={platform} /> : null}
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup title="Defaults">
        <SettingRow
          label="Forward X11 by default"
          labelFor="settings-x11-default"
          disabled={!enabled}
          description={
            status.source === 'bundled'
              ? 'Hosts whose ForwardX11 is unset forward X11 to the built-in X server, where each connection gets its own display. A host’s own setting always wins.'
              : 'Hosts whose ForwardX11 is unset forward X11 to your display. Forwarded programs can watch your other X11 windows, so turning X11 on per host is safer. A host’s own setting always wins.'
          }
          control={
            <Switch
              id="settings-x11-default"
              size="small"
              disabled={!enabled}
              checked={forwardByDefault}
              onChange={(e) => set({ x11ForwardByDefault: e.target.checked })}
            />
          }
        />
        {status.source === 'bundled' ? (
          <SettingRow
            label="Share the clipboard with X11 apps"
            labelFor="settings-x11-clipboard"
            disabled={!enabled}
            description="Copy and paste between forwarded windows and Windows. Every server you connect to with X11 forwarding can then read and replace your clipboard, so turn this on only if you trust all of them. Applies to a connection once it has no forwarded windows open."
            control={
              <Switch
                id="settings-x11-clipboard"
                size="small"
                disabled={!enabled}
                checked={x11ClipboardSharing}
                onChange={(e) => set({ x11ClipboardSharing: e.target.checked })}
              />
            }
          />
        ) : null}
      </SettingsGroup>
    </SettingsPage>
  );
}

function ServerStatus({ status, platform }: { status: X11Status; platform?: string }) {
  if (status.source === 'bundled') {
    return (
      <Alert severity="success" variant="outlined" sx={{ mt: 1.25 }}>
        Built-in X server. Each SSH connection gets its own display, started when a program
        opens its first window.
      </Alert>
    );
  }
  if (status.source === 'display') {
    return (
      <Alert severity="success" variant="outlined" sx={{ mt: 1.25 }}>
        {platform === 'darwin' ? 'XQuartz' : 'Your X server'} on display{' '}
        <code>{status.display}</code>.
      </Alert>
    );
  }
  return (
    <Alert severity="warning" variant="outlined" sx={{ mt: 1.25 }}>
      {platform === 'darwin' ? (
        <>
          No X server found. Install{' '}
          <Link href={XQUARTZ_URL} target="_blank" rel="noreferrer">
            XQuartz
          </Link>
          , then log out and back in.
        </>
      ) : platform === 'win32' ? (
        'This Muxus build has no built-in X server. Set DISPLAY to use your own X server.'
      ) : (
        'No X server found. Start Muxus from a graphical session so that DISPLAY is set.'
      )}
    </Alert>
  );
}
