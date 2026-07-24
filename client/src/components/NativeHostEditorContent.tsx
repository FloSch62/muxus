import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Alert from '@mui/material/Alert';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import HighlightOutlinedIcon from '@mui/icons-material/HighlightOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';
import type { SerialPortInfo, SerialProfile } from '@muxus/shared';
import { useDeleteHostProfile, useSaveHostProfile, useUpdateHostProfileMetadata } from '../api/profiles.js';
import { useSavedHostProfiles, useSerialPorts, useSshConfig } from '../api/queries.js';
import { knownHostGroups } from '../managed-hosts.js';
import { connectSavedHost } from '../session-actions.js';
import type { HostEditorState } from '../state/ui.js';
import { useUiStore } from '../state/ui.js';
import { EditorShell, type EditorSectionDef } from './host-editor/EditorShell.js';
import { HighlightingSection } from './host-editor/HighlightingSection.js';
import {
  nativeDraftMetadataPatch,
  nativeDraftProblem,
  nativeDraftToInput,
  type NativeHostDraft,
} from './host-editor/native-draft.js';

const COMMON_BAUD_RATES = [
  300, 1_200, 2_400, 4_800, 9_600, 19_200, 38_400, 57_600, 115_200,
  230_400, 460_800, 921_600,
];

type NativeEditorState = Exclude<HostEditorState, false>;
type NativeSection = 'general' | 'line' | 'highlighting';

/**
 * Telnet/serial editor rendered into the shared host-editor shell, so the
 * dialog keeps the exact anatomy of the SSH editor: same header, section
 * rail, footprint, and action row.
 */
export function NativeHostEditorContent({
  state,
  kind,
  draft,
  setDraft,
}: {
  state: NativeEditorState;
  kind: 'telnet' | 'serial';
  draft: NativeHostDraft;
  setDraft: Dispatch<SetStateAction<NativeHostDraft>>;
}) {
  const setState = useUiStore((s) => s.setHostEditor);
  const existing =
    state.mode === 'edit-profile' || state.mode === 'duplicate-profile'
      ? state.entry
      : undefined;
  const [section, setSection] = useState<NativeSection>('general');
  // The line-settings section only exists for serial; snap back if the
  // connection type flips underneath it.
  const activeSection = kind === 'telnet' && section === 'line' ? 'general' : section;
  const connectAfter = useRef(false);

  const close = () => setState(false);
  const updateMetadata = useUpdateHostProfileMetadata((profile) => {
    close();
    if (connectAfter.current) connectSavedHost(profile);
  });
  const saveProfile = useSaveHostProfile((saved) => {
    updateMetadata.mutate({ id: saved.id, patch: nativeDraftMetadataPatch(draft) });
  });
  const deleteProfile = useDeleteHostProfile(close);

  const problem = nativeDraftProblem(draft, kind);
  const set = (patch: Partial<NativeHostDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = (connect: boolean) => {
    if (problem) return;
    connectAfter.current = connect;
    saveProfile.mutate(
      nativeDraftToInput(draft, kind, state.mode === 'edit-profile' ? existing?.id : undefined),
    );
  };

  const title =
    state.mode === 'edit-profile'
      ? `Edit ${existing?.name ?? 'host'}`
      : state.mode === 'duplicate-profile'
        ? `Duplicate ${existing?.name ?? 'host'}`
        : 'Add host';

  const sections: EditorSectionDef<NativeSection>[] = [
    {
      value: 'general',
      label: 'General',
      icon: kind === 'telnet' ? <LanguageOutlinedIcon fontSize="small" /> : <UsbOutlinedIcon fontSize="small" />,
    },
    ...(kind === 'serial'
      ? [{ value: 'line' as const, label: 'Line settings', icon: <TuneOutlinedIcon fontSize="small" /> }]
      : []),
    {
      value: 'highlighting',
      label: 'Highlighting',
      icon: <HighlightOutlinedIcon fontSize="small" />,
      count: draft.keywordHighlights.rules.length,
    },
  ];

  return (
    <EditorShell
      title={title}
      storage="Saved in Muxus app data"
      typeKind={state.mode === 'new' ? kind : undefined}
      onTypeChange={
        state.mode === 'new'
          ? (next) => setState({ mode: 'new', kind: next, prefillTarget: state.prefillTarget })
          : undefined
      }
      sections={sections}
      section={activeSection}
      onSection={setSection}
      problem={problem}
      busy={saveProfile.isPending || updateMetadata.isPending}
      onDelete={
        state.mode === 'edit-profile' && existing
          ? () => deleteProfile.mutate(existing.id)
          : undefined
      }
      deletePending={deleteProfile.isPending}
      onClose={close}
      onSave={save}
    >
      {activeSection === 'general' && (
        <GeneralSection kind={kind} draft={draft} set={set} />
      )}
      {activeSection === 'line' && <LineSettingsSection draft={draft} set={set} />}
      {activeSection === 'highlighting' && (
        <HighlightingSection
          config={draft.keywordHighlights}
          onChange={(keywordHighlights) => set({ keywordHighlights })}
          description="Host rules apply whenever a session connects to this host."
        />
      )}
    </EditorShell>
  );
}

function GeneralSection({
  kind,
  draft,
  set,
}: {
  kind: 'telnet' | 'serial';
  draft: NativeHostDraft;
  set: (patch: Partial<NativeHostDraft>) => void;
}) {
  const { data: config } = useSshConfig();
  const { data: savedData } = useSavedHostProfiles();
  const groups = knownHostGroups(config?.hosts ?? [], savedData?.profiles ?? []);

  return (
    <Stack spacing={2}>
      <TextField
        fullWidth
        required
        label="Name"
        placeholder={kind === 'telnet' ? 'Core router' : 'Console cable'}
        helperText="How this host appears in the session list"
        value={draft.name}
        onChange={(event) => set({ name: event.target.value })}
      />
      {kind === 'telnet' ? (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
          <TextField
            fullWidth
            label="Host"
            placeholder="router.example.com"
            value={draft.host}
            onChange={(event) => set({ host: event.target.value })}
          />
          <TextField
            label="Port"
            value={draft.port}
            onChange={(event) => set({ port: event.target.value.replace(/[^\d]/g, '') })}
            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
            sx={{ width: { sm: 130 } }}
          />
        </Stack>
      ) : (
        <SerialPortField draft={draft} set={set} />
      )}
      <Autocomplete
        freeSolo
        options={groups}
        inputValue={draft.group}
        onInputChange={(_event, value) => set({ group: value })}
        renderInput={(params) => (
          <TextField
            {...params}
            label="Group"
            placeholder="Lab"
            helperText="Optional — groups this host in the sidebar"
          />
        )}
      />
      {kind === 'telnet' && (
        <Alert severity="warning">
          Telnet is unencrypted. Credentials and terminal traffic are sent in plaintext.
        </Alert>
      )}
    </Stack>
  );
}

function SerialPortField({
  draft,
  set,
}: {
  draft: NativeHostDraft;
  set: (patch: Partial<NativeHostDraft>) => void;
}) {
  const serialPorts = useSerialPorts();

  return (
    <>
      <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
        <Autocomplete<SerialPortInfo, false, false, true>
          freeSolo
          autoHighlight
          options={serialPorts.data?.ports ?? []}
          inputValue={draft.path}
          getOptionLabel={(option) =>
            typeof option === 'string' ? option : option.path
          }
          onInputChange={(_event, value) => set({ path: value })}
          onChange={(_event, value) =>
            set({ path: typeof value === 'string' ? value : (value?.path ?? '') })
          }
          renderOption={(props, option) => {
            const { key, ...optionProps } = props;
            return (
              <Box component="li" key={key} {...optionProps}>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="body2">{option.path}</Typography>
                  {(option.manufacturer || option.serialNumber) && (
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {[option.manufacturer, option.serialNumber]
                        .filter(Boolean)
                        .join(' · ')}
                    </Typography>
                  )}
                </Box>
              </Box>
            );
          }}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Serial port"
              placeholder={platformPathExample()}
              helperText="Select a detected device or enter its OS-native path."
            />
          )}
          sx={{ flex: 1 }}
        />
        <Tooltip title="Refresh serial ports">
          <span>
            <IconButton
              aria-label="Refresh serial ports"
              disabled={serialPorts.isFetching}
              onClick={() => void serialPorts.refetch()}
              sx={{ mt: 0.75 }}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {serialPorts.isError && (
        <Alert severity="warning">
          Serial ports could not be enumerated. Enter a device path manually.
        </Alert>
      )}
      <Autocomplete<string, false, false, true>
        freeSolo
        fullWidth
        options={COMMON_BAUD_RATES.map(String)}
        inputValue={draft.baudRate}
        onInputChange={(_event, value) => set({ baudRate: value })}
        onChange={(_event, value) => set({ baudRate: value ?? '' })}
        renderInput={(params) => <TextField {...params} label="Baud rate" />}
      />
    </>
  );
}

