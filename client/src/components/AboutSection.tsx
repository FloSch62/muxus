import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import BugReportOutlinedIcon from '@mui/icons-material/BugReportOutlined';
import CachedOutlinedIcon from '@mui/icons-material/CachedOutlined';
import CoffeeOutlinedIcon from '@mui/icons-material/CoffeeOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import GitHubIcon from '@mui/icons-material/GitHub';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import NewReleasesOutlinedIcon from '@mui/icons-material/NewReleasesOutlined';
import StarBorderOutlinedIcon from '@mui/icons-material/StarBorderOutlined';
import type { UpdateCheckResult } from '@muxus/shared';
import { checkForUpdate } from '../api/app.js';
import { useAppInfo } from '../api/queries.js';
import {
  DOCS_URL,
  currentFactsEnvironment,
  installationFacts,
  releaseNotesUrl,
} from '../app-facts.js';
import { copyToClipboard } from '../clipboard.js';
import { usePrefsStore } from '../state/prefs.js';
import { showToast } from '../state/toast.js';
import { SettingRow, SettingsGroup, StatusText } from './SettingsLayout.js';

const LINKS = {
  source: 'https://github.com/FloSch62/muxus',
  issues: 'https://github.com/FloSch62/muxus/issues/new',
  license: 'https://github.com/FloSch62/muxus/blob/main/LICENSE',
  author: 'https://flosch.me/',
  authorGithub: 'https://github.com/FloSch62',
  authorLinkedIn: 'https://www.linkedin.com/in/florian-schwarz-812a34145/',
  coffee: 'https://www.buymeacoffee.com/FloSch62',
} as const;

/**
 * The About page of Settings: what this build is, where to read more, whether
 * a newer build exists, and who makes it. Every link opens in the system
 * browser (the desktop shell denies new windows and hands the URL to the OS).
 */
export function AboutSection() {
  const { data: info, isPending } = useAppInfo();
  const facts = installationFacts(info, currentFactsEnvironment());

  const copyDiagnostics = () => {
    const text = facts.map(([key, value]) => `${key}: ${value}`).join('\n');
    void copyToClipboard(text).then((ok) =>
      ok
        ? showToast('success', 'Diagnostics copied.')
        : showToast('error', 'Could not copy to the clipboard.'),
    );
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <AboutHero version={info?.version} loading={isPending} />

      <SettingsGroup title="Updates">
        <UpdateControls currentVersion={info?.version} />
      </SettingsGroup>

      <SettingsGroup
        title="This installation"
        action={
          <Button size="small" startIcon={<ContentCopyOutlinedIcon />} onClick={copyDiagnostics}>
            Copy diagnostics
          </Button>
        }
      >
        <Box
          component="dl"
          sx={{
            m: 0,
            px: 2,
            py: 1.25,
            display: 'grid',
            gridTemplateColumns: 'minmax(110px, max-content) 1fr',
            columnGap: 3,
            rowGap: 0.75,
          }}
        >
          {facts.map(([key, value]) => (
            <Box key={key} sx={{ display: 'contents' }}>
              <Typography component="dt" variant="body2" color="textSecondary">
                {key}
              </Typography>
              <Typography
                component="dd"
                variant="body2"
                sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}
              >
                {isPending && key === 'Version' ? <Skeleton width={60} /> : value}
              </Typography>
            </Box>
          ))}
        </Box>
      </SettingsGroup>

      <SettingsGroup title="Made by">
        <SettingRow
          label="FloSch"
          description="Muxus is built in the open, in my spare time. Bug reports, ideas and pull requests are always welcome."
        >
          <Typography variant="body2" sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
            <Link href={LINKS.author} target="_blank" rel="noreferrer">
              flosch.me
            </Link>
            <Link href={LINKS.authorGithub} target="_blank" rel="noreferrer">
              GitHub
            </Link>
            <Link href={LINKS.authorLinkedIn} target="_blank" rel="noreferrer">
              LinkedIn
            </Link>
          </Typography>
        </SettingRow>
        <SettingRow
          label="Support Muxus"
          description="Muxus is free and stays free. If it saves you time, a coffee keeps the releases coming."
          control={
            <>
              <Button
                variant="outlined"
                size="small"
                startIcon={<CoffeeOutlinedIcon />}
                href={LINKS.coffee}
                target="_blank"
                rel="noreferrer"
              >
                Buy me a coffee
              </Button>
              <Button
                size="small"
                startIcon={<StarBorderOutlinedIcon />}
                href={LINKS.source}
                target="_blank"
                rel="noreferrer"
              >
                Star on GitHub
              </Button>
            </>
          }
        />
      </SettingsGroup>

      <Typography variant="caption" color="textSecondary" sx={{ textAlign: 'center', mt: -0.5 }}>
        Released under the{' '}
        <Link href={LINKS.license} target="_blank" rel="noreferrer" color="inherit" underline="always">
          MIT license
        </Link>
        .
      </Typography>
    </Box>
  );
}

