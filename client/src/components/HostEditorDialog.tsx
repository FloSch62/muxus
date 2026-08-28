import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Dialog from '@mui/material/Dialog';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import HighlightOutlinedIcon from '@mui/icons-material/HighlightOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import type { SavedHostProfile } from '@muxus/shared';
import { useSessionLoggingPolicy, useSshConfig, useSshKeys } from '../api/queries.js';
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
import { confirmDeleteHost, shortenSshPath } from '../host-actions.js';
import { connectSavedHost, connectTarget } from '../session-actions.js';
import {
  hostSessionLoggingDraft,
  sessionLoggingPolicyInput,
} from '../session-logging-policy.js';
import { useUiStore, type HostEditorState } from '../state/ui.js';
import { AdvancedSection } from './host-editor/AdvancedSection.js';
import { AuthSection } from './host-editor/AuthSection.js';
import {
  blankDraft,
  draftFromEntry,
  draftFromSavedSshProfile,
  draftProblem,
  draftToRequest,
  draftToSavedSshInput,
  identityAgentForDetection,
  type HostDraft,
} from './host-editor/draft.js';
import { EditorShell, type EditorSectionDef } from './host-editor/EditorShell.js';
import { ForwardsSection } from './host-editor/ForwardsSection.js';
import { GeneralSection } from './host-editor/GeneralSection.js';
import { HighlightingSection } from './host-editor/HighlightingSection.js';
import { LoggingSection } from './host-editor/LoggingSection.js';
import { TerminalAppearanceSection } from './host-editor/TerminalAppearanceSection.js';
import {
  blankNativeDraft,
  nativeDraftFromProfile,
  type NativeHostDraft,
} from './host-editor/native-draft.js';
import { RouteSection } from './host-editor/RouteSection.js';
import { NativeHostEditorContent } from './NativeHostEditorContent.js';

type Section =
  | 'general'
  | 'appearance'
  | 'auth'
  | 'route'
  | 'forwards'
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
  const lastIdentity = useRef(stateIdentity(state));

  // Re-seed only when the edited entry itself changes — a connection-type
  // switch keeps the same identity, so both drafts survive it.
  useEffect(() => {
    const identity = stateIdentity(state);
    if (identity === lastIdentity.current) return;
    lastIdentity.current = identity;
    setSshDraft(initialSshDraft(state));
    setNativeDraft(initialNativeDraft(state));
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
  return (
    <NativeHostEditorContent
      state={state}
      kind={kind}
      draft={nativeDraft}
      setDraft={setNativeDraft}
    />
  );
}

function editorKind(state: OpenState): 'ssh' | 'telnet' | 'serial' {
  if (state.mode === 'new') return state.kind ?? 'ssh';
  if (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') {
    return state.entry.kind;
  }
  return 'ssh';
}

function stateIdentity(state: OpenState): string {
  if (state.mode === 'new') {
    return `new:${state.prefillTarget ?? ''}:${state.group ?? ''}`;
  }
  if (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') {
    return `${state.mode}:${state.entry.id}`;
  }
  return `${state.mode}:${state.entry.file}:${state.entry.alias}`;
}

function initialSshDraft(state: OpenState): HostDraft {
  if (state.mode === 'new') return blankDraft(state.prefillTarget, state.group);
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
    state.entry.profile.kind !== 'ssh'
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
    const highlights = draft.keywordHighlights;
    updateMetadata.mutate({
      alias: req.aliases[0] ?? '',
      patch: {
        displayName: draft.displayName.trim() || null,
        group: draft.group.trim() || null,
        color: draft.color ?? null,
        terminalScheme: draft.terminalScheme ?? null,
        terminalFontColor: draft.terminalFontColor ?? null,
        terminalBackgroundColor: draft.terminalBackgroundColor ?? null,
        disableSftp: draft.disableSftp,
        consoleCompatibility: draft.consoleCompatibility,
        keywordHighlights:
          highlights.inheritGlobal &&
          !highlights.profileId &&
          highlights.rules.length === 0
            ? null
            : highlights,
      },
    });
  });
  const saveProfile = useSaveHostProfile((profile) => {
    savedProfile.current = profile;
    const highlights = draft.keywordHighlights;
    updateProfileMetadata.mutate({
      id: profile.id,
      patch: {
        displayName: draft.displayName.trim() || null,
        group: draft.group.trim() || null,
        color: draft.color ?? null,
        terminalScheme: draft.terminalScheme ?? null,
        terminalFontColor: draft.terminalFontColor ?? null,
        terminalBackgroundColor: draft.terminalBackgroundColor ?? null,
        disableSftp: draft.disableSftp,
        consoleCompatibility: draft.consoleCompatibility,
        keywordHighlights:
          highlights.inheritGlobal &&
          !highlights.profileId &&
          highlights.rules.length === 0
            ? null
            : highlights,
      },
    });
  });
  const deleteHost = useDeleteHost(close);
  const deleteProfile = useDeleteHostProfile(close);

  const loading = draft.sessionLogging.loaded ? null : 'Loading session logging settings…';
  const problem = loading ? null : draftProblem(draft);

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
    if (problem || draft.storage !== 'openssh') return;
    const timer = setTimeout(() => {
      fetchHostPreview(draftToRequest(draft, previousAlias))
        .then((text) => {
          setPreview(text);
          setPreviewError(null);
        })
        .catch((err: unknown) => setPreviewError(err instanceof Error ? err.message : String(err)));
    }, 350);
    return () => clearTimeout(timer);
  }, [draft, problem, previousAlias]);

  const set = (patch: Partial<HostDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = (connect: boolean) => {
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
    { value: 'forwards', label: 'Port forwarding', icon: <SwapHorizOutlinedIcon fontSize="small" />, count: draft.forwards.length },
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
        (draft.consoleCompatibility ? 1 : 0),
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
        saveLoggingPolicy.isPending
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
        />
      )}
      {section === 'auth' && <AuthSection draft={draft} set={set} keys={keys} />}
      {section === 'appearance' && (
        <TerminalAppearanceSection value={draft} onChange={set} />
      )}
      {section === 'route' && <RouteSection draft={draft} set={set} config={config} />}
      {section === 'forwards' && <ForwardsSection draft={draft} set={set} />}
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
