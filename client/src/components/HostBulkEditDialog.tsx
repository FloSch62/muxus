import { useMemo, useState, type ReactElement } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import HighlightOutlinedIcon from '@mui/icons-material/HighlightOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import { useApplyBulkHostEdit } from '../api/host-bulk-edit.js';
import { useSessionLoggingPolicies, useSessionLoggingPolicy } from '../api/queries.js';
import {
  bulkChangesProblem,
  bulkEditPlan,
  hostLoggingKey,
  isTerminalHost,
  sameBulkValue,
  summarizeBulkValues,
  type BulkFieldSummary,
  type BulkHostChanges,
  type BulkHostField,
  type BulkHostValues,
} from '../host-bulk-edit.js';
import { newLoginStep } from '../login-sequence.js';
import { managedHostDisplayName, managedHostKey } from '../managed-hosts.js';
import { hostSessionLoggingDraft } from '../session-logging-policy.js';
import { useCustomTerminalSchemes, usePrefsStore } from '../state/prefs.js';
import { useUiStore } from '../state/ui.js';
import { isTerminalSchemeId } from '../terminal/palette.js';
import { FolderPathField } from './FolderPathField.js';
import { HostColorPicker } from './HostColorPicker.js';
import { EditorShell, type EditorSectionDef } from './host-editor/EditorShell.js';
import { LoggingSection } from './host-editor/LoggingSection.js';
import { PasteDelayField } from './host-editor/PasteDelayField.js';
import { LoginSequenceEditor } from './LoginSequenceEditor.js';
import {
  ColorOverride,
  commandButtonGroupOptions,
  useTerminalColorDefaults,
} from './host-editor/TerminalAppearanceSection.js';
import { TerminalSchemeSelect } from './TerminalSchemeSelect.js';
import { useAllManagedHosts } from './sidebar/useAllManagedHosts.js';

type Section = 'organize' | 'connection' | 'appearance' | 'highlighting' | 'logging' | 'login';

const SECTIONS: ReadonlyArray<{
  value: Section;
  label: string;
  icon: ReactElement;
  fields: readonly BulkHostField[];
}> = [
  { value: 'organize', label: 'Folder & color', icon: <FolderOutlinedIcon fontSize="small" />, fields: ['group', 'color'] },
  {
    value: 'connection',
    label: 'SSH connection',
    icon: <DnsOutlinedIcon fontSize="small" />,
    fields: [
      'user',
      'port',
      'strictHostKeyChecking',
      'forwardAgent',
      'forwardX11',
      'consoleCompatibility',
      'disableSftp',
    ],
  },
  {
    value: 'appearance',
    label: 'Terminal appearance',
    icon: <PaletteOutlinedIcon fontSize="small" />,
    fields: [
      'terminalScheme',
      'terminalFontColor',
      'terminalBackgroundColor',
      'commandButtonGroup',
      'pasteLineDelayMs',
      'pasteCharDelayMs',
    ],
  },
  {
    value: 'highlighting',
    label: 'Highlighting',
    icon: <HighlightOutlinedIcon fontSize="small" />,
    fields: ['highlightProfileId', 'highlightInheritGlobal'],
  },
  { value: 'logging', label: 'Session logging', icon: <HistoryOutlinedIcon fontSize="small" />, fields: ['sessionLogging'] },
  { value: 'login', label: 'Login sequence', icon: <LoginOutlinedIcon fontSize="small" />, fields: ['loginSequence'] },
];

/** Selected while hosts disagree: a hidden option, so any real choice is a change. */
const MIXED = '__mixed__';
const MULTIPLE_VALUES = 'Multiple values';

/**
 * Change settings on many hosts at once. Each field starts from what the
 * hosts share, or reads "Multiple values" where they differ, and only the
 * fields the user touches are written — every other setting on every host
 * stays exactly as it was.
 */
