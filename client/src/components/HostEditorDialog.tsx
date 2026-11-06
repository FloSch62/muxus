import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Dialog from '@mui/material/Dialog';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import HighlightOutlinedIcon from '@mui/icons-material/HighlightOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import { useQueryClient } from '@tanstack/react-query';
import type { OpenSshMetadataPatch, SavedHostProfile } from '@muxus/shared';
import {
  useSavedHostProfiles,
  useSessionLoggingPolicy,
  useSshConfig,
  useSshKeys,
} from '../api/queries.js';
import { apiFetch } from '../api/http.js';
import { useSaveSessionLoggingPolicy } from '../api/session-history.js';
import {
  useDeleteHostProfile,
  useSaveHostProfile,
  useUpdateHostProfileMetadata,
} from '../api/profiles.js';
import {
  fetchHostPreview,
  useDeleteHost,
  useUpdateSshMetadata,
  useUpsertHost,
} from '../api/ssh-config.js';
import { antiIdleFromDraft } from '../anti-idle.js';
import { confirmDeleteHost, shortenSshPath } from '../host-actions.js';
import { loginSequenceFromDraft } from '../login-sequence.js';
import { connectSavedHost, connectTarget } from '../session-actions.js';
import {
  hostSessionLoggingDraft,
  sessionLoggingPolicyInput,
} from '../session-logging-policy.js';
import { usePrefsStore } from '../state/prefs.js';
import { showErrorToast, showToast } from '../state/toast.js';
import { useUiStore, type HostEditorState } from '../state/ui.js';
import { customTerminalInputModes, terminalInputModesPatch } from '../terminal/input-modes.js';
import { pastePromptWaitFromDraft } from '../terminal/paste-prompt.js';
import { AdvancedSection } from './host-editor/AdvancedSection.js';
import { AuthSection } from './host-editor/AuthSection.js';
import {
  blankDraft,
  draftFromEntry,
  draftFromSavedSshProfile,
  draftProblem,
  draftToRequest,
  draftJumpFallbacks,
  draftToSavedSshInput,
  identityAgentForDetection,
  environmentDiscoveryFromDraft,
  type HostDraft,
} from './host-editor/draft.js';
import { EditorShell, type EditorSectionDef } from './host-editor/EditorShell.js';
import { ForwardsSection } from './host-editor/ForwardsSection.js';
import { GeneralSection } from './host-editor/GeneralSection.js';
import { HighlightingSection } from './host-editor/HighlightingSection.js';
import { LoggingSection } from './host-editor/LoggingSection.js';
import { LoginSequenceSection } from './host-editor/LoginSequenceSection.js';
import { TerminalAppearanceSection } from './host-editor/TerminalAppearanceSection.js';
import {
  blankNativeDraft,
  nativeDraftFromProfile,
  type NativeHostDraft,
} from './host-editor/native-draft.js';
import {
  describeDraftRange,
  expandDraftRange,
  rangeExample,
} from './host-editor/name-range.js';
import { RouteSection } from './host-editor/RouteSection.js';
import {
  blankDesktopDraft,
  desktopDraftFromProfile,
  type DesktopHostDraft,
} from './host-editor/desktop-draft.js';
import type { ConnectionKind } from './host-editor/EditorShell.js';
import { NativeHostEditorContent } from './NativeHostEditorContent.js';
import { RemoteDesktopHostEditorContent } from './RemoteDesktopHostEditorContent.js';
import { ManagementHostEditorContent } from './ManagementHostEditorContent.js';
import { WebHostEditorContent } from './WebHostEditorContent.js';
import { WinrmHostEditorContent } from './WinrmHostEditorContent.js';
import { ShareHostEditorContent } from './ShareHostEditorContent.js';
import { blankShareDraft, shareDraftFromProfile, type ShareHostDraft } from './host-editor/share-draft.js';
import { blankWinrmDraft, winrmDraftFromProfile, type WinrmHostDraft } from './host-editor/winrm-draft.js';
import { blankWebDraft, webDraftFromProfile, type WebHostDraft } from './host-editor/web-draft.js';
import {
  blankManagementDraft,
  managementDraftFromProfile,
  type ManagementHostDraft,
} from './host-editor/management-draft.js';

