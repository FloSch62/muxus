import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import TimerOutlinedIcon from '@mui/icons-material/TimerOutlined';
import { confirmAction, promptForText } from '../../state/dialogs.js';
import { defaultNetconfDraft, type NetconfDraft } from '../../management/requests.js';
import { useWorkbench, useWorkbenchState } from './context.js';
import { ReviewDialog, type ReviewSection } from './ReviewDialog.js';

function countdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * The NETCONF candidate at a glance: whether it holds uncommitted changes,
 * a confirmed commit that will roll back, and the locks this session holds,
 * with the actions each state calls for one click away.
 */
export function CandidateBar() {
  const { controller, connected } = useWorkbench();
  const candidate = useWorkbenchState((state) => state.candidate);
  const deadline = useWorkbenchState((state) => state.confirmDeadline);
  const locks = useWorkbenchState((state) => state.locks);
  const [now, setNow] = useState(() => Date.now());
  const [review, setReview] = useState<{ sections: ReviewSection[]; loading: boolean; error?: string } | null>(null);
  const supported = controller.hasCapability(':candidate');
  const confirmable = controller.hasCapability(':confirmed-commit');

  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline]);

  if (!supported || !connected) return null;
  const pending = deadline !== undefined && deadline > now;
  const dirty = candidate?.dirty === true;
  if (!dirty && !pending && locks.length === 0 && !candidate?.checking) return null;

  const run = (patch: Partial<NetconfDraft>) => controller.run({ ...defaultNetconfDraft(), ...patch });

  const openReview = async () => {
    setReview({ sections: [], loading: true });
    const texts = await controller.checkCandidate();
    if (!texts) {
      setReview({ sections: [], loading: false, error: 'Could not read the running and candidate configurations.' });
      return;
    }
    setReview({
      sections: [{ label: 'running → candidate', original: texts.running, modified: texts.candidate, language: 'xml' }],
      loading: false,
    });
  };

  const commit = async (confirmed: boolean) => {
    if (confirmed) {
      const seconds = await promptForText({
        title: 'Confirmed commit',
        description: 'The change goes live now and rolls back on its own unless you confirm it in time — a safety net for changes that could cut you off.',
        label: 'Roll back after (seconds)',
        initialValue: '120',
        confirmLabel: 'Commit',
        validate: (value) => (/^\d+$/.test(value.trim()) && Number(value) > 0 ? null : 'Enter a number of seconds.'),
      });
      if (!seconds) return;
      run({ operation: 'commit', confirmed: true, confirmTimeout: Number(seconds) });
      return;
    }
    run({ operation: 'commit' });
  };

  return (
    <>
      <Stack
        direction="row"
        spacing={1}
        useFlexGap
        sx={(theme) => ({
          alignItems: 'center',
          flexWrap: 'wrap',
          px: 1.5,
          py: 0.5,
          minHeight: 38,
          flexShrink: 0,
          borderBottom: 1,
          borderColor: 'divider',
          bgcolor: pending
            ? alpha(theme.palette.warning.main, 0.14)
            : dirty
              ? alpha(theme.palette.info.main, 0.1)
              : 'transparent',
        })}
      >
        {pending ? (
          <>
            <TimerOutlinedIcon sx={{ fontSize: 18, color: 'warning.main' }} />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Rolls back in {countdown(deadline - now)}
            </Typography>
            <Typography variant="caption" color="textSecondary">
              unless you confirm the commit
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button size="small" variant="contained" color="warning" onClick={() => run({ operation: 'commit' })}>
              Confirm
            </Button>
            <Button size="small" color="inherit" onClick={() => run({ operation: 'cancel-commit' })}>
              Roll back now
            </Button>
          </>
        ) : dirty ? (
          <>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'info.main' }} />
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Uncommitted changes in the candidate
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button size="small" onClick={() => void openReview()}>
              Review
            </Button>
            {controller.hasCapability(':validate') && (
              <Button size="small" onClick={() => run({ operation: 'validate', source: 'candidate' })}>
                Validate
              </Button>
            )}
            <Button
              size="small"
              color="inherit"
              onClick={() =>
                void confirmAction({
                  title: 'Discard the candidate?',
                  description: 'Every uncommitted change in the candidate is lost, including other sessions’.',
                  confirmLabel: 'Discard',
                  destructive: true,
                }).then((confirmed) => confirmed && run({ operation: 'discard-changes' }))
              }
            >
              Discard
            </Button>
            {confirmable && (
              <Tooltip title="Commit with an automatic rollback unless confirmed">
                <Button size="small" variant="outlined" onClick={() => void commit(true)}>
                  Commit confirmed…
                </Button>
              </Tooltip>
            )}
            <Button size="small" variant="contained" onClick={() => void commit(false)}>
              Commit
            </Button>
          </>
        ) : candidate?.checking ? (
          <>
            <CircularProgress size={12} />
            <Typography variant="caption" color="textSecondary">
              Checking the candidate …
            </Typography>
            <Box sx={{ flex: 1 }} />
          </>
        ) : (
          <Box sx={{ flex: 1 }} />
        )}
        {locks.map((lock) => (
          <Tooltip key={lock} title={`This session holds the ${lock} lock`}>
            <Button
              size="small"
              color="inherit"
              startIcon={<LockOutlinedIcon sx={{ fontSize: 15 }} />}
              onClick={() => run({ operation: 'unlock', target: lock as NetconfDraft['target'] })}
              sx={{ fontSize: 12 }}
            >
              Unlock {lock}
            </Button>
          </Tooltip>
        ))}
      </Stack>
      <ReviewDialog
        open={!!review}
        title="Uncommitted changes"
        description="What a commit would change in the running configuration."
        sections={review?.sections ?? []}
        loading={review?.loading}
        error={review?.error}
        applyLabel="Commit"
        onApply={() => {
          setReview(null);
          void commit(false);
        }}
        onClose={() => setReview(null)}
      />
    </>
  );
}

/** The countdown of a gNMI commit-confirmed Set, with confirm and roll back. */
export function GnmiCommitBar() {
  const { controller, connected } = useWorkbench();
  const deadline = useWorkbenchState((state) => state.confirmDeadline);
  const commitId = useWorkbenchState((state) => state.commitId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [deadline]);
  if (!deadline || !commitId || !connected) return null;
  const expired = deadline <= now;
  return (
    <Stack
      direction="row"
      spacing={1}
      sx={(theme) => ({
        alignItems: 'center',
        px: 1.5,
        py: 0.5,
        minHeight: 38,
        flexShrink: 0,
        borderBottom: 1,
        borderColor: 'divider',
        bgcolor: alpha(theme.palette.warning.main, 0.14),
      })}
    >
      <TimerOutlinedIcon sx={{ fontSize: 18, color: 'warning.main' }} />
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {expired ? 'The rollback timer ran out' : `Rolls back in ${countdown(deadline - now)}`}
      </Typography>
      <Typography variant="caption" color="textSecondary">
        {expired ? 'the device has undone the change' : 'unless you confirm the change'}
      </Typography>
      <Box sx={{ flex: 1 }} />
      {!expired && (
        <>
          <Button size="small" variant="contained" color="warning" onClick={() => controller.finishGnmiCommit('confirm')}>
            Confirm
          </Button>
          <Button size="small" color="inherit" onClick={() => controller.finishGnmiCommit('cancel')}>
            Roll back now
          </Button>
        </>
      )}
      {expired && (
        <Button size="small" color="inherit" onClick={() => controller.store.setState({ confirmDeadline: undefined, commitId: undefined })}>
          Dismiss
        </Button>
      )}
    </Stack>
  );
}
