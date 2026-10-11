import type { MessageDef } from '../gnmi/protobuf.js';
import { Path as GnmiPath } from '../gnmi/schema.js';
import { Any, Empty, enumField, message, Timestamp } from './gnoi.js';

/**
 * gNSI messages Muxus uses, transcribed from openconfig/gnsi: authz,
 * pathz, certz (profiles and certificate upload), credentialz (host keys
 * and authorized keys) and acctz, plus gRPC server reflection for finding
 * out which services a device offers.
 */

// authz

const AuthzUploadRequest: MessageDef = {
  name: 'gnsi.authz.v1.UploadRequest',
  fields: [
    { no: 1, name: 'version', type: 'string' },
    { no: 2, name: 'created_on', type: 'uint64' },
    { no: 3, name: 'policy', type: 'string' },
  ],
};

const AuthzRotateRequest: MessageDef = {
  name: 'gnsi.authz.v1.RotateAuthzRequest',
  fields: [
    message(1, 'upload_request', () => AuthzUploadRequest),
    message(2, 'finalize_rotation', () => Empty),
    { no: 3, name: 'force_overwrite', type: 'bool' },
    { no: 4, name: 'authz_profile_id', type: 'string' },
  ],
};

const AuthzRotateResponse: MessageDef = {
  name: 'gnsi.authz.v1.RotateAuthzResponse',
  fields: [message(1, 'upload_response', () => Empty)],
};

const PROBE_ACTION = { ACTION_UNSPECIFIED: 0, ACTION_DENY: 1, ACTION_PERMIT: 2 };

const AuthzProbeRequest: MessageDef = {
  name: 'gnsi.authz.v1.ProbeRequest',
  fields: [
    { no: 1, name: 'user', type: 'string' },
    { no: 2, name: 'rpc', type: 'string' },
  ],
};

const AuthzProbeResponse: MessageDef = {
  name: 'gnsi.authz.v1.ProbeResponse',
  fields: [enumField(1, 'action', PROBE_ACTION), { no: 2, name: 'version', type: 'string' }],
};

const AuthzGetRequest: MessageDef = {
  name: 'gnsi.authz.v1.GetRequest',
  fields: [{ no: 1, name: 'authz_profile_id', type: 'string' }],
};

const AuthzGetResponse: MessageDef = {
  name: 'gnsi.authz.v1.GetResponse',
  fields: [
    { no: 1, name: 'version', type: 'string' },
    { no: 2, name: 'created_on', type: 'uint64' },
    { no: 3, name: 'policy', type: 'string' },
  ],
};

// pathz

const PATHZ_MODE = { MODE_UNSPECIFIED: 0, MODE_READ: 1, MODE_WRITE: 2 };
const POLICY_INSTANCE = { POLICY_INSTANCE_UNSPECIFIED: 0, POLICY_INSTANCE_ACTIVE: 1, POLICY_INSTANCE_SANDBOX: 2 };

const PathzUser: MessageDef = { name: 'gnsi.pathz.v1.User', fields: [{ no: 1, name: 'name', type: 'string' }] };
const PathzGroup: MessageDef = {
  name: 'gnsi.pathz.v1.Group',
  fields: [{ no: 1, name: 'name', type: 'string' }, message(2, 'users', () => PathzUser, true)],
};

const PathzRule: MessageDef = {
  name: 'gnsi.pathz.v1.AuthorizationRule',
  fields: [
    { no: 1, name: 'id', type: 'string' },
    { no: 2, name: 'user', type: 'string' },
    { no: 3, name: 'group', type: 'string' },
    message(4, 'path', () => GnmiPath),
    enumField(5, 'action', PROBE_ACTION),
    enumField(6, 'mode', PATHZ_MODE),
  ],
};

const PathzPolicy: MessageDef = {
  name: 'gnsi.pathz.v1.AuthorizationPolicy',
  fields: [message(1, 'rules', () => PathzRule, true), message(2, 'groups', () => PathzGroup, true)],
};

const PathzUploadRequest: MessageDef = {
  name: 'gnsi.pathz.v1.UploadRequest',
  fields: [
    { no: 1, name: 'version', type: 'string' },
    { no: 2, name: 'created_on', type: 'uint64' },
    message(3, 'policy', () => PathzPolicy),
  ],
};

const PathzRotateRequest: MessageDef = {
  name: 'gnsi.pathz.v1.RotateRequest',
  fields: [
    message(1, 'upload_request', () => PathzUploadRequest),
    message(2, 'finalize_rotation', () => Empty),
    { no: 3, name: 'force_overwrite', type: 'bool' },
  ],
};

