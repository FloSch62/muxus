import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Dialog from '@mui/material/Dialog';
import AltRouteIcon from '@mui/icons-material/AltRoute';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import HighlightOutlinedIcon from '@mui/icons-material/HighlightOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import SwapHorizOutlinedIcon from '@mui/icons-material/SwapHorizOutlined';
import { useSessionLoggingPolicy } from '../api/queries.js';
import { useSaveSessionLoggingPolicy } from '../api/session-history.js';
import { useSshConfig, useSshKeys } from '../api/queries.js';
import {
  fetchHostPreview,
  useDeleteHost,
  useUpdateSshMetadata,
  useUpsertHost,
} from '../api/ssh-config.js';
import { confirmDeleteHost, shortenSshPath } from '../host-actions.js';
import { connectTarget } from '../session-actions.js';
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
  draftProblem,
  draftToRequest,
  identityAgentForDetection,
  type HostDraft,
} from './host-editor/draft.js';
import { EditorShell, type EditorSectionDef } from './host-editor/EditorShell.js';
import { ForwardsSection } from './host-editor/ForwardsSection.js';
import { GeneralSection } from './host-editor/GeneralSection.js';
import { HighlightingSection } from './host-editor/HighlightingSection.js';
import { LoggingSection } from './host-editor/LoggingSection.js';
import {
  blankNativeDraft,
  nativeDraftFromProfile,
  type NativeHostDraft,
} from './host-editor/native-draft.js';
import { RouteSection } from './host-editor/RouteSection.js';
import { NativeHostEditorContent } from './NativeHostEditorContent.js';

type Section =
  | 'general'
  | 'auth'
  | 'route'
  | 'forwards'
  | 'logging'
  | 'highlighting'
  | 'advanced';
type OpenState = Exclude<HostEditorState, false>;
type SshEditorState = Extract<OpenState, { mode: 'new' | 'duplicate' | 'edit' }>;

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
  if (state.mode === 'new') return `new:${state.prefillTarget ?? ''}`;
  if (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') {
    return `${state.mode}:${state.entry.id}`;
  }
  return `${state.mode}:${state.entry.file}:${state.entry.alias}`;
}

function initialSshDraft(state: OpenState): HostDraft {
  if (state.mode === 'new') return blankDraft(state.prefillTarget);
  if (state.mode === 'edit' || state.mode === 'duplicate') {
    return draftFromEntry(state.entry, state.mode === 'duplicate');
  }
  return blankDraft();
}

function initialNativeDraft(state: OpenState): NativeHostDraft {
  if (state.mode === 'edit-profile' || state.mode === 'duplicate-profile') {
    return nativeDraftFromProfile(state.entry, state.mode === 'duplicate-profile');
  }
  return blankNativeDraft(state.mode === 'new' ? state.prefillTarget : undefined);
}

/**
 * The Host block editor — Muxus's session editor. Everything here reads and
 * writes ~/.ssh/config: general addressing, authentication (key picker with
 * agent awareness), direct/ProxyJump/ProxyCommand routing, port forwards with
 * the live tunnel diagram, and free-form options with an exact preview.
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
  const inheritedIdentityAgent =
    state.mode === 'edit' && state.entry.options.identityAgent === undefined
      ? state.entry.resolved.identityAgent
      : undefined;
  const detectedIdentityAgent = identityAgentForDetection(draft, inheritedIdentityAgent);
  const { data: keys } = useSshKeys(true, detectedIdentityAgent);
  const loggingPolicyKey =
    state.mode === 'edit' ? `ssh:${state.entry.alias}` : '*';
  const { data: loggingPolicy } = useSessionLoggingPolicy(loggingPolicyKey);

  const [section, setSection] = useState<Section>('general');
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const connectAfter = useRef(false);
  const savedAlias = useRef('');

  const editing = state.mode === 'edit' ? state.entry : undefined;
  const previousAlias = editing?.alias;

  const close = () => setState(false);
  const finish = () => {
    close();
    const alias = draft.aliasText.trim().split(/\s+/)[0];
    if (connectAfter.current && alias) connectTarget(alias);
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
  const upsert = useUpsertHost((req) => {
    savedAlias.current = req.aliases[0] ?? '';
    const highlights = draft.keywordHighlights;
    updateMetadata.mutate({
      alias: req.aliases[0] ?? '',
      patch: {
        displayName: draft.displayName.trim() || null,
        group: draft.group.trim() || null,
        color: draft.color ?? null,
        keywordHighlights:
          highlights.inheritGlobal && highlights.rules.length === 0 ? null : highlights,
      },
    });
  });
  const deleteHost = useDeleteHost(close);

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
          state.mode !== 'edit' || !loggingPolicy.overridden,
        ),
      };
    });
  }, [draft.sessionLogging.loaded, loggingPolicy, setDraft, state.mode]);

  // Live preview of the exact block text, rendered by the server (debounced).
  useEffect(() => {
    if (problem) return;
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
    upsert.mutate(draftToRequest(draft, previousAlias));
  };

  const title = state.mode === 'edit' ? `Edit ${state.entry.alias}` : state.mode === 'duplicate' ? `Duplicate ${state.entry.alias}` : 'Add host';

  const sections: EditorSectionDef<Section>[] = [
    { value: 'general', label: 'General', icon: <DnsOutlinedIcon fontSize="small" /> },
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
    { value: 'highlighting', label: 'Highlighting', icon: <HighlightOutlinedIcon fontSize="small" />, count: draft.keywordHighlights.rules.length },
    { value: 'advanced', label: 'Advanced', icon: <CodeOutlinedIcon fontSize="small" />, count: draft.extras.length },
  ];

  return (
    <EditorShell
      title={title}
      storage={`Saved to ${shortenSshPath(draft.file || config?.path || '~/.ssh/config')}`}
      typeKind={state.mode === 'new' ? 'ssh' : undefined}
      onTypeChange={
        state.mode === 'new'
          ? (kind) => setState({ mode: 'new', kind, prefillTarget: state.prefillTarget })
          : undefined
      }
      sections={sections}
      section={section}
      onSection={setSection}
      problem={problem}
      loading={loading}
      busy={upsert.isPending || updateMetadata.isPending || saveLoggingPolicy.isPending}
      onDelete={
        state.mode === 'edit'
          ? () => {
              const { alias, file } = state.entry;
              void confirmDeleteHost({ name: alias, sshFile: file }).then((confirmed) => {
                if (confirmed) deleteHost.mutate(alias);
              });
            }
          : undefined
      }
      deletePending={deleteHost.isPending}
      onClose={close}
      onSave={save}
    >
      {section === 'general' && <GeneralSection draft={draft} set={set} config={config} />}
      {section === 'auth' && <AuthSection draft={draft} set={set} keys={keys} />}
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
      {section === 'advanced' && <AdvancedSection draft={draft} set={set} preview={preview} previewError={previewError} />}
    </EditorShell>
  );
}