export function HostBulkEditDialog() {
  const hostKeys = useUiStore((state) => state.hostBulkEditor);
  const setHostBulkEditor = useUiStore((state) => state.setHostBulkEditor);
  if (!hostKeys) return null;
  const close = () => setHostBulkEditor(false);

  return (
    <Dialog
      open
      onClose={close}
      maxWidth="md"
      fullWidth
      slotProps={{ paper: { sx: { height: 650 } } }}
    >
      <BulkEditBody hostKeys={hostKeys} onClose={close} />
    </Dialog>
  );
}

function BulkEditBody({ hostKeys, onClose }: { hostKeys: readonly string[]; onClose: () => void }) {
  const allHosts = useAllManagedHosts();
  // Resolved live, so a host deleted meanwhile simply drops out of the edit.
  const hosts = useMemo(() => {
    const byKey = new Map(allHosts.map((host) => [managedHostKey(host), host]));
    return hostKeys.flatMap((key) => {
      const host = byKey.get(key);
      return host ? [host] : [];
    });
  }, [allHosts, hostKeys]);
  const loggingKeys = useMemo(
    () => hosts.filter(isTerminalHost).map(hostLoggingKey),
    [hosts],
  );
  const policies = useSessionLoggingPolicies(loggingKeys);
  const { data: defaultPolicy } = useSessionLoggingPolicy('*', loggingKeys.length > 0);
  const summary = useMemo(() => summarizeBulkValues(hosts, policies), [hosts, policies]);

  const [changes, setChanges] = useState<BulkHostChanges>({});
  const [chosenSection, setSection] = useState<Section>('organize');
  const plan = useMemo(() => bulkEditPlan(hosts, changes, policies), [hosts, changes, policies]);
  // A partial failure keeps the dialog open: once the hosts refetch, the plan
  // only holds what is still missing, and Apply retries exactly that.
  const apply = useApplyBulkHostEdit((result) => {
    if (result.failed === 0) onClose();
  });

  if (hosts.length === 0) {
    return (
      <>
        <DialogTitle>Edit hosts</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="textSecondary">
            The selected hosts no longer exist.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </>
    );
  }

  const field = <F extends BulkHostField>(name: F): BulkFieldState<BulkHostValues[F]> => {
    const fieldSummary = summary[name] as BulkFieldSummary<BulkHostValues[F]>;
    const changed = name in changes;
    return {
      value: changed
        ? (changes[name] as BulkHostValues[F])
        : fieldSummary.state === 'same'
          ? fieldSummary.value
          : undefined,
      mixed: !changed && fieldSummary.state === 'mixed',
      changed,
      count: plan.fieldCounts[name] ?? 0,
      summary: fieldSummary,
      set: (value: BulkHostValues[F]) =>
        setChanges((current) => {
          // Choosing what every host already has is no change at all.
          if (fieldSummary.state === 'same' && sameBulkValue(name, fieldSummary.value, value)) {
            return withoutField(current, name);
          }
          return { ...current, [name]: value };
        }),
      reset: () => setChanges((current) => withoutField(current, name)),
    };
  };

  const visibleSections = SECTIONS.filter((def) =>
    def.fields.some((name) => summary[name].state !== 'none'),
  );
  const section = visibleSections.some((def) => def.value === chosenSection)
    ? chosenSection
    : 'organize';
  const sections: EditorSectionDef<Section>[] = visibleSections.map((def) => ({
    value: def.value,
    label: def.label,
    icon: def.icon,
    count: def.fields.filter((name) => name in changes).length || undefined,
  }));

  const changedFields = Object.keys(changes).length;
  const problem = bulkChangesProblem(changes);
  const idle =
    changedFields === 0
      ? 'Change a setting to apply it to every selected host.'
      : plan.hosts.length === 0
        ? 'The selected hosts already have these settings.'
        : null;
  const names = hosts.slice(0, 3).map(managedHostDisplayName).join(', ');

  return (
    <EditorShell
      title={`Edit ${hosts.length} host${hosts.length === 1 ? '' : 's'}`}
      storage={hosts.length > 3 ? `${names} and ${hosts.length - 3} more` : names}
      sections={sections}
      section={section}
      onSection={setSection}
      problem={problem}
      loading={idle}
      busy={apply.isPending}
      onClose={onClose}
      onSave={() => apply.mutate(plan)}
      saveLabel={
        plan.hosts.length > 0
          ? `Apply to ${plan.hosts.length} host${plan.hosts.length === 1 ? '' : 's'}`
          : 'Apply'
      }
      connectAction={false}
    >
      {section === 'organize' && (
        <OrganizeSection group={field('group')} color={field('color')} />
      )}
      {section === 'connection' && (
        <ConnectionSection
          total={hosts.length}
          openSshCount={hosts.filter((host) => host.kind === 'ssh').length}
          user={field('user')}
          port={field('port')}
          strictHostKeyChecking={field('strictHostKeyChecking')}
          forwardAgent={field('forwardAgent')}
          forwardX11={field('forwardX11')}
          consoleCompatibility={field('consoleCompatibility')}
          disableSftp={field('disableSftp')}
        />
      )}
      {section === 'appearance' && (
        <AppearanceSection
          total={hosts.length}
          scheme={field('terminalScheme')}
          fontColor={field('terminalFontColor')}
          backgroundColor={field('terminalBackgroundColor')}
          commandButtonGroup={field('commandButtonGroup')}
          pasteLineDelayMs={field('pasteLineDelayMs')}
          pasteCharDelayMs={field('pasteCharDelayMs')}
        />
      )}
      {section === 'highlighting' && (
        <BulkHighlightingSection
          total={hosts.length}
          profile={field('highlightProfileId')}
          inheritGlobal={field('highlightInheritGlobal')}
        />
      )}
      {section === 'logging' && (
        <BulkLoggingSection
          total={hosts.length}
          logging={field('sessionLogging')}
          startingPoint={defaultPolicy ? hostSessionLoggingDraft(defaultPolicy, true) : undefined}
        />
      )}
      {section === 'login' && (
        <BulkLoginSequenceSection total={hosts.length} sequence={field('loginSequence')} />
      )}
    </EditorShell>
  );
}