const PathzRotateResponse: MessageDef = {
  name: 'gnsi.pathz.v1.RotateResponse',
  fields: [message(1, 'upload', () => Empty)],
};

const PathzProbeRequest: MessageDef = {
  name: 'gnsi.pathz.v1.ProbeRequest',
  fields: [
    { no: 1, name: 'user', type: 'string' },
    message(2, 'path', () => GnmiPath),
    enumField(3, 'mode', PATHZ_MODE),
    enumField(4, 'policy_instance', POLICY_INSTANCE),
  ],
};

const PathzProbeResponse: MessageDef = {
  name: 'gnsi.pathz.v1.ProbeResponse',
  fields: [enumField(1, 'action', PROBE_ACTION), { no: 2, name: 'version', type: 'string' }],
};

const PathzGetRequest: MessageDef = {
  name: 'gnsi.pathz.v1.GetRequest',
  fields: [enumField(1, 'policy_instance', POLICY_INSTANCE)],
};

const PathzGetResponse: MessageDef = {
  name: 'gnsi.pathz.v1.GetResponse',
  fields: [
    { no: 1, name: 'version', type: 'string' },
    { no: 2, name: 'created_on', type: 'uint64' },
    message(3, 'policy', () => PathzPolicy),
  ],
};

// certz

const CERTIFICATE_TYPE = { CERTIFICATE_TYPE_UNSPECIFIED: 0, CERTIFICATE_TYPE_X509: 1 };
const CERTIFICATE_ENCODING = {
  CERTIFICATE_ENCODING_UNSPECIFIED: 0,
  CERTIFICATE_ENCODING_PEM: 1,
  CERTIFICATE_ENCODING_DER: 2,
  CERTIFICATE_ENCODING_CRT: 3,
};

const Certificate: MessageDef = {
  name: 'gnsi.certz.v1.Certificate',
  fields: [
    enumField(1, 'type', CERTIFICATE_TYPE),
    enumField(2, 'encoding', CERTIFICATE_ENCODING),
    { no: 5, name: 'raw_certificate', type: 'bytes' },
    { no: 7, name: 'raw_private_key', type: 'bytes' },
  ],
};

const CertificateChain: MessageDef = {
  name: 'gnsi.certz.v1.CertificateChain',
  fields: [message(1, 'certificate', () => Certificate), message(2, 'parent', () => CertificateChain)],
};

const CertzEntity: MessageDef = {
  name: 'gnsi.certz.v1.Entity',
  fields: [
    { no: 1, name: 'version', type: 'string' },
    { no: 2, name: 'created_on', type: 'uint64' },
    message(3, 'certificate_chain', () => CertificateChain),
    message(4, 'trust_bundle', () => CertificateChain),
  ],
};

const CertzUploadRequest: MessageDef = {
  name: 'gnsi.certz.v1.UploadRequest',
  fields: [message(1, 'entities', () => CertzEntity, true)],
};

const CertzRotateRequest: MessageDef = {
  name: 'gnsi.certz.v1.RotateCertificateRequest',
  fields: [
    { no: 1, name: 'force_overwrite', type: 'bool' },
    { no: 2, name: 'ssl_profile_id', type: 'string' },
    message(4, 'certificates', () => CertzUploadRequest),
    message(5, 'finalize_rotation', () => Empty),
  ],
};

const CertzRotateResponse: MessageDef = {
  name: 'gnsi.certz.v1.RotateCertificateResponse',
  fields: [message(2, 'certificates', () => Empty)],
};

const CertzProfileRequest: MessageDef = {
  name: 'gnsi.certz.v1.AddProfileRequest',
  fields: [{ no: 1, name: 'ssl_profile_id', type: 'string' }],
};

const CertzProfileListResponse: MessageDef = {
  name: 'gnsi.certz.v1.GetProfileListResponse',
  fields: [{ no: 1, name: 'ssl_profile_ids', type: 'string', repeated: true }],
};

// credentialz

const KEY_TYPE = {
  KEY_TYPE_UNSPECIFIED: 0,
  KEY_TYPE_ECDSA_P_256: 1,
  KEY_TYPE_ECDSA_P_521: 2,
  KEY_TYPE_ED25519: 3,
  KEY_TYPE_RSA_2048: 4,
  KEY_TYPE_RSA_4096: 5,
  KEY_TYPE_RSA_3072: 6,
  KEY_TYPE_ECDSA_P_384: 7,
};