type Section =
  | 'general'
  | 'appearance'
  | 'auth'
  | 'route'
  | 'forwards'
  | 'login'
  | 'logging'
  | 'highlighting'
  | 'advanced';
type OpenState = Exclude<HostEditorState, false>;
type SshEditorState = Extract<
  OpenState,
  { mode: 'new' | 'duplicate' | 'edit' | 'duplicate-profile' | 'edit-profile' }
>;

export function HostEditorDialog() {
  const state = useUiStore((s) => s.hostEditor);
  const setState = useUiStore((s) => s.setHostEditor);
  if (!state) return null;

  return (
    <Dialog
      open
      onClose={() => setState(false)}
      maxWidth="md"
      fullWidth
      slotProps={{
        paper: {
          sx: {
            height: 650,
          },
        },
      }}
    >
      <HostEditorBody state={state} />
    </Dialog>
  );
}

/**
 * Owns the drafts for both editors so switching the connection type while
 * creating a host swaps the form but never loses what was already typed.
 */
function HostEditorBody({ state }: { state: OpenState }) {
  const [sshDraft, setSshDraft] = useState<HostDraft>(() => initialSshDraft(state));
  const [nativeDraft, setNativeDraft] = useState<NativeHostDraft>(() => initialNativeDraft(state));
  const [desktopDraft, setDesktopDraft] = useState<DesktopHostDraft>(() => initialDesktopDraft(state));
  const [managementDraft, setManagementDraft] = useState<ManagementHostDraft>(() =>
    initialManagementDraft(state),
  );
  const [webDraft, setWebDraft] = useState<WebHostDraft>(() => initialWebDraft(state));
  const [winrmDraft, setWinrmDraft] = useState<WinrmHostDraft>(() => initialWinrmDraft(state));
  const [shareDraft, setShareDraft] = useState<ShareHostDraft>(() => initialShareDraft(state));
  const lastIdentity = useRef(stateIdentity(state));

  // Re-seed only when the edited entry itself changes — a connection-type
  // switch keeps the same identity, so both drafts survive it.
  useEffect(() => {
    const identity = stateIdentity(state);
    if (identity === lastIdentity.current) return;
    lastIdentity.current = identity;
    setSshDraft(initialSshDraft(state));
    setNativeDraft(initialNativeDraft(state));
    setDesktopDraft(initialDesktopDraft(state));
    setManagementDraft(initialManagementDraft(state));
    setWebDraft(initialWebDraft(state));
    setWinrmDraft(initialWinrmDraft(state));
    setShareDraft(initialShareDraft(state));
  }, [state]);

  const kind = editorKind(state);
  if (kind === 'ssh') {
    return (
      <SshHostEditorContent
        state={state as SshEditorState}
        draft={sshDraft}
        setDraft={setSshDraft}
      />
    );
  }
  if (kind === 'smb' || kind === 'nfs') {
    return <ShareHostEditorContent state={state} kind={kind} draft={shareDraft} setDraft={setShareDraft} />;
  }
  if (kind === 'winrm') {
    return <WinrmHostEditorContent state={state} draft={winrmDraft} setDraft={setWinrmDraft} />;
  }
  if (kind === 'web') {
    return <WebHostEditorContent state={state} draft={webDraft} setDraft={setWebDraft} />;
  }
  if (kind === 'gnmi' || kind === 'netconf') {
    return (
      <ManagementHostEditorContent
        state={state}
        kind={kind}
        draft={managementDraft}
        setDraft={setManagementDraft}
      />
    );
  }
  if (kind === 'rdp' || kind === 'vnc') {
    return (
      <RemoteDesktopHostEditorContent
        state={state}
        kind={kind}
        draft={desktopDraft}
        setDraft={setDesktopDraft}
      />
    );
  }
  return (
    <NativeHostEditorContent
      state={state}
      kind={kind}
      draft={nativeDraft}
      setDraft={setNativeDraft}
    />
  );
}