function withoutField(changes: BulkHostChanges, name: BulkHostField): BulkHostChanges {
  const next = { ...changes };
  delete next[name];
  return next;
}

/** Everything a control needs to show and change one field across the selection. */
interface BulkFieldState<T> {
  /** The change, or the value every host shares; undefined while they disagree. */
  value: T | undefined;
  /** The hosts disagree and the user has not picked a value for all of them. */
  mixed: boolean;
  changed: boolean;
  /** Hosts the change actually alters. */
  count: number;
  summary: BulkFieldSummary<T>;
  set: (value: T) => void;
  reset: () => void;
}

function OrganizeSection({
  group,
  color,
}: {
  group: BulkFieldState<string>;
  color: BulkFieldState<string | undefined>;
}) {
  return (
    <Stack spacing={2.5}>
      <SectionIntro
        title="Folder & color"
        description="Display name, folder and color are local to Muxus — they never touch your ssh config."
      />
      <Box>
        <FolderPathField
          value={group.value ?? ''}
          onChange={group.set}
          placeholder={group.mixed ? MULTIPLE_VALUES : undefined}
          helperText="Use / to nest; leave empty for no folder."
        />
        <FieldStatus state={group} inset />
      </Box>
      <Box>
        <HostColorPicker value={color.value} mixed={color.mixed} onChange={color.set} />
        <FieldStatus state={color} />
      </Box>
    </Stack>
  );
}

