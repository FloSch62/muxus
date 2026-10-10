/**
 * Shapes shared by the NETCONF and gNMI management sessions on
 * /ws/management. The backend speaks the device protocols (NETCONF over an
 * SSH subsystem, gNMI over gRPC) and hands the client decoded, JSON-friendly
 * messages: gNMI values are already unwrapped from their TypedValue and paths
 * are gNMI path strings.
 */

export type ManagementProtocol = 'gnmi' | 'netconf';

export const GNMI_DEFAULT_PORT = 57400;
export const NETCONF_DEFAULT_PORT = 830;

export type GnmiEncoding = 'json_ietf' | 'json' | 'proto' | 'ascii' | 'bytes';
export const GNMI_ENCODINGS: readonly GnmiEncoding[] = ['json_ietf', 'json', 'proto', 'ascii', 'bytes'];

export type GnmiDataType = 'all' | 'config' | 'state' | 'operational';
export const GNMI_DATA_TYPES: readonly GnmiDataType[] = ['all', 'config', 'state', 'operational'];

export type GnmiSubscriptionListMode = 'stream' | 'once' | 'poll';
export type GnmiSubscriptionMode = 'target-defined' | 'on-change' | 'sample';

/** How a gNMI host secures its connection. */
export type GnmiTlsMode =
  /** Verify the certificate; one that does not verify is shown once and pinned. */
  | 'verify'
  /** TLS without checking the certificate at all (lab devices with throwaway certificates). */
  | 'skip-verify'
  /** Plain-text HTTP/2: no encryption. */
  | 'plaintext';

export type GnmiValueType =
  | 'json'
  | 'json_ietf'
  | 'string'
  | 'int'
  | 'uint'
  | 'bool'
  | 'double'
  | 'float'
  | 'decimal'
  | 'bytes'
  | 'ascii'
  | 'leaflist'
  | 'any'
  | 'proto'
  | 'none';

/**
 * A TypedValue, unwrapped. JSON encodings are parsed; 64-bit integers stay
 * numbers while they are exact and become decimal strings beyond that;
 * bytes are base64.
 */
export interface GnmiValue {
  type: GnmiValueType;
  value: unknown;
}

export interface GnmiUpdate {
  /** Absolute path: the notification prefix joined with the update's own path. */
  path: string;
  value: GnmiValue;
  duplicates?: number;
}

export interface GnmiNotification {
  /** Nanoseconds since the epoch, as a decimal string (exceeds 2^53). */
  timestamp: string;
  prefix?: string;
  atomic?: boolean;
  updates: GnmiUpdate[];
  /** Absolute paths the device removed. */
  deletes: string[];
}

export interface GnmiModel {
  name: string;
  organization: string;
  version: string;
}

export interface ManagementTlsInfo {
  mode: GnmiTlsMode;
  /** The certificate verified against trusted authorities and named the host. */
  verified?: boolean;
  /** The certificate was accepted because it is the one pinned before. */
  pinned?: boolean;
  fingerprint?: string;
  subject?: string;
  issuer?: string;
  validTo?: string;
  protocol?: string;
}

interface ManagementSessionBase {
  /** user@host:port as dialed. */
  address: string;
  /** SSH gateway or jump host the session runs through. */
  via?: string;
  connectedAt: string;
}

export interface GnmiSessionInfo extends ManagementSessionBase {
  protocol: 'gnmi';
  version: string;
  encodings: GnmiEncoding[];
  models: GnmiModel[];
  tls: ManagementTlsInfo;
  /**
   * gRPC services the server lists through reflection (gnoi.system.System,
   * gnsi.authz.v1.Authz, …); absent when it does not offer reflection.
   */
  services?: string[];
}

export interface NetconfSessionInfo extends ManagementSessionBase {
  protocol: 'netconf';
  sessionId: string;
  /** Framing in use: 1.1 (chunked) when both ends offered it. */
  base: '1.0' | '1.1';
  capabilities: string[];
  serverSoftware?: string;
}

export type ManagementSessionInfo = GnmiSessionInfo | NetconfSessionInfo;

export interface GnmiSetResult {
  path: string;
  op: 'update' | 'replace' | 'delete' | 'union-replace' | 'invalid';
}

/** What a finished request returns, by request op. */
export type ManagementResult =
  | { op: 'gnmi-capabilities'; info: GnmiSessionInfo }
  | { op: 'gnmi-get'; notifications: GnmiNotification[] }
  | { op: 'gnmi-set'; timestamp: string; results: GnmiSetResult[] }
  | { op: 'netconf-rpc'; xml: string; messageId: string }
  /** A unary gNOI/gNSI call: the response in its JSON form. */
  | { op: 'grpc-call'; method: string; response: GrpcJson }
  /** A file download finished; its bytes arrived as `gnoi-file-data` messages. */
  | { op: 'gnoi-file-get'; size: number; verified: boolean; hashMethod?: string }
  | { op: 'gnoi-file-put'; size: number }
  /** The certificate the device presents on a fresh TLS connection right now. */
  | { op: 'tls-probe'; certificate: PresentedCertificateInfo };