function LineSettingsSection({
  draft,
  set,
}: {
  draft: NativeHostDraft;
  set: (patch: Partial<NativeHostDraft>) => void;
}) {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          Line settings
        </Typography>
        <Typography variant="body2" color="text.secondary">
          The defaults (8-N-1, no flow control) match most consoles.
        </Typography>
      </Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          select
          fullWidth
          label="Data bits"
          value={draft.dataBits}
          onChange={(event) =>
            set({ dataBits: Number(event.target.value) as SerialProfile['dataBits'] })
          }
        >
          {[5, 6, 7, 8].map((bits) => (
            <MenuItem key={bits} value={bits}>{bits}</MenuItem>
          ))}
        </TextField>
        <TextField
          select
          fullWidth
          label="Stop bits"
          value={draft.stopBits}
          onChange={(event) =>
            set({ stopBits: Number(event.target.value) as SerialProfile['stopBits'] })
          }
        >
          {[1, 1.5, 2].map((bits) => (
            <MenuItem key={bits} value={bits}>{bits}</MenuItem>
          ))}
        </TextField>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
        <TextField
          select
          fullWidth
          label="Parity"
          value={draft.parity}
          onChange={(event) =>
            set({ parity: event.target.value as SerialProfile['parity'] })
          }
        >
          {(['none', 'even', 'odd', 'mark', 'space'] as const).map((value) => (
            <MenuItem key={value} value={value}>{capitalize(value)}</MenuItem>
          ))}
        </TextField>
        <TextField
          select
          fullWidth
          label="Flow control"
          value={draft.flowControl}
          onChange={(event) =>
            set({ flowControl: event.target.value as SerialProfile['flowControl'] })
          }
        >
          <MenuItem value="none">None</MenuItem>
          <MenuItem value="hardware">Hardware (RTS/CTS)</MenuItem>
          <MenuItem value="software">Software (XON/XOFF)</MenuItem>
        </TextField>
      </Stack>
    </Stack>
  );
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function platformPathExample(): string {
  if (navigator.userAgent.includes('Windows')) return 'COM3';
  if (navigator.userAgent.includes('Mac')) return '/dev/tty.usbserial-…';
  return '/dev/ttyUSB0';
}