function AboutHero({ version, loading }: { version?: string; loading: boolean }) {
  return (
    <Box
      sx={(theme) => ({
        display: 'flex',
        gap: 2.5,
        alignItems: 'center',
        p: 2.5,
        border: 1,
        borderColor: 'divider',
        borderRadius: 2,
        // A soft wash of the logo's blue, fading out: the one decorative surface
        // on the page. Opaque stops: a translucent gradient repaints darker once
        // a sibling button animates (Chromium layer compositing).
        background: `linear-gradient(135deg, ${theme.palette.mode === 'dark' ? '#2a2d45' : '#eef2ff'} 0%, ${theme.palette.background.paper} 70%)`,
        flexWrap: { xs: 'wrap', sm: 'nowrap' },
      })}
    >
      <Box
        component="img"
        src="/muxus.svg"
        alt=""
        aria-hidden
        sx={{ width: 68, height: 68, objectFit: 'contain', flexShrink: 0 }}
      />
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Stack direction="row" spacing={1.25} sx={{ alignItems: 'baseline', flexWrap: 'wrap' }}>
          <Typography
            component="h2"
            sx={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.2 }}
          >
            Muxus
          </Typography>
          <Typography variant="body2" color="textSecondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {version ? (
              `Version ${version}`
            ) : loading ? (
              <Skeleton width={90} sx={{ display: 'inline-block' }} />
            ) : null}
          </Typography>
        </Stack>
        <Typography variant="body2" color="textSecondary" sx={{ mt: 0.5, maxWidth: 520 }}>
          A free, open-source SSH, Telnet and serial client with RDP and VNC remote desktops. Split
          panes, saved workspaces, SFTP, a remote editor, saved tunnels and images in the terminal.
        </Typography>
        <Stack direction="row" useFlexGap sx={{ mt: 1.75, flexWrap: 'wrap', gap: 1 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<MenuBookOutlinedIcon />}
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
          >
            Documentation
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<NewReleasesOutlinedIcon />}
            href={releaseNotesUrl(version)}
            target="_blank"
            rel="noreferrer"
          >
            Release notes
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<GitHubIcon />}
            href={LINKS.source}
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<BugReportOutlinedIcon />}
            href={LINKS.issues}
            target="_blank"
            rel="noreferrer"
          >
            Report an issue
          </Button>
        </Stack>
      </Box>
    </Box>
  );
}

function UpdateControls({ currentVersion }: { currentVersion?: string }) {
  const notifyOnNewVersion = usePrefsStore((s) => s.notifyOnNewVersion);
  const setPrefs = usePrefsStore((s) => s.set);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  const checkForUpdates = () => {
    setChecking(true);
    setResult(null);
    void checkForUpdate({ force: true })
      .then(setResult)
      .catch(() => setResult({ available: false, currentVersion: currentVersion ?? '', reason: 'network' }))
      .finally(() => setChecking(false));
  };

  const updatesAvailable = result?.available === true;
  const status = checking ? (
    'Checking GitHub for the latest release…'
  ) : updatesAvailable ? (
    <StatusText tone="info">
      Muxus {result.latestVersion} is available. You are running {result.currentVersion}.
    </StatusText>
  ) : result?.available === false && result.latestVersion ? (
    <StatusText tone="success">Muxus is up to date. Latest release: {result.latestVersion}.</StatusText>
  ) : result ? (
    <StatusText tone={result.reason === 'store' ? 'info' : 'warning'}>
      {updateReasonLabel(result.reason)}
    </StatusText>
  ) : (
    'Looks for a newer release on GitHub when you ask.'
  );

  return (
    <>
      <SettingRow
        label="Notify me when a new version is available"
        labelFor="settings-notify-new-version"
        description="Checks once at startup. Off: no notification, and checking here still works."
        control={
          <Switch
            id="settings-notify-new-version"
            size="small"
            checked={notifyOnNewVersion}
            onChange={(e) => setPrefs({ notifyOnNewVersion: e.target.checked })}
          />
        }
      />
      <SettingRow
        label="Update check"
        description={status}
        control={
          <>
            {updatesAvailable ? (
              <Button
                variant="contained"
                size="small"
                startIcon={<DownloadOutlinedIcon />}
                href={result.releaseUrl}
                target="_blank"
                rel="noreferrer"
              >
                Download
              </Button>
            ) : null}
            <Button
              variant={updatesAvailable ? 'outlined' : 'contained'}
              size="small"
              startIcon={checking ? <CircularProgress color="inherit" size={14} /> : <CachedOutlinedIcon />}
              disabled={checking}
              onClick={checkForUpdates}
            >
              Check for updates
            </Button>
          </>
        }
      />
    </>
  );
}

function updateReasonLabel(reason?: string): string {
  switch (reason) {
    case 'store':
      return 'Microsoft Store manages updates for this installation.';
    case 'store-open-failed':
      return 'Open Microsoft Store to check for Muxus updates.';
    case 'timeout':
      return 'The update check timed out.';
    case 'network':
      return 'The update check could not reach GitHub.';
    case 'no-release':
      return 'No published release was found.';
    case 'missing-version':
    case 'missing-release-url':
      return 'The latest release metadata is incomplete.';
    default:
      return reason?.startsWith('manifest-')
        ? `The update manifest returned ${reason.replace('manifest-', '')}.`
        : 'The update check could not be completed.';
  }
}