export interface PresentedCertificateInfo {
  fingerprint: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  /** Why it does not verify against trusted authorities, if it does not. */
  verificationError?: string;
}

/**
 * A gNOI/gNSI protobuf message as JSON: proto field names, enums by name,
 * bytes as base64, 64-bit integers as numbers while exact and as decimal
 * strings beyond.
 */
export type GrpcJson = { [field: string]: unknown };

/** gNOI and gNSI calls the workbench makes, by gRPC method path. */
export const GRPC_METHODS = {
  ping: '/gnoi.system.System/Ping',
  traceroute: '/gnoi.system.System/Traceroute',
  time: '/gnoi.system.System/Time',
  reboot: '/gnoi.system.System/Reboot',
  rebootStatus: '/gnoi.system.System/RebootStatus',
  cancelReboot: '/gnoi.system.System/CancelReboot',
  killProcess: '/gnoi.system.System/KillProcess',
  fileStat: '/gnoi.file.File/Stat',
  fileRemove: '/gnoi.file.File/Remove',
  healthzGet: '/gnoi.healthz.Healthz/Get',
  healthzList: '/gnoi.healthz.Healthz/List',
  healthzAcknowledge: '/gnoi.healthz.Healthz/Acknowledge',
  healthzCheck: '/gnoi.healthz.Healthz/Check',
  bgpClear: '/gnoi.bgp.BGP/ClearBGPNeighbor',
  osVerify: '/gnoi.os.OS/Verify',
  authzGet: '/gnsi.authz.v1.Authz/Get',
  authzProbe: '/gnsi.authz.v1.Authz/Probe',
  authzRotate: '/gnsi.authz.v1.Authz/Rotate',
  pathzGet: '/gnsi.pathz.v1.Pathz/Get',
  pathzProbe: '/gnsi.pathz.v1.Pathz/Probe',
  pathzRotate: '/gnsi.pathz.v1.Pathz/Rotate',
  certzProfiles: '/gnsi.certz.v1.Certz/GetProfileList',
  certzAddProfile: '/gnsi.certz.v1.Certz/AddProfile',
  certzDeleteProfile: '/gnsi.certz.v1.Certz/DeleteProfile',
  certzRotate: '/gnsi.certz.v1.Certz/Rotate',
  credentialzPublicKeys: '/gnsi.credentialz.v1.Credentialz/GetPublicKeys',
  credentialzRotateAccount: '/gnsi.credentialz.v1.Credentialz/RotateAccountCredentials',
  acctzStream: '/gnsi.acctz.v1.AcctzStream/RecordSubscribe',
  acctzBidi: '/gnsi.acctz.v1.Acctz/RecordSubscribe',
} as const;

/** A gRPC status, or a NETCONF transport problem, as the client shows it. */
export interface ManagementError {
  message: string;
  /** gRPC status name (`UNAVAILABLE`, `INVALID_ARGUMENT`, …) for gNMI. */
  code?: string;
  /** The request was cancelled from the client. */
  cancelled?: boolean;
}

/** Text frames the server sends on /ws/management besides the shared login round-trips. */
export type ManagementStreamMessage =
  | {
      op: 'result';
      id: string;
      result: ManagementResult;
      durationMs: number;
      /** Encoded size of the response, as received from the device. */
      bytes: number;
    }
  | { op: 'error'; id: string; error: ManagementError; durationMs: number }
  /** Subscription updates, batched by the backend. */
  | { op: 'gnmi-notifications'; id: string; notifications: GnmiNotification[]; bytes: number }
  /** The device finished sending the initial state of a subscription. */
  | { op: 'gnmi-sync'; id: string }
  /** A subscription ended: ONCE completed, the device closed it, or it was cancelled. */
  | { op: 'stream-end'; id: string; error?: ManagementError }
  /** A NETCONF <notification>, after <create-subscription>. */
  | { op: 'netconf-notification'; xml: string; eventTime?: string; receivedAt: string }
  /** Messages of a streaming gNOI/gNSI call, batched by the backend. */
  | { op: 'grpc-messages'; id: string; messages: GrpcJson[] }
  /** A chunk of a file download, base64. */
  | { op: 'gnoi-file-data'; id: string; data: string }
  /** An upload chunk reached the device; send the next one. */
  | { op: 'gnoi-file-ack'; id: string; bytes: number };

/**
 * A request kept in a host's library. The request itself is the client's
 * editor state (operation, paths, options, body), stored as given.
 */
export interface SavedManagementRequest {
  id: string;
  protocol: ManagementProtocol;
  /** The saved host it belongs to; absent offers it for every host of the protocol. */
  profileId?: string;
  name: string;
  request: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SavedManagementRequestInput {
  id?: string;
  protocol: ManagementProtocol;
  profileId?: string;
  name: string;
  request: Record<string, unknown>;
}