function ConnectionSection({
  total,
  openSshCount,
  user,
  port,
  strictHostKeyChecking,
  forwardAgent,
  forwardX11,
  consoleCompatibility,
  disableSftp,
}: {
  total: number;
  openSshCount: number;
  user: BulkFieldState<string>;
  port: BulkFieldState<string>;
  strictHostKeyChecking: BulkFieldState<BulkHostValues['strictHostKeyChecking']>;
  forwardAgent: BulkFieldState<BulkHostValues['forwardAgent']>;
  forwardX11: BulkFieldState<BulkHostValues['forwardX11']>;
  consoleCompatibility: BulkFieldState<boolean>;
  disableSftp: BulkFieldState<boolean>;
}) {
  const sshCount = applicableCount(user.summary);
  const muxusCount = sshCount - openSshCount;
  const storage = [
    openSshCount > 0 ? `${openSshCount} in ssh_config` : '',
    muxusCount > 0 ? `${muxusCount} in Muxus app data` : '',
  ]
    .filter(Boolean)
    .join(' and ');

  return (
    <Stack spacing={2.5}>
      <SectionIntro
        title="SSH connection"
        description={describe(
          sshCount,
          total,
          'SSH host',
          `Each host keeps its storage (${storage}), and only the changed options are rewritten.`,
        )}
      />
      <Stack direction="row" spacing={1.5}>
        <Box sx={{ flex: 1 }}>
          <TextField
            label="User"
            value={user.value ?? ''}
            onChange={(event) => user.set(event.target.value)}
            placeholder={user.mixed ? MULTIPLE_VALUES : 'Not set'}
            slotProps={{ inputLabel: { shrink: true } }}
            fullWidth
          />
          <FieldStatus state={user} inset empty="Removes the user, so each host falls back to its defaults." />
        </Box>
        <Box sx={{ width: 200 }}>
          <TextField
            label="Port"
            value={port.value ?? ''}
            onChange={(event) => port.set(event.target.value.replace(/[^\d]/g, ''))}
            placeholder={port.mixed ? MULTIPLE_VALUES : '22'}
            slotProps={{ inputLabel: { shrink: true } }}
            fullWidth
          />
          <FieldStatus state={port} inset empty="Removes the port." />
        </Box>
      </Stack>
      <Box>
        <BulkSelect
          label="Host verification"
          state={strictHostKeyChecking}
          options={[
            { value: 'inherit', label: 'Use the default' },
            { value: 'ask', label: 'Ask before trusting a new host' },
            { value: 'accept-new', label: 'Trust new hosts automatically' },
            { value: 'yes', label: 'Require a saved host key' },
            { value: 'no', label: 'Disable strict checking (no)' },
          ]}
        />
        <FieldStatus state={strictHostKeyChecking} />
      </Box>
      <Box>
        <BulkSelect
          label="Agent forwarding"
          state={forwardAgent}
          options={[
            { value: 'inherit', label: 'Use the default' },
            { value: 'yes', label: 'Forward agent' },
            { value: 'no', label: 'Do not forward agent' },
          ]}
        />
        <FieldStatus state={forwardAgent} />
      </Box>
      <Box>
        <BulkSelect
          label="X11 forwarding"
          state={forwardX11}
          options={[
            { value: 'inherit', label: 'Use the default' },
            { value: 'yes', label: 'Forward X11' },
            { value: 'no', label: 'Do not forward X11' },
          ]}
        />
        <FieldStatus state={forwardX11} />
      </Box>
      <Divider />
      <Box>
        <BulkCheckbox
          state={consoleCompatibility}
          label="Enable console compatibility mode"
          description="Skips SFTP, shell integration, and SendEnv/SetEnv requests. TTY settings still apply."
        />
        <FieldStatus state={consoleCompatibility} />
      </Box>
      <Box>
        <BulkCheckbox
          state={disableSftp}
          label="Disable SFTP and shell integration only"
          description="Keeps SendEnv/SetEnv and normal TTY behavior."
        />
        <FieldStatus state={disableSftp} />
      </Box>
    </Stack>
  );
}

