import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import type { X11Status } from '@muxus/shared';
import { useAppInfo } from '../api/queries.js';
import { useX11Status } from '../api/x11.js';
import { usePrefsStore } from '../state/prefs.js';

const XQUARTZ_URL = 'https://www.xquartz.org';

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
      <Typography variant="body2" color="text.secondary">
        Checking for an X server…
      </Typography>
    );
  }
  const enabled = x11Enabled ?? status.defaults.enabled;
  const forwardByDefault = x11ForwardByDefault ?? status.defaults.forwardByDefault;

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>X11 forwarding</SectionTitle>
        <Stack spacing={1.5}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={enabled}
                onChange={(e) => set({ x11Enabled: e.target.checked })}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Enable X11 forwarding</Typography>
                <Typography variant="caption" color="text.secondary">
                  Graphical programs started in SSH sessions open their windows on this
                  computer. Off: Muxus never requests X11, whatever a host&apos;s ForwardX11
                  says, and shows no X11 hints.
                </Typography>
              </Box>
            }
          />
          {enabled ? <ServerStatus status={status} platform={platform} /> : null}
        </Stack>
      </Box>
      <Box>
        <SectionTitle>Hosts without their own setting</SectionTitle>
        <FormControlLabel
          disabled={!enabled}
          control={
            <Switch
              size="small"
              checked={forwardByDefault}
              onChange={(e) => set({ x11ForwardByDefault: e.target.checked })}
            />
          }
          label={
            <Box>
              <Typography variant="body2">Forward X11 by default</Typography>
              <Typography variant="caption" color="text.secondary">
                {status.source === 'bundled'
                  ? 'Hosts whose ForwardX11 is unset forward X11 to the built-in X server, where each connection gets its own display. A host’s own setting always wins.'
                  : 'Hosts whose ForwardX11 is unset forward X11 to your display. Forwarded programs can watch your other X11 windows, so turning X11 on per host is safer. A host’s own setting always wins.'}
              </Typography>
            </Box>
          }
        />
      </Box>
      {status.source === 'bundled' ? (
        <Box>
          <SectionTitle>Clipboard</SectionTitle>
          <FormControlLabel
            disabled={!enabled}
            control={
              <Switch
                size="small"
                checked={x11ClipboardSharing}
                onChange={(e) => set({ x11ClipboardSharing: e.target.checked })}
              />
            }
            label={
              <Box>
                <Typography variant="body2">Share the clipboard with X11 apps</Typography>
                <Typography variant="caption" color="text.secondary">
                  Copy and paste between forwarded windows and Windows. Every server you
                  connect to with X11 forwarding can then read and replace your clipboard, so
                  turn this on only if you trust all of them. Applies to a connection once it
                  has no forwarded windows open.
                </Typography>
              </Box>
            }
          />
        </Box>
      ) : null}
    </Stack>
  );
}

function ServerStatus({ status, platform }: { status: X11Status; platform?: string }) {
  if (status.source === 'bundled') {
    return (
      <Alert severity="success" variant="outlined">
        Built-in X server. Each SSH connection gets its own display, started when a program
        opens its first window.
      </Alert>
    );
  }
  if (status.source === 'display') {
    return (
      <Alert severity="success" variant="outlined">
        {platform === 'darwin' ? 'XQuartz' : 'Your X server'} on display{' '}
        <code>{status.display}</code>.
      </Alert>
    );
  }
  return (
    <Alert severity="warning" variant="outlined">
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

function SectionTitle({ children }: { children: string }) {
  return (
    <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
      {children}
    </Typography>
  );
}
