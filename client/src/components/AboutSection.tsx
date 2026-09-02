import { Fragment, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import CachedOutlinedIcon from '@mui/icons-material/CachedOutlined';
import CoffeeOutlinedIcon from '@mui/icons-material/CoffeeOutlined';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import StarBorderOutlinedIcon from '@mui/icons-material/StarBorderOutlined';
import type { UpdateCheckResult } from '@muxus/shared';
import { checkForUpdate } from '../api/app.js';
import { useAppInfo } from '../api/queries.js';
import { usePrefsStore } from '../state/prefs.js';

const LINKS = {
  docs: 'https://flosch62.github.io/muxus/',
  source: 'https://github.com/FloSch62/muxus',
  releases: 'https://github.com/FloSch62/muxus/releases',
  author: 'https://flosch.me/',
  authorGithub: 'https://github.com/FloSch62',
  authorLinkedIn: 'https://www.linkedin.com/in/florian-schwarz-812a34145/',
  coffee: 'https://www.buymeacoffee.com/FloSch62',
} as const;

/**
 * The About page of Settings: what this build is, who makes it, how to support
 * the work, and whether a newer build exists. Every link opens in the system
 * browser (the desktop shell denies new windows and hands the URL to the OS).
 */
export function AboutSection() {
  const { data: info } = useAppInfo();

  return (
    <Stack spacing={3}>
      <Box>
        <SectionTitle>About</SectionTitle>
        <Stack spacing={1.25}>
          <Typography variant="body2">
            {[`Muxus ${info?.version ?? ''}`.trim(), platformLabel(info?.platform), 'MIT license']
              .filter(Boolean)
              .join(' · ')}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            A free, open-source SSH, Telnet and serial client. Split panes, saved workspaces, SFTP,
            a remote editor, saved tunnels and images in the terminal.
          </Typography>
          <LinkRow
            links={[
              ['Documentation', LINKS.docs],
              ['Source', LINKS.source],
              ['Releases', LINKS.releases],
            ]}
          />
        </Stack>
      </Box>

      <Box>
        <SectionTitle>Made by</SectionTitle>
        <Stack spacing={1.25}>
          <Typography variant="body2" color="text.secondary">
            Muxus is built by me (FloSch), in the open and in my spare time. Bug reports, ideas
            and pull requests are always welcome.
          </Typography>
          <LinkRow
            links={[
              ['flosch.me', LINKS.author],
              ['GitHub', LINKS.authorGithub],
              ['LinkedIn', LINKS.authorLinkedIn],
            ]}
          />
        </Stack>
      </Box>

      <Box>
        <SectionTitle>Support</SectionTitle>
        <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <Typography variant="body2" color="text.secondary">
            Muxus is free and stays free. If it saves you time, a coffee keeps the releases coming.
          </Typography>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Button
              variant="outlined"
              startIcon={<CoffeeOutlinedIcon />}
              href={LINKS.coffee}
              target="_blank"
              rel="noreferrer"
            >
              Buy me a coffee
            </Button>
            <Button startIcon={<StarBorderOutlinedIcon />} href={LINKS.source} target="_blank" rel="noreferrer">
              Star on GitHub
            </Button>
          </Stack>
        </Stack>
      </Box>

      <Box>
        <SectionTitle>Updates</SectionTitle>
        <UpdateControls currentVersion={info?.version} />
      </Box>
    </Stack>
  );
}

function UpdateControls({ currentVersion }: { currentVersion?: string }) {
  const prefs = usePrefsStore();
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

  return (
    <Stack spacing={1.5} sx={{ alignItems: 'flex-start' }}>
      <FormControlLabel
        control={
          <Switch
            size="small"
            checked={prefs.notifyOnNewVersion}
            onChange={(e) => prefs.set({ notifyOnNewVersion: e.target.checked })}
          />
        }
        label={
          <Box>
            <Typography variant="body2">Notify me when a new version is available</Typography>
            <Typography variant="caption" color="text.secondary">
              Off: no notification at startup — checking here still works.
            </Typography>
          </Box>
        }
      />
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <Button
          variant="contained"
          startIcon={checking ? <CircularProgress color="inherit" size={16} /> : <CachedOutlinedIcon />}
          disabled={checking}
          onClick={checkForUpdates}
        >
          Check for updates
        </Button>
        {updatesAvailable ? (
          <Button startIcon={<DownloadOutlinedIcon />} href={result.releaseUrl} target="_blank" rel="noreferrer">
            Download
          </Button>
        ) : null}
      </Stack>
      {result?.available === false && result.latestVersion ? (
        <Alert severity="success" variant="outlined">
          Muxus is up to date. Latest release: {result.latestVersion}.
        </Alert>
      ) : null}
      {result?.available === false && !result.latestVersion ? (
        <Alert severity="warning" variant="outlined">
          {updateReasonLabel(result.reason)}
        </Alert>
      ) : null}
      {updatesAvailable ? (
        <Alert severity="info" variant="outlined">
          Muxus {result.latestVersion} is available. You are running {result.currentVersion}.
        </Alert>
      ) : null}
    </Stack>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1.5 }}>
      {children}
    </Typography>
  );
}

/** A row of plain links, the way the rest of the dialog points elsewhere. */
function LinkRow({ links }: { links: ReadonlyArray<readonly [label: string, href: string]> }) {
  return (
    <Typography variant="body2" sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1 }}>
      {links.map(([label, href], index) => (
        <Fragment key={href}>
          {index > 0 ? (
            <Box component="span" aria-hidden sx={{ color: 'text.disabled' }}>
              ·
            </Box>
          ) : null}
          <Link href={href} target="_blank" rel="noreferrer">
            {label}
          </Link>
        </Fragment>
      ))}
    </Typography>
  );
}

function platformLabel(platform?: string): string {
  switch (platform) {
    case 'darwin':
      return 'macOS';
    case 'win32':
      return 'Windows';
    case 'linux':
      return 'Linux';
    default:
      return platform ?? '';
  }
}

function updateReasonLabel(reason?: string): string {
  switch (reason) {
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