function AppearanceSection({
  total,
  scheme,
  fontColor,
  backgroundColor,
  commandButtonGroup,
  pasteLineDelayMs,
  pasteCharDelayMs,
}: {
  total: number;
  scheme: BulkFieldState<string | undefined>;
  fontColor: BulkFieldState<string | undefined>;
  backgroundColor: BulkFieldState<string | undefined>;
  commandButtonGroup: BulkFieldState<string | undefined>;
  pasteLineDelayMs: BulkFieldState<number | undefined>;
  pasteCharDelayMs: BulkFieldState<number | undefined>;
}) {
  const customSchemes = useCustomTerminalSchemes();
  const commandGroups = usePrefsStore((state) => state.commandButtonGroups);
  const defaultLineDelay = usePrefsStore((state) => state.pasteLineDelayMs);
  const defaultCharDelay = usePrefsStore((state) => state.pasteCharDelayMs);
  // With mixed schemes the color pickers start from the application's own.
  const defaults = useTerminalColorDefaults(scheme.mixed ? undefined : scheme.value);

  return (
    <Stack spacing={2.5}>
      <SectionIntro
        title="Terminal appearance"
        description={describe(
          applicableCount(scheme.summary),
          total,
          'terminal host',
          'Unset values follow the application settings.',
        )}
      />
      <Box>
        <TerminalSchemeSelect
          id="bulk-terminal-scheme"
          label="Color scheme"
          value={isTerminalSchemeId(scheme.value, customSchemes) ? (scheme.value ?? '') : ''}
          mixed={scheme.mixed}
          inheritLabel="Use application default"
          onChange={(value) => scheme.set(value || undefined)}
        />
        <FieldStatus state={scheme} />
      </Box>
      <Box>
        <ColorOverride
          label="Text color"
          value={fontColor.value}
          mixed={fontColor.mixed}
          defaultValue={defaults.fontColor}
          onChange={fontColor.set}
        />
        <FieldStatus state={fontColor} />
      </Box>
      <Box>
        <ColorOverride
          label="Background color"
          value={backgroundColor.value}
          mixed={backgroundColor.mixed}
          defaultValue={defaults.backgroundColor}
          onChange={backgroundColor.set}
        />
        <FieldStatus state={backgroundColor} />
      </Box>
      <Box>
        <BulkSelect
          label="Command button group"
          state={{
            mixed: commandButtonGroup.mixed,
            value: commandButtonGroup.value ?? '',
            set: (value: string) => commandButtonGroup.set(value || undefined),
          }}
          options={commandButtonGroupOptions(commandGroups, commandButtonGroup.value)}
        />
        <FieldStatus state={commandButtonGroup} inset />
      </Box>
      <Stack direction="row" spacing={1.5}>
        <Box sx={{ flex: 1 }}>
          <PasteDelayField
            kind="line"
            value={pasteLineDelayMs.value}
            mixed={pasteLineDelayMs.mixed}
            defaultValue={defaultLineDelay}
            onChange={pasteLineDelayMs.set}
          />
          <FieldStatus state={pasteLineDelayMs} inset />
        </Box>
        <Box sx={{ flex: 1 }}>
          <PasteDelayField
            kind="char"
            value={pasteCharDelayMs.value}
            mixed={pasteCharDelayMs.mixed}
            defaultValue={defaultCharDelay}
            onChange={pasteCharDelayMs.set}
          />
          <FieldStatus state={pasteCharDelayMs} inset />
        </Box>
      </Stack>
    </Stack>
  );
}

