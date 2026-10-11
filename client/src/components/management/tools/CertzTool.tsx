import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Stack from '@mui/material/Stack';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import CheckCircleRoundedIcon from '@mui/icons-material/CheckCircleRounded';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import ErrorRoundedIcon from '@mui/icons-material/ErrorRounded';
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined';
import WorkspacePremiumOutlinedIcon from '@mui/icons-material/WorkspacePremiumOutlined';
import { GRPC_METHODS, type ManagementError, type PresentedCertificateInfo } from '@muxus/shared';
import { confirmAction, promptForText } from '../../../state/dialogs.js';
import { useWorkbench } from '../context.js';
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

interface PemFile {
  name: string;
  text: string;
}

interface CertzState {
  profiles?: string[];
  loading: boolean;
  profile: string;
  certificate?: PemFile;
  key?: PemFile;
  ca?: PemFile;
  uploadedFingerprint?: string;
  presented?: PresentedCertificateInfo;
  checking: boolean;
  error?: ManagementError;
  rotation: RotationState;
}

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;

function pemBlocks(text: string, kind?: RegExp): string[] {
  return [...text.matchAll(PEM_BLOCK)].filter((match) => !kind || kind.test(match[1]!)).map((match) => match[0]);
}

function utf8Base64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** SHA-256 of a PEM certificate's DER, in the colon form TLS libraries print. */
async function certificateFingerprint(pem: string): Promise<string | undefined> {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  try {
    const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der));
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':');
  } catch {
    return undefined;
  }
}

/** A chain of certificates, leaf (or first) outermost, the way certz nests them through `parent`. */
function chain(certificates: string[], key?: string): Record<string, unknown> | undefined {
  const [first, ...rest] = certificates;
  if (!first) return undefined;
  return {
    certificate: {
      type: 'CERTIFICATE_TYPE_X509',
      encoding: 'CERTIFICATE_ENCODING_PEM',
      raw_certificate: utf8Base64(first),
      ...(key ? { raw_private_key: utf8Base64(key) } : {}),
    },
    ...(rest.length ? { parent: chain(rest) } : {}),
  };
}

function PemPicker({ label, file, accept, onPick }: { label: string; file?: PemFile; accept: string; onPick: (file: PemFile) => void }) {
  const input = useRef<HTMLInputElement | null>(null);
  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
      <Typography variant="body2" sx={{ width: 120 }}>
        {label}
      </Typography>
      <Button size="small" variant="outlined" startIcon={<UploadFileOutlinedIcon />} onClick={() => input.current?.click()}>
        Choose…
      </Button>
      <Typography variant="body2" color={file ? 'textPrimary' : 'textSecondary'} sx={{ fontFamily: file ? MONO_FONT : undefined, fontSize: 12.5 }} noWrap>
        {file ? file.name : 'none'}
      </Typography>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        onChange={(event) => {
          const picked = event.target.files?.[0];
          event.target.value = '';
          if (picked) void picked.text().then((text) => onPick({ name: picked.name, text }));
        }}
      />
    </Stack>
  );
}

