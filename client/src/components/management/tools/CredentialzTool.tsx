import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import { GRPC_METHODS, type ManagementError } from '@muxus/shared';
import { parseAuthorizedKeys } from '../../../management/tool-format.js';
import { useWorkbench } from '../context.js';
import { compactFieldSx } from '../GnmiForm.js';
import { MONO_FONT } from '../PathText.js';
import { ErrorAlert, errorOf, Section, ToolHeader, useGrpc, useToolState } from './common.js';
import {
  finalizeRotation,
  rollBackRotation,
  RotationBar,
  rotationVersion,
  startRotation,
  type RotationState,
} from './rotation.js';

interface HostKey {
  text: string;
  type?: string;
  description?: string;
}

interface CredentialzState {
  hostKeys?: HostKey[];
  loading: boolean;
  account: string;
  keys: string;
  error?: ManagementError;
  rotation: RotationState;
}

export function CredentialzTool() {
  const { store, controller } = useWorkbench();
  const grpc = useGrpc();
  const defaultUser = controller.info?.address.includes('@') ? controller.info.address.split('@')[0]! : '';
  const [state, setState] = useToolState<CredentialzState>('credentialz', () => ({ loading: false, account: defaultUser, keys: '', rotation: { phase: 'idle' } }));
  const [loaded, setLoaded] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const setRotation = (rotation: Partial<RotationState>) =>
    setState((current) => ({ ...current, rotation: { ...current.rotation, ...rotation } }));
  const rotationPhase = () => (store.getState().tools.credentialz as CredentialzState | undefined)?.rotation.phase ?? 'idle';

  const load = async () => {
    if (!grpc) return;
    setState({ loading: true, error: undefined });
    try {
      const response = await grpc.grpcCall<{ public_keys?: Array<{ public_key?: string; key_type?: string; description?: string }> }>(
        GRPC_METHODS.credentialzPublicKeys,
        {},
      );
      const hostKeys = (response.public_keys ?? []).map((key) => ({
        text: key.public_key ? new TextDecoder().decode(Uint8Array.from(atob(key.public_key), (char) => char.charCodeAt(0))) : '',
        type: key.key_type?.replace('KEY_TYPE_', '').replace(/_/g, ' ').toLowerCase(),
        description: key.description,
      }));
      setState({ loading: false, hostKeys });
    } catch (err) {
      setState({ loading: false, error: errorOf(err) });
    }
  };

  useEffect(() => {
    if (grpc && !loaded) {
      setLoaded(true);
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grpc]);

  const parsed = useMemo(() => parseAuthorizedKeys(state.keys), [state.keys]);
  const problem = !state.account.trim() ? 'Enter the account.' : parsed.problem ?? (parsed.keys.length ? undefined : 'Add at least one public key.');

  const rotate = () => {
    if (!grpc || problem) return;
    const version = rotationVersion();
    startRotation(
      grpc,
      store,
      'credentialz',
      {
        method: GRPC_METHODS.credentialzRotateAccount,
        finalizeField: 'finalize',
        version,
        upload: {
          credential: {
            credentials: [
              {
                account: state.account.trim(),
                version,
                created_on: Math.floor(Date.now() / 1000),
                // gNSI wants the key data's base64 text itself as the bytes.
                authorized_keys: parsed.keys.map((key) => ({
                  authorized_key: btoa(key.blob),
                  key_type: key.keyType,
                  ...(key.comment ? { description: key.comment } : {}),
                })),
              },
            ],
          },
        },
      },
      setRotation,
      rotationPhase,
    );
  };

  const rotating = state.rotation.phase === 'pending' || state.rotation.phase === 'uploading' || state.rotation.phase === 'finalizing';

  return (
    <Box>
      <ToolHeader
        icon={<KeyOutlinedIcon fontSize="small" />}
        title="SSH credentials"
        service="gnsi.credentialz.v1.Credentialz"
        description="The device's SSH host keys, and the public keys an account may log in with. New keys stay provisional until you have tried them."
        actions={
          <Button size="small" onClick={() => void load()} disabled={!grpc || rotating}>
            Reload
          </Button>
        }
      />
      <RotationBar
        rotation={state.rotation}
        what="authorized keys"
        plural
        testHint="Open an SSH session with one of the new keys to check it works."
        onFinalize={() => finalizeRotation(store, 'credentialz', setRotation)}
        onRollBack={() => rollBackRotation(store, 'credentialz')}
        onDismiss={() => setRotation({ phase: 'idle', error: undefined })}
      />
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      <Section title="Host keys">
        {state.loading ? (
          <CircularProgress size={20} />
        ) : state.hostKeys?.length ? (
          <Stack spacing={1}>
            {state.hostKeys.map((key, index) => (
              <Stack key={index} direction="row" spacing={1} sx={{ alignItems: 'flex-start' }}>
                {key.type && <Chip size="small" label={key.type} sx={{ height: 20, fontSize: 11 }} />}
                <Typography sx={{ fontFamily: MONO_FONT, fontSize: 11.5, wordBreak: 'break-all', flex: 1 }}>{key.text}</Typography>
              </Stack>
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="textSecondary">
            The device lists no host keys over gNSI.
          </Typography>
        )}
      </Section>
      <Section
        title="Authorized keys"
        actions={
          <>
            <Button size="small" startIcon={<UploadFileOutlinedIcon />} onClick={() => fileInput.current?.click()}>
              Add a .pub file…
            </Button>
            <input
              ref={fileInput}
              type="file"
              hidden
              accept=".pub"
              onChange={(event) => {
                const picked = event.target.files?.[0];
                event.target.value = '';
                if (picked) void picked.text().then((text) => setState({ keys: `${state.keys.trim() ? `${state.keys.trim()}\n` : ''}${text.trim()}` }));
              }}
            />
          </>
        }
      >
        <Stack spacing={1.25}>
          <TextField
            size="small"
            label="Account"
            value={state.account}
            onChange={(event) => setState({ account: event.target.value })}
            slotProps={{ inputLabel: { shrink: true } }}
            sx={{ width: 220, ...compactFieldSx }}
          />
          <TextField
            multiline
            minRows={4}
            maxRows={12}
            label="Public keys, one per line"
            placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop"
            value={state.keys}
            onChange={(event) => setState({ keys: event.target.value })}
            slotProps={{ inputLabel: { shrink: true }, htmlInput: { spellCheck: false } }}
            sx={{ '& textarea': { fontFamily: MONO_FONT, fontSize: 12 } }}
          />
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            <Button variant="contained" disabled={!grpc || !!problem || rotating} onClick={rotate}>
              Replace keys
            </Button>
            <Typography variant="caption" color={parsed.problem ? 'error' : 'textSecondary'}>
              {problem ?? `${parsed.keys.length} ${parsed.keys.length === 1 ? 'key replaces' : 'keys replace'} every key ${state.account.trim()} may log in with now.`}
            </Typography>
          </Stack>
        </Stack>
      </Section>
    </Box>
  );
}