function BulkHighlightingSection({
  total,
  profile,
  inheritGlobal,
}: {
  total: number;
  profile: BulkFieldState<string | undefined>;
  inheritGlobal: BulkFieldState<boolean>;
}) {
  const profiles = usePrefsStore((state) => state.keywordHighlightProfiles);
  const missing =
    profile.value && !profiles.some((candidate) => candidate.id === profile.value)
      ? profile.value
      : undefined;
  return (
    <Stack spacing={2.5}>
      <SectionIntro
        title="Keyword highlighting"
        description={describe(
          applicableCount(profile.summary),
          total,
          'terminal host',
          'Each host keeps its own keyword rules; only the profile and the global rules switch change.',
        )}
      />
      <Box>
        <BulkSelect
          label="Highlighting profile"
          state={{
            mixed: profile.mixed,
            value: profile.value ?? '',
            set: (value: string) => profile.set(value || undefined),
          }}
          options={[
            { value: '', label: 'No reusable profile' },
            ...(missing ? [{ value: missing, label: `Missing profile (${missing})` }] : []),
            ...profiles.map((candidate) => ({ value: candidate.id, label: candidate.name })),
          ]}
        />
        <FieldStatus state={profile} />
      </Box>
      <Box>
        <BulkCheckbox
          state={inheritGlobal}
          label="Include global highlighting rules"
          description="Turn this off when these hosts should use only their profile and host rules."
        />
        <FieldStatus state={inheritGlobal} />
      </Box>
    </Stack>
  );
}

function BulkLoggingSection({
  total,
  logging,
  startingPoint,
}: {
  total: number;
  logging: BulkFieldState<BulkHostValues['sessionLogging']>;
  /** Where "one policy for all" starts: the application default, inherited. */
  startingPoint: BulkHostValues['sessionLogging'] | undefined;
}) {
  const description = describe(
    applicableCount(logging.summary),
    total,
    'terminal host',
    'New sessions use the chosen policy; existing logs are kept.',
  );
  const intro = <SectionIntro title="Session logging" description={description} />;

  if (logging.summary.state === 'loading' && !logging.changed) {
    return (
      <Stack spacing={2}>
        {intro}
        <Typography variant="body2" color="textSecondary">
          Loading session logging settings…
        </Typography>
      </Stack>
    );
  }
  if (!logging.value) {
    return (
      <Stack spacing={2}>
        {intro}
        <Alert
          severity="info"
          variant="outlined"
          action={
            <Button
              color="inherit"
              size="small"
              disabled={!startingPoint}
              onClick={() => startingPoint && logging.set(startingPoint)}
            >
              Set one policy
            </Button>
          }
        >
          These hosts log sessions differently. Each keeps its own policy until you set one
          for all of them.
        </Alert>
      </Stack>
    );
  }

  const value = logging.value;
  return (
    <Stack spacing={2}>
      <LoggingSection
        value={value}
        onChange={(patch) => logging.set({ ...value, ...patch })}
        description={description}
      />
      <FieldStatus state={logging} />
    </Stack>
  );
}

function BulkLoginSequenceSection({
  total,
  sequence,
}: {
  total: number;
  sequence: BulkFieldState<BulkHostValues['loginSequence']>;
}) {
  const intro = (
    <SectionIntro
      title="Login sequence"
      description={describe(
        applicableCount(sequence.summary),
        total,
        'terminal host',
        'Steps each session runs after it connects. Hosts that use their folder’s sequence follow the folder they are in.',
      )}
    />
  );

  if (!sequence.value) {
    return (
      <Stack spacing={2}>
        {intro}
        <Alert
          severity="info"
          variant="outlined"
          action={
            <Stack direction="row" spacing={0.5} sx={{ whiteSpace: 'nowrap' }}>
              <Button color="inherit" size="small" onClick={() => sequence.set({ mode: 'inherit', steps: [] })}>
                Use folders
              </Button>
              <Button
                color="inherit"
                size="small"
                onClick={() => sequence.set({ mode: 'custom', steps: [newLoginStep('wait')] })}
              >
                Set one sequence
              </Button>
            </Stack>
          }
        >
          These hosts log in differently. Each keeps its own login sequence until you set one for
          all of them.
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack spacing={2}>
      {intro}
      <LoginSequenceEditor
        value={sequence.value}
        onChange={sequence.set}
        inheritLabel="Use the folder's login sequence"
        inheritEmptyText="Each host runs the sequence of the folder it is in, if that folder sets one."
      />
      <FieldStatus state={sequence} />
    </Stack>
  );
}

function SectionIntro({ title, description }: { title: string; description: string }) {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="textSecondary">
        {description}
      </Typography>
    </Box>
  );
}