export function CertzTool() {
  const { store, controller, profile } = useWorkbench();
  const grpc = useGrpc();
  const [state, setState] = useToolState<CertzState>('certz', () => ({ loading: false, profile: '', checking: false, rotation: { phase: 'idle' } }));
  const [loaded, setLoaded] = useState(false);
  const setRotation = (rotation: Partial<RotationState>) =>
    setState((current) => ({ ...current, rotation: { ...current.rotation, ...rotation } }));
  const rotationPhase = () => (store.getState().tools.certz as CertzState | undefined)?.rotation.phase ?? 'idle';

  const load = async () => {
    if (!grpc) return;
    setState({ loading: true, error: undefined });
    try {
      const response = await grpc.grpcCall<{ ssl_profile_ids?: string[] }>(GRPC_METHODS.certzProfiles, {});
      const profiles = response.ssl_profile_ids ?? [];
      setState((current) => ({ ...current, loading: false, profiles, profile: current.profile || profiles[0] || '' }));
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

  const addProfile = async () => {
    if (!grpc) return;
    const id = await promptForText({ title: 'Add an SSL profile', label: 'Profile id', placeholder: 'grpc-server' });
    if (!id?.trim()) return;
    try {
      await grpc.grpcCall(GRPC_METHODS.certzAddProfile, { ssl_profile_id: id.trim() });
      setState({ profile: id.trim() });
      void load();
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  const deleteProfile = async (id: string) => {
    if (!grpc) return;
    const confirmed = await confirmAction({
      title: `Delete the SSL profile ${id}?`,
      description: 'Services that use it lose their certificates.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await grpc.grpcCall(GRPC_METHODS.certzDeleteProfile, { ssl_profile_id: id });
      if (state.profile === id) setState({ profile: '' });
      void load();
    } catch (err) {
      setState({ error: errorOf(err) });
    }
  };

  const certificates = state.certificate ? pemBlocks(state.certificate.text, /CERTIFICATE/) : [];
  const keyBlock = state.key ? pemBlocks(state.key.text, /PRIVATE KEY/)[0] : undefined;
  const caBlocks = state.ca ? pemBlocks(state.ca.text, /CERTIFICATE/) : [];
  const problem = !state.profile
    ? 'Choose a profile.'
    : !certificates.length
      ? 'Choose a certificate (PEM).'
      : !keyBlock
        ? 'Choose its private key (PEM).'
        : undefined;

  const upload = async () => {
    if (!grpc || problem) return;
    const version = rotationVersion();
    const createdOn = Math.floor(Date.now() / 1000);
    const entities: Array<Record<string, unknown>> = [{ version, created_on: createdOn, certificate_chain: chain(certificates, keyBlock) }];
    if (caBlocks.length) entities.push({ version, created_on: createdOn, trust_bundle: chain(caBlocks) });
    setState({ uploadedFingerprint: await certificateFingerprint(certificates[0]!), presented: undefined });
    startRotation(
      grpc,
      store,
      'certz',
      {
        method: GRPC_METHODS.certzRotate,
        finalizeField: 'finalize_rotation',
        version,
        upload: { ssl_profile_id: state.profile, certificates: { entities } },
      },
      setRotation,
      rotationPhase,
    );
  };

  /** Connect again and see which certificate the device presents now. */
  const check = async () => {
    if (!grpc) return;
    setState({ checking: true });
    try {
      const outcome = await grpc.request({ op: 'tls-probe' }).promise;
      if (outcome.result.op === 'tls-probe') setState({ presented: outcome.result.certificate, checking: false });
    } catch (err) {
      setState({ checking: false, error: errorOf(err) });
    }
  };

  const matches = state.presented && state.uploadedFingerprint && state.presented.fingerprint === state.uploadedFingerprint;
  const rotating = state.rotation.phase === 'pending' || state.rotation.phase === 'uploading' || state.rotation.phase === 'finalizing';
  const plaintext = profile.kind === 'gnmi' && profile.tls === 'plaintext';

  return (
    <Box>
      <ToolHeader
        icon={<WorkspacePremiumOutlinedIcon fontSize="small" />}
        title="Certificates"
        service="gnsi.certz.v1.Certz"
        description="Replace the certificate, key and trusted authorities of the device's TLS profiles. Muxus checks that the device presents the new certificate before you make it final."
        actions={
          <Button size="small" onClick={() => void load()} disabled={!grpc || rotating}>
            Reload
          </Button>
        }
      />
      <RotationBar
        rotation={state.rotation}
        what="certificate"
        testHint="Check below that the device presents it."
        onFinalize={() => finalizeRotation(store, 'certz', setRotation)}
        onRollBack={() => rollBackRotation(store, 'certz')}
        onDismiss={() => setRotation({ phase: 'idle', error: undefined })}
      />
      <ErrorAlert error={state.error} onClose={() => setState({ error: undefined })} />
      <Section title="SSL profiles" actions={<Button size="small" disabled={!grpc} onClick={() => void addProfile()}>Add…</Button>}>
        {state.loading ? (
          <CircularProgress size={20} />
        ) : (
          <Stack direction="row" useFlexGap spacing={1} sx={{ flexWrap: 'wrap' }}>
            {(state.profiles ?? []).map((id) => (
              <Chip
                key={id}
                label={id}
                color={state.profile === id ? 'primary' : 'default'}
                variant={state.profile === id ? 'filled' : 'outlined'}
                onClick={() => setState({ profile: id })}
                onDelete={rotating ? undefined : () => void deleteProfile(id)}
                deleteIcon={
                  <Tooltip title="Delete profile">
                    <DeleteOutlineIcon />
                  </Tooltip>
                }
                sx={{ fontFamily: MONO_FONT }}
              />
            ))}
            {state.profiles?.length === 0 && (
              <Typography variant="body2" color="textSecondary">
                The device lists no profiles.
              </Typography>
            )}
          </Stack>
        )}
      </Section>
      <Section title={state.profile ? `New certificate for ${state.profile}` : 'New certificate'}>
        <Stack spacing={1.25}>
          <PemPicker label="Certificate" file={state.certificate} accept=".pem,.crt,.cer" onPick={(certificate) => setState({ certificate })} />
          <PemPicker label="Private key" file={state.key} accept=".pem,.key" onPick={(key) => setState({ key })} />
          <PemPicker label="CA bundle" file={state.ca} accept=".pem,.crt" onPick={(ca) => setState({ ca })} />
          {certificates.length > 1 && (
            <Typography variant="caption" color="textSecondary">
              {certificates.length} certificates: the first is the device's, the rest its chain.
            </Typography>
          )}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center', pt: 0.5 }}>
            <Button variant="contained" disabled={!grpc || !!problem || rotating} onClick={() => void upload()}>
              Upload…
            </Button>
            <Typography variant="caption" color="textSecondary">
              {problem ?? 'The key travels to the device inside this session’s TLS connection; Muxus does not keep it.'}
            </Typography>
          </Stack>
        </Stack>
      </Section>
      {(state.rotation.phase === 'pending' || state.presented) && (
        <Section
          title="What the device presents"
          actions={
            <Button size="small" disabled={!grpc || state.checking || plaintext} onClick={() => void check()}>
              {state.checking ? 'Checking …' : 'Check now'}
            </Button>
          }
        >
          {plaintext ? (
            <Alert severity="info">This session runs without TLS, so Muxus cannot see the certificate. Check it another way before finalizing.</Alert>
          ) : state.presented ? (
            <Box
              sx={(theme) => ({
                border: 1,
                borderRadius: 1.5,
                p: 1.5,
                borderColor: matches ? 'success.main' : 'warning.main',
                bgcolor: alpha(matches ? theme.palette.success.main : theme.palette.warning.main, 0.06),
              })}
            >
              <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
                {matches ? <CheckCircleRoundedIcon sx={{ color: 'success.main' }} /> : <ErrorRoundedIcon sx={{ color: 'warning.main' }} />}
                <Typography variant="body2" sx={{ fontWeight: 650 }}>
                  {matches
                    ? 'The device presents the new certificate.'
                    : 'The device still presents a different certificate. This profile may not be the one its gRPC server uses.'}
                </Typography>
              </Stack>
              <Typography variant="caption" sx={{ display: 'block' }}>
                {state.presented.subject}
              </Typography>
              <Typography variant="caption" color="textSecondary" sx={{ display: 'block' }}>
                issued by {state.presented.issuer} · valid until {state.presented.validTo}
              </Typography>
              <Typography variant="caption" color="textSecondary" sx={{ display: 'block', fontFamily: MONO_FONT, wordBreak: 'break-all', mt: 0.5 }}>
                {state.presented.fingerprint}
              </Typography>
            </Box>
          ) : (
            <Typography variant="body2" color="textSecondary">
              Muxus opens a new TLS connection and compares the certificate it gets with the one you uploaded.
            </Typography>
          )}
        </Section>
      )}
      {controller.gnmiInfo?.tls.mode === 'verify' && state.rotation.phase === 'done' && (
        <Typography variant="caption" color="textSecondary">
          The next connection shows the new certificate for trust if it does not verify.
        </Typography>
      )}
    </Box>
  );
}