const PublicKey: MessageDef = {
  name: 'gnsi.credentialz.v1.PublicKey',
  fields: [
    { no: 1, name: 'public_key', type: 'bytes' },
    enumField(2, 'key_type', KEY_TYPE),
    { no: 3, name: 'description', type: 'string' },
  ],
};

const GetPublicKeysResponse: MessageDef = {
  name: 'gnsi.credentialz.v1.GetPublicKeysResponse',
  fields: [message(1, 'public_keys', () => PublicKey, true)],
};

const AuthorizedKey: MessageDef = {
  name: 'gnsi.credentialz.v1.AccountCredentials.AuthorizedKey',
  fields: [
    { no: 1, name: 'authorized_key', type: 'bytes' },
    enumField(3, 'key_type', KEY_TYPE),
    { no: 4, name: 'description', type: 'string' },
  ],
};

const AccountCredentials: MessageDef = {
  name: 'gnsi.credentialz.v1.AccountCredentials',
  fields: [
    { no: 1, name: 'account', type: 'string' },
    message(2, 'authorized_keys', () => AuthorizedKey, true),
    { no: 3, name: 'version', type: 'string' },
    { no: 4, name: 'created_on', type: 'uint64' },
  ],
};

const AuthorizedKeysRequest: MessageDef = {
  name: 'gnsi.credentialz.v1.AuthorizedKeysRequest',
  fields: [message(1, 'credentials', () => AccountCredentials, true)],
};

const RotateAccountCredentialsRequest: MessageDef = {
  name: 'gnsi.credentialz.v1.RotateAccountCredentialsRequest',
  fields: [
    message(1, 'credential', () => AuthorizedKeysRequest),
    message(4, 'finalize', () => Empty),
    { no: 5, name: 'force_overwrite', type: 'bool' },
  ],
};

const RotateAccountCredentialsResponse: MessageDef = {
  name: 'gnsi.credentialz.v1.RotateAccountCredentialsResponse',
  fields: [message(1, 'credential', () => Empty)],
};

// acctz

const UserDetail: MessageDef = {
  name: 'gnsi.acctz.v1.UserDetail',
  fields: [
    { no: 1, name: 'identity', type: 'string' },
    { no: 2, name: 'role', type: 'string' },
    { no: 3, name: 'ssh_principal', type: 'string' },
  ],
};

const AuthnDetail: MessageDef = {
  name: 'gnsi.acctz.v1.AuthnDetail',
  fields: [
    enumField(1, 'type', {
      AUTHN_TYPE_UNSPECIFIED: 0,
      AUTHN_TYPE_NONE: 1,
      AUTHN_TYPE_PASSWORD: 2,
      AUTHN_TYPE_SSHKEY: 3,
      AUTHN_TYPE_SSHCERT: 4,
      AUTHN_TYPE_TLSCERT: 5,
      AUTHN_TYPE_PAP: 6,
      AUTHN_TYPE_CHAP: 7,
    }),
    enumField(2, 'status', { AUTHN_STATUS_UNSPECIFIED: 0, AUTHN_STATUS_SUCCESS: 1, AUTHN_STATUS_FAIL: 2, AUTHN_STATUS_ERROR: 3 }),
    { no: 3, name: 'cause', type: 'string' },
  ],
};

const SessionInfo: MessageDef = {
  name: 'gnsi.acctz.v1.SessionInfo',
  fields: [
    { no: 1, name: 'local_address', type: 'string' },
    { no: 2, name: 'local_port', type: 'uint32' },
    { no: 3, name: 'remote_address', type: 'string' },
    { no: 4, name: 'remote_port', type: 'uint32' },
    { no: 5, name: 'ip_proto', type: 'uint32' },
    { no: 6, name: 'channel_id', type: 'string' },
    { no: 7, name: 'tty', type: 'string' },
    enumField(8, 'status', {
      SESSION_STATUS_UNSPECIFIED: 0,
      SESSION_STATUS_LOGIN: 1,
      SESSION_STATUS_LOGOUT: 2,
      SESSION_STATUS_ONCE: 3,
      SESSION_STATUS_ENABLE: 4,
      SESSION_STATUS_IDLE: 5,
      SESSION_STATUS_OPERATION: 6,
    }),
    message(9, 'user', () => UserDetail),
    message(10, 'authn', () => AuthnDetail),
  ],
};

const AuthzDetail: MessageDef = {
  name: 'gnsi.acctz.v1.AuthzDetail',
  fields: [
    enumField(1, 'status', { AUTHZ_STATUS_UNSPECIFIED: 0, AUTHZ_STATUS_PERMIT: 1, AUTHZ_STATUS_DENY: 2, AUTHZ_STATUS_ERROR: 3 }),
    { no: 2, name: 'detail', type: 'string' },
  ],
};