function editorKind(state: OpenState): ConnectionKind {
  if (state.mode === 'new') return state.kind ?? 'ssh';
  if (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') {
    return state.entry.kind;
  }
  return 'ssh';
}

function stateIdentity(state: OpenState): string {
  if (state.mode === 'new') {
    return `new:${state.prefillTarget ?? ''}:${state.group ?? ''}:${state.draft?.aliasText ?? ''}`;
  }
  if (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') {
    return `${state.mode}:${state.entry.id}`;
  }
  return `${state.mode}:${state.entry.file}:${state.entry.alias}`;
}

function initialSshDraft(state: OpenState): HostDraft {
  if (state.mode === 'new') {
    if (state.draft) return state.draft;
    return blankDraft(
      state.prefillTarget,
      state.group,
      usePrefsStore.getState().newSshHostStorage,
    );
  }
  if (state.mode === 'edit' || state.mode === 'duplicate') {
    return draftFromEntry(state.entry, state.mode === 'duplicate');
  }
  if (
    (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') &&
    state.entry.profile.kind === 'ssh'
  ) {
    return draftFromSavedSshProfile(
      state.entry,
      state.mode === 'duplicate-profile',
    );
  }
  return blankDraft();
}

function initialNativeDraft(state: OpenState): NativeHostDraft {
  if (
    (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') &&
    (state.entry.profile.kind === 'telnet' || state.entry.profile.kind === 'serial')
  ) {
    return nativeDraftFromProfile(
      state.entry,
      state.mode === 'duplicate-profile',
    );
  }
  return blankNativeDraft(
    state.mode === 'new' ? state.prefillTarget : undefined,
    state.mode === 'new' ? state.group : undefined,
  );
}

function initialDesktopDraft(state: OpenState): DesktopHostDraft {
  if (
    (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') &&
    (state.entry.profile.kind === 'rdp' || state.entry.profile.kind === 'vnc')
  ) {
    return desktopDraftFromProfile(state.entry, state.mode === 'duplicate-profile');
  }
  return blankDesktopDraft(
    state.mode === 'new' ? state.prefillTarget : undefined,
    state.mode === 'new' ? state.group : undefined,
  );
}

function initialShareDraft(state: OpenState): ShareHostDraft {
  if (
    (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') &&
    (state.entry.profile.kind === 'smb' || state.entry.profile.kind === 'nfs')
  ) {
    return shareDraftFromProfile(state.entry, state.mode === 'duplicate-profile');
  }
  return blankShareDraft(
    state.mode === 'new' ? state.prefillTarget : undefined,
    state.mode === 'new' ? state.group : undefined,
  );
}

function initialWinrmDraft(state: OpenState): WinrmHostDraft {
  if (
    (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') &&
    state.entry.profile.kind === 'winrm'
  ) {
    return winrmDraftFromProfile(state.entry, state.mode === 'duplicate-profile');
  }
  return blankWinrmDraft(
    state.mode === 'new' ? state.prefillTarget : undefined,
    state.mode === 'new' ? state.group : undefined,
  );
}

function initialWebDraft(state: OpenState): WebHostDraft {
  if (
    (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') &&
    state.entry.profile.kind === 'web'
  ) {
    return webDraftFromProfile(state.entry, state.mode === 'duplicate-profile');
  }
  return blankWebDraft(
    state.mode === 'new' ? state.prefillTarget : undefined,
    state.mode === 'new' ? state.group : undefined,
    state.mode === 'new' ? state.prefillGateway : undefined,
  );
}

function initialManagementDraft(state: OpenState): ManagementHostDraft {
  if (
    (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') &&
    (state.entry.profile.kind === 'gnmi' || state.entry.profile.kind === 'netconf')
  ) {
    return managementDraftFromProfile(state.entry, state.mode === 'duplicate-profile');
  }
  const draft = blankManagementDraft(
    state.mode === 'new' ? state.prefillTarget : undefined,
    state.mode === 'new' ? state.group : undefined,
    state.mode === 'new' ? state.prefillGateway : undefined,
  );
  return state.mode === 'new' && state.prefillName ? { ...draft, name: state.prefillName } : draft;
}

/**
 * The SSH editor persists either a standard OpenSSH Host block or a
 * self-contained Muxus database profile. Both paths share the same explicit
 * addressing, authentication, routing, forwarding, logging, and presentation
 * controls; only OpenSSH storage exposes raw ssh_config options.
 */
function SshHostEditorContent({
  state,
  draft,
  setDraft,
}: {
  state: SshEditorState;
  draft: HostDraft;
  setDraft: Dispatch<SetStateAction<HostDraft>>;
}) {
  const setState = useUiStore((s) => s.setHostEditor);
  const { data: config } = useSshConfig();
  const { data: savedData } = useSavedHostProfiles();
  const editingProfile =
    (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') &&
    state.entry.profile.kind === 'ssh'
      ? state.entry
      : undefined;
  const inheritedIdentityAgent =
    state.mode === 'edit' && state.entry.options.identityAgent === undefined
      ? state.entry.resolved.identityAgent
      : undefined;
  const detectedIdentityAgent = identityAgentForDetection(draft, inheritedIdentityAgent);
  const { data: keys } = useSshKeys(true, detectedIdentityAgent);
  const loggingPolicyKey =
    state.mode === 'edit'
      ? `ssh:${state.entry.alias}`
      : state.mode === 'edit-profile'
        ? `profile:${state.entry.id}`
        : '*';
  const { data: loggingPolicy } = useSessionLoggingPolicy(loggingPolicyKey);

  const [section, setSection] = useState<Section>('general');
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const connectAfter = useRef(false);
  const savedAlias = useRef('');
  const savedProfile = useRef<SavedHostProfile | undefined>(undefined);

  const editing = state.mode === 'edit' ? state.entry : undefined;
  const previousAlias = editing?.alias;

  const close = () => setState(false);
  const finish = () => {
    close();
    if (!connectAfter.current) return;
    if (draft.storage === 'muxus') {
      if (savedProfile.current) connectSavedHost(savedProfile.current);
      return;
    }
    const alias = draft.aliasText.trim().split(/\s+/)[0];
    if (alias) connectTarget(alias);
  };
  const saveLoggingPolicy = useSaveSessionLoggingPolicy(finish);
  const updateMetadata = useUpdateSshMetadata(() => {
    saveLoggingPolicy.mutate({
      profileKey: `ssh:${savedAlias.current}`,
      policy: draft.sessionLogging.inherit
        ? null
        : sessionLoggingPolicyInput(draft.sessionLogging),
    });
  });
  const updateProfileMetadata = useUpdateHostProfileMetadata((profile) => {
    savedProfile.current = profile;
    saveLoggingPolicy.mutate({
      profileKey: `profile:${profile.id}`,
      policy: draft.sessionLogging.inherit
        ? null
        : sessionLoggingPolicyInput(draft.sessionLogging),
    });
  });
  const upsert = useUpsertHost((req) => {
    savedAlias.current = req.aliases[0] ?? '';
    updateMetadata.mutate({ alias: req.aliases[0] ?? '', patch: metadataPatch(draft) });
  });
  const saveProfile = useSaveHostProfile((profile) => {
    savedProfile.current = profile;
    updateProfileMetadata.mutate({ id: profile.id, patch: metadataPatch(draft) });
  });
  const deleteHost = useDeleteHost(close);
  const deleteProfile = useDeleteHostProfile(close);

  // New and duplicated hosts may name a range, e.g. app[2-10], to create one
  // host per number in a single save.
  const creating = state.mode === 'new' || state.mode === 'duplicate' || state.mode === 'duplicate-profile';
  const sourceName =
    state.mode === 'duplicate'
      ? state.entry.alias
      : state.mode === 'duplicate-profile'
        ? state.entry.name
        : undefined;
  const existingNames = useMemo(
    () =>
      new Set(
        (draft.storage === 'openssh'
          ? (config?.hosts ?? []).flatMap((host) => host.aliases)
          : (savedData?.profiles ?? []).map((profile) => profile.name)
        ).map((name) => name.toLowerCase()),
      ),
    [draft.storage, config, savedData],
  );
  const range = creating ? expandDraftRange(draft, sourceName, existingNames) : undefined;
  const [rangeProgress, setRangeProgress] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const loading = draft.sessionLogging.loaded ? null : 'Loading session logging settings…';
  const problem = loading
    ? null
    : range
      ? (range.problem ?? (range.drafts[0] ? draftProblem(range.drafts[0]) : null))
      : draftProblem(draft);
  const previewDraft = range?.drafts[0] ?? draft;

  useEffect(() => {
    if (!loggingPolicy || draft.sessionLogging.loaded) return;
    setDraft((current) => {
      if (current.sessionLogging.loaded) return current;
      return {
        ...current,
        sessionLogging: hostSessionLoggingDraft(
          loggingPolicy,
          (state.mode !== 'edit' && state.mode !== 'edit-profile') ||
            !loggingPolicy.overridden,
        ),
      };
    });
  }, [draft.sessionLogging.loaded, loggingPolicy, setDraft, state.mode]);

  // Live preview of the exact block text, rendered by the server (debounced).
  useEffect(() => {
    if (problem || previewDraft.storage !== 'openssh') return;
    const timer = setTimeout(() => {
      fetchHostPreview(draftToRequest(previewDraft, previousAlias))
        .then((text) => {
          setPreview(text);
          setPreviewError(null);
        })
        .catch((err: unknown) => setPreviewError(err instanceof Error ? err.message : String(err)));
    }, 350);
    return () => clearTimeout(timer);
  }, [previewDraft, problem, previousAlias]);

  const set = (patch: Partial<HostDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const saveRange = async (drafts: HostDraft[], connect: boolean) => {
    let created = 0;
    let first: SavedHostProfile | undefined;
    try {
      for (const host of drafts) {
        setRangeProgress(`Creating ${host.aliasText} (${created + 1} of ${drafts.length})…`);
        const profile = await saveRangeHost(host);
        first ??= profile;
        created += 1;
      }
    } catch (err) {
      showErrorToast(err);
      if (created > 0) {
        showToast(
          'warning',
          `Created ${created} of ${drafts.length} hosts, then stopped at ${drafts[created]?.aliasText}.`,
        );
      }
    } finally {
      setRangeProgress(null);
      void queryClient.invalidateQueries({ queryKey: ['ssh-config'] });
      void queryClient.invalidateQueries({ queryKey: ['saved-host-profiles'] });
      void queryClient.invalidateQueries({ queryKey: ['session-logging-policy'] });
    }
    if (created < drafts.length) return;
    close();
    showToast('success', `Created ${created} hosts.`);
    if (!connect) return;
    if (first) connectSavedHost(first);
    else if (drafts[0]) connectTarget(drafts[0].aliasText);
  };

  const save = (connect: boolean) => {
    if (range) {
      void saveRange(range.drafts, connect);
      return;
    }
    connectAfter.current = connect;
    if (draft.storage === 'muxus') {
      saveProfile.mutate(
        draftToSavedSshInput(
          draft,
          state.mode === 'edit-profile'
            ? editingProfile?.id
            : savedProfile.current?.id,
        ),
      );
      return;
    }
    upsert.mutate(draftToRequest(draft, previousAlias));
  };

  const title =
    state.mode === 'edit'
      ? `Edit ${state.entry.alias}`
      : state.mode === 'duplicate'
        ? `Duplicate ${state.entry.alias}`
        : state.mode === 'edit-profile'
          ? `Edit ${state.entry.name}`
          : state.mode === 'duplicate-profile'
            ? `Duplicate ${state.entry.name}`
            : 'Add host';

  const sections: EditorSectionDef<Section>[] = [
    { value: 'general', label: 'General', icon: <DnsOutlinedIcon fontSize="small" /> },
    {
      value: 'appearance',
      label: 'Terminal appearance',
      icon: <PaletteOutlinedIcon fontSize="small" />,
      count: [
        draft.terminalScheme,
        draft.terminalFontColor,
        draft.terminalBackgroundColor,
        draft.commandButtonGroup,
        draft.pasteLineDelayMs !== undefined || draft.pasteCharDelayMs !== undefined,
        draft.pastePromptWait.enabled,
        draft.antiIdle.enabled,
        customTerminalInputModes(draft.inputModes),
      ].filter(Boolean).length || undefined,
    },
    { value: 'auth', label: 'Authentication', icon: <KeyOutlinedIcon fontSize="small" /> },
    {
      value: 'route',
      label: 'Connection route',
      icon: <AltRouteIcon fontSize="small" />,
      count:
        draft.routeMode === 'jump'
          ? draft.proxyJump.length
          : draft.routeMode === 'command'
            ? 1
            : undefined,
    },
    { value: 'forwards', label: 'Forwarding', icon: <SwapHorizOutlinedIcon fontSize="small" />, count: draft.forwards.length },
    {
      value: 'login',
      label: 'Login sequence',
      icon: <LoginOutlinedIcon fontSize="small" />,
      count: draft.loginSequence.mode === 'custom' ? draft.loginSequence.steps.length : undefined,
    },
    { value: 'logging', label: 'Session logging', icon: <HistoryOutlinedIcon fontSize="small" /> },
    {
      value: 'highlighting',
      label: 'Highlighting',
      icon: <HighlightOutlinedIcon fontSize="small" />,
      count:
        draft.keywordHighlights.rules.length +
        (draft.keywordHighlights.profileId ? 1 : 0),
    },
    {
      value: 'advanced',
      label: 'Advanced',
      icon: <CodeOutlinedIcon fontSize="small" />,
      count:
        draft.extras.length +
        (draft.disableSftp ? 1 : 0) +
        (draft.consoleCompatibility ? 1 : 0) +
        (draft.discoverEnvironments === 'default' ? 0 : 1),
    },
  ];

  return (
    <EditorShell
      title={title}
      storage={
        draft.storage === 'muxus'
          ? 'Saved in Muxus app data — ssh_config is unchanged'
          : `Saved to ${shortenSshPath(draft.file || config?.path || '~/.ssh/config')}`
      }
      typeKind={state.mode === 'new' ? 'ssh' : undefined}
      onTypeChange={
        state.mode === 'new'
          ? (kind) => setState({ ...state, kind })
          : undefined
      }
      sections={sections}
      section={section}
      onSection={setSection}
      problem={problem}
      loading={loading}
      busy={
        upsert.isPending ||
        updateMetadata.isPending ||
        saveProfile.isPending ||
        updateProfileMetadata.isPending ||
        saveLoggingPolicy.isPending ||
        rangeProgress !== null
      }
      onDelete={
        state.mode === 'edit'
          ? () => {
              const { alias, file } = state.entry;
              void confirmDeleteHost({ name: alias, sshFile: file }).then((confirmed) => {
                if (confirmed) deleteHost.mutate(alias);
              });
            }
          : state.mode === 'edit-profile' && editingProfile
            ? () => {
                void confirmDeleteHost({ name: editingProfile.name }).then(
                  (confirmed) => {
                    if (confirmed) deleteProfile.mutate(editingProfile.id);
                  },
                );
              }
            : undefined
      }
      deletePending={deleteHost.isPending || deleteProfile.isPending}
      onClose={close}
      onSave={save}
    >
      {section === 'general' && (
        <GeneralSection
          draft={draft}
          set={set}
          config={config}
          canChooseStorage={state.mode === 'new'}
          nameHelper={
            rangeProgress ??
            (range && !range.problem
              ? describeDraftRange(range.drafts)
              : state.mode === 'duplicate' || state.mode === 'duplicate-profile'
                ? `Tip: ${rangeExample(sourceName)} creates one copy per number`
                : undefined)
          }
        />
      )}
      {section === 'auth' && <AuthSection draft={draft} set={set} keys={keys} />}
      {section === 'appearance' && (
        <TerminalAppearanceSection value={draft} onChange={set} />
      )}
      {section === 'route' && (
        <RouteSection
          draft={draft}
          set={set}
          config={config}
          savedHosts={savedData?.profiles}
          selfProfileId={
            state.mode === 'edit-profile' ? editingProfile?.id : savedProfile.current?.id
          }
        />
      )}
      {section === 'forwards' && <ForwardsSection draft={draft} set={set} />}
      {section === 'login' && (
        <LoginSequenceSection
          value={draft.loginSequence}
          onChange={(loginSequence) => set({ loginSequence })}
          group={draft.group}
        />
      )}
      {section === 'logging' && (
        <LoggingSection
          value={draft.sessionLogging}
          onChange={(sessionLogging) =>
            set({
              sessionLogging: { ...draft.sessionLogging, ...sessionLogging },
            })
          }
        />
      )}
      {section === 'highlighting' && (
        <HighlightingSection
          config={draft.keywordHighlights}
          onChange={(keywordHighlights) => set({ keywordHighlights })}
        />
      )}
      {section === 'advanced' && (
        <AdvancedSection
          draft={draft}
          set={set}
          preview={preview}
          previewError={previewError}
          configBacked={draft.storage === 'openssh'}
        />
      )}
    </EditorShell>
  );
}

/** The Muxus-owned metadata both storages save next to the connection. */
function metadataPatch(draft: HostDraft): OpenSshMetadataPatch {
  const highlights = draft.keywordHighlights;
  return {
    displayName: draft.displayName.trim() || null,
    group: draft.group.trim() || null,
    color: draft.color ?? null,
    terminalScheme: draft.terminalScheme ?? null,
    terminalFontColor: draft.terminalFontColor ?? null,
    terminalBackgroundColor: draft.terminalBackgroundColor ?? null,
    commandButtonGroup: draft.commandButtonGroup ?? null,
    pasteLineDelayMs: draft.pasteLineDelayMs ?? null,
    pasteCharDelayMs: draft.pasteCharDelayMs ?? null,
    pastePromptWait: pastePromptWaitFromDraft(draft.pastePromptWait),
    antiIdle: antiIdleFromDraft(draft.antiIdle),
    ...terminalInputModesPatch(draft.inputModes),
    disableSftp: draft.disableSftp,
    consoleCompatibility: draft.consoleCompatibility,
    discoverEnvironments: environmentDiscoveryFromDraft(draft.discoverEnvironments),
    keywordHighlights:
      highlights.inheritGlobal && !highlights.profileId && highlights.rules.length === 0
        ? null
        : highlights,
    loginSequence: loginSequenceFromDraft(draft.loginSequence),
    // ssh_config cannot hold fallback routes; a Muxus host keeps them in its profile.
    ...(draft.storage === 'openssh'
      ? { proxyJumpFallbacks: draftJumpFallbacks(draft) ?? null }
      : {}),
  };
}

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Save one host of a range the way the single-host save chain does: the
 * connection, then its metadata, then its session logging override.
 */
async function saveRangeHost(draft: HostDraft): Promise<SavedHostProfile | undefined> {
  let profileKey: string;
  let profile: SavedHostProfile | undefined;
  if (draft.storage === 'muxus') {
    const saved = await apiFetch<SavedHostProfile>(
      '/api/profiles',
      jsonRequest('PUT', draftToSavedSshInput(draft)),
    );
    profile = await apiFetch<SavedHostProfile>(
      `/api/profiles/${encodeURIComponent(saved.id)}/metadata`,
      jsonRequest('PATCH', metadataPatch(draft)),
    );
    profileKey = `profile:${saved.id}`;
  } else {
    const req = draftToRequest(draft);
    const alias = req.aliases[0] ?? '';
    await apiFetch('/api/ssh/config/hosts', jsonRequest('POST', req));
    await apiFetch(
      `/api/ssh/config/hosts/${encodeURIComponent(alias)}/metadata`,
      jsonRequest('PATCH', metadataPatch(draft)),
    );
    profileKey = `ssh:${alias}`;
  }
  const url = `/api/session-history/policy?profileKey=${encodeURIComponent(profileKey)}`;
  if (draft.sessionLogging.inherit) {
    await apiFetch(url, { method: 'DELETE' });
  } else {
    await apiFetch(url, jsonRequest('PUT', sessionLoggingPolicyInput(draft.sessionLogging)));
  }
  return profile;
}