/**
 * The line under a field saying what applying would do with it: nothing yet
 * while the hosts disagree, or how many hosts the change reaches.
 */
function FieldStatus<T>({
  state,
  empty,
  inset = false,
}: {
  state: BulkFieldState<T>;
  /** Said when the change empties a text field, which removes the setting. */
  empty?: string;
  /** Line up with a text field's helper text. */
  inset?: boolean;
}) {
  const ml = inset ? 1.75 : 0;
  if (state.changed) {
    const cleared = empty && state.value === '';
    return (
      <Stack
        direction="row"
        sx={{ alignItems: 'center', flexWrap: 'wrap', columnGap: 1, mt: 0.5, ml, minHeight: 26 }}
      >
        <Typography variant="caption" color="primary">
          {cleared ? `${empty} ` : ''}
          {state.count === 0
            ? 'Every host already has this.'
            : `Changes ${state.count} host${state.count === 1 ? '' : 's'}.`}
        </Typography>
        <Button size="small" onClick={state.reset} sx={{ minWidth: 0, py: 0 }}>
          Undo
        </Button>
      </Stack>
    );
  }
  if (state.mixed) {
    return (
      <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 0.5, ml }}>
        Multiple values — each host keeps its own.
      </Typography>
    );
  }
  return null;
}

/** The parts of a field a control reads and writes. */
type BulkControlState<T> = Pick<BulkFieldState<T>, 'value' | 'mixed' | 'set'>;

function BulkSelect<T extends string>({
  label,
  state,
  options,
}: {
  label: string;
  state: BulkControlState<T>;
  options: ReadonlyArray<{ value: T; label: string }>;
}) {
  return (
    <TextField
      select
      fullWidth
      label={label}
      value={state.mixed ? MIXED : (state.value ?? '')}
      onChange={(event) => state.set(event.target.value as T)}
      slotProps={{
        inputLabel: { shrink: true },
        select: {
          displayEmpty: true,
          renderValue: (value) =>
            value === MIXED ? (
              <Box component="span" sx={{ color: 'text.secondary' }}>
                {MULTIPLE_VALUES}
              </Box>
            ) : (
              (options.find((option) => option.value === value)?.label ?? String(value))
            ),
        },
      }}
    >
      {state.mixed ? (
        <MenuItem value={MIXED} sx={{ display: 'none' }}>
          {MULTIPLE_VALUES}
        </MenuItem>
      ) : null}
      {options.map((option) => (
        <MenuItem key={option.value} value={option.value}>
          {option.label}
        </MenuItem>
      ))}
    </TextField>
  );
}

/** A switch with a third, mixed state — which is why it is a checkbox here. */
function BulkCheckbox({
  state,
  label,
  description,
}: {
  state: BulkControlState<boolean>;
  label: string;
  description: string;
}) {
  return (
    <FormControlLabel
      control={
        <Checkbox
          checked={!state.mixed && !!state.value}
          indeterminate={state.mixed}
          onChange={(event) => state.set(event.target.checked)}
        />
      }
      label={
        <Box sx={{ py: 0.25 }}>
          <Typography variant="body2">{label}</Typography>
          <Typography variant="caption" color="textSecondary">
            {description}
          </Typography>
        </Box>
      }
    />
  );
}

function applicableCount(summary: BulkFieldSummary<unknown>): number {
  return summary.state === 'none' ? 0 : summary.count;
}

/**
 * A section's explanation, opened with "Applies to the 4 SSH hosts in the
 * selection." unless the section applies to every selected host.
 */
function describe(count: number, total: number, noun: string, text: string): string {
  if (count === total) return text;
  return `Applies to the ${count} ${noun}${count === 1 ? '' : 's'} in the selection. ${text}`;
}