const CommandService: MessageDef = {
  name: 'gnsi.acctz.v1.CommandService',
  fields: [
    enumField(1, 'service_type', {
      CMD_SERVICE_TYPE_UNSPECIFIED: 0,
      CMD_SERVICE_TYPE_SHELL: 1,
      CMD_SERVICE_TYPE_CLI: 2,
      CMD_SERVICE_TYPE_WEBUI: 3,
      CMD_SERVICE_TYPE_RESTCONF: 4,
      CMD_SERVICE_TYPE_NETCONF: 5,
    }),
    { no: 2, name: 'cmd', type: 'string' },
    { no: 3, name: 'cmd_args', type: 'string', repeated: true },
    { no: 4, name: 'cmd_istruncated', type: 'bool' },
    message(6, 'authz', () => AuthzDetail),
  ],
};

const GrpcService: MessageDef = {
  name: 'gnsi.acctz.v1.GrpcService',
  fields: [
    enumField(1, 'service_type', {
      GRPC_SERVICE_TYPE_UNSPECIFIED: 0,
      GRPC_SERVICE_TYPE_GNMI: 1,
      GRPC_SERVICE_TYPE_GNOI: 2,
      GRPC_SERVICE_TYPE_GNSI: 3,
      GRPC_SERVICE_TYPE_GRIBI: 4,
      GRPC_SERVICE_TYPE_P4RT: 5,
    }),
    { no: 2, name: 'rpc_name', type: 'string' },
    { no: 5, name: 'payload_istruncated', type: 'bool' },
    message(6, 'authz', () => AuthzDetail),
    message(7, 'proto_val', () => Any),
    { no: 8, name: 'string_val', type: 'string' },
  ],
};

const RecordRequest: MessageDef = {
  name: 'gnsi.acctz.v1.RecordRequest',
  fields: [message(2, 'timestamp', () => Timestamp)],
};

const RecordResponse: MessageDef = {
  name: 'gnsi.acctz.v1.RecordResponse',
  fields: [
    message(1, 'session_info', () => SessionInfo),
    message(2, 'timestamp', () => Timestamp),
    { no: 3, name: 'history_istruncated', type: 'bool' },
    message(4, 'cmd_service', () => CommandService),
    message(5, 'grpc_service', () => GrpcService),
    { no: 8, name: 'component_name', type: 'string' },
    { no: 32, name: 'task_ids', type: 'string', repeated: true },
  ],
};

// grpc.reflection.v1alpha

export const ReflectionRequest: MessageDef = {
  name: 'grpc.reflection.v1alpha.ServerReflectionRequest',
  fields: [
    { no: 1, name: 'host', type: 'string' },
    { no: 7, name: 'list_services', type: 'string' },
  ],
};

const ServiceResponse: MessageDef = {
  name: 'grpc.reflection.v1alpha.ServiceResponse',
  fields: [{ no: 1, name: 'name', type: 'string' }],
};

const ListServiceResponse: MessageDef = {
  name: 'grpc.reflection.v1alpha.ListServiceResponse',
  fields: [message(1, 'service', () => ServiceResponse, true)],
};

const ReflectionError: MessageDef = {
  name: 'grpc.reflection.v1alpha.ErrorResponse',
  fields: [
    { no: 1, name: 'error_code', type: 'int32' },
    { no: 2, name: 'error_message', type: 'string' },
  ],
};

export const ReflectionResponse: MessageDef = {
  name: 'grpc.reflection.v1alpha.ServerReflectionResponse',
  fields: [
    { no: 1, name: 'valid_host', type: 'string' },
    message(6, 'list_services_response', () => ListServiceResponse),
    message(7, 'error_response', () => ReflectionError),
  ],
};

export const GNSI_MESSAGES = {
  AuthzRotateRequest,
  AuthzRotateResponse,
  AuthzProbeRequest,
  AuthzProbeResponse,
  AuthzGetRequest,
  AuthzGetResponse,
  PathzRotateRequest,
  PathzRotateResponse,
  PathzProbeRequest,
  PathzProbeResponse,
  PathzGetRequest,
  PathzGetResponse,
  CertzRotateRequest,
  CertzRotateResponse,
  CertzProfileRequest,
  CertzProfileListResponse,
  GetPublicKeysResponse,
  RotateAccountCredentialsRequest,
  RotateAccountCredentialsResponse,
  RecordRequest,
  RecordResponse,
};
