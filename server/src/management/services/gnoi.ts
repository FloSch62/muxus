import type { FieldDef, MessageDef } from '../gnmi/protobuf.js';

/**
 * gNOI messages Muxus uses, transcribed from openconfig/gnoi: system, file,
 * healthz, bgp and os (Verify). Field numbers and enum values follow the
 * .proto files exactly; fields Muxus never sends or shows are left out and
 * skipped on decode.
 */

export const message = (no: number, name: string, def: () => MessageDef, repeated = false): FieldDef => ({
  no,
  name,
  type: 'message',
  message: def,
  ...(repeated ? { repeated } : {}),
});

export const enumField = (no: number, name: string, values: Record<string, number>, repeated = false): FieldDef => ({
  no,
  name,
  type: 'enum',
  enumValues: values,
  ...(repeated ? { repeated } : {}),
});

export const Empty: MessageDef = { name: 'Empty', fields: [] };

export const Timestamp: MessageDef = {
  name: 'google.protobuf.Timestamp',
  fields: [
    { no: 1, name: 'seconds', type: 'int64' },
    { no: 2, name: 'nanos', type: 'int32' },
  ],
};

export const Any: MessageDef = {
  name: 'google.protobuf.Any',
  fields: [
    { no: 1, name: 'type_url', type: 'string' },
    { no: 2, name: 'value', type: 'bytes' },
  ],
};

// gnoi.types

export const L3_PROTOCOL = { UNSPECIFIED: 0, IPV4: 1, IPV6: 2 };
export const HASH_METHOD = { UNSPECIFIED: 0, SHA256: 1, SHA512: 2, MD5: 3 };

export const HashType: MessageDef = {
  name: 'gnoi.types.HashType',
  fields: [enumField(1, 'method', HASH_METHOD), { no: 2, name: 'hash', type: 'bytes' }],
};

export const PathElem: MessageDef = {
  name: 'gnoi.types.PathElem',
  fields: [
    { no: 1, name: 'name', type: 'string' },
    { no: 2, name: 'key', type: 'map' },
  ],
};

export const TypesPath: MessageDef = {
  name: 'gnoi.types.Path',
  fields: [
    { no: 2, name: 'origin', type: 'string' },
    message(3, 'elem', () => PathElem, true),
  ],
};

// gnoi.system

export const REBOOT_METHOD = { UNKNOWN: 0, COLD: 1, POWERDOWN: 2, HALT: 3, WARM: 4, NSF: 5, POWERUP: 7 };

const PingRequest: MessageDef = {
  name: 'gnoi.system.PingRequest',
  fields: [
    { no: 1, name: 'destination', type: 'string' },
    { no: 2, name: 'source', type: 'string' },
    { no: 3, name: 'count', type: 'int32' },
    { no: 4, name: 'interval', type: 'int64' },
    { no: 5, name: 'wait', type: 'int64' },
    { no: 6, name: 'size', type: 'int32' },
    { no: 7, name: 'do_not_fragment', type: 'bool' },
    { no: 8, name: 'do_not_resolve', type: 'bool' },
    enumField(9, 'l3protocol', L3_PROTOCOL),
    { no: 10, name: 'network_instance', type: 'string' },
  ],
};

const PingResponse: MessageDef = {
  name: 'gnoi.system.PingResponse',
  fields: [
    { no: 1, name: 'source', type: 'string' },
    { no: 2, name: 'time', type: 'int64' },
    { no: 3, name: 'sent', type: 'int32' },
    { no: 4, name: 'received', type: 'int32' },
    { no: 5, name: 'min_time', type: 'int64' },
    { no: 6, name: 'avg_time', type: 'int64' },
    { no: 7, name: 'max_time', type: 'int64' },
    { no: 8, name: 'std_dev', type: 'int64' },
    { no: 11, name: 'bytes', type: 'int32' },
    { no: 12, name: 'sequence', type: 'int32' },
    { no: 13, name: 'ttl', type: 'int32' },
  ],
};

const TracerouteRequest: MessageDef = {
  name: 'gnoi.system.TracerouteRequest',
  fields: [
    { no: 1, name: 'source', type: 'string' },
    { no: 2, name: 'destination', type: 'string' },
    { no: 3, name: 'initial_ttl', type: 'uint32' },
    { no: 4, name: 'max_ttl', type: 'int32' },
    { no: 5, name: 'wait', type: 'int64' },
    { no: 6, name: 'do_not_fragment', type: 'bool' },
    { no: 7, name: 'do_not_resolve', type: 'bool' },
    enumField(8, 'l3protocol', L3_PROTOCOL),
    enumField(9, 'l4protocol', { ICMP: 0, TCP: 1, UDP: 2 }),
    { no: 10, name: 'do_not_lookup_asn', type: 'bool' },
    { no: 11, name: 'network_instance', type: 'string' },
  ],
};

const TracerouteResponse: MessageDef = {
  name: 'gnoi.system.TracerouteResponse',
  fields: [
    { no: 1, name: 'destination_name', type: 'string' },
    { no: 2, name: 'destination_address', type: 'string' },
    { no: 3, name: 'hops', type: 'int32' },
    { no: 4, name: 'packet_size', type: 'int32' },
    { no: 5, name: 'hop', type: 'int32' },
    { no: 6, name: 'address', type: 'string' },
    { no: 7, name: 'name', type: 'string' },
    { no: 8, name: 'rtt', type: 'int64' },
    enumField(9, 'state', {
      DEFAULT: 0,
      NONE: 1,
      UNKNOWN: 2,
      ICMP: 3,
      HOST_UNREACHABLE: 4,
      NETWORK_UNREACHABLE: 5,
      PROTOCOL_UNREACHABLE: 6,
      SOURCE_ROUTE_FAILED: 7,
      FRAGMENTATION_NEEDED: 8,
      PROHIBITED: 9,
      PRECEDENCE_VIOLATION: 10,
      PRECEDENCE_CUTOFF: 11,
    }),
    { no: 10, name: 'icmp_code', type: 'int32' },
    { no: 11, name: 'mpls', type: 'map' },
    { no: 12, name: 'as_path', type: 'int32', repeated: true },
  ],
};

const TimeResponse: MessageDef = {
  name: 'gnoi.system.TimeResponse',
  fields: [{ no: 1, name: 'time', type: 'uint64' }],
};

const RebootRequest: MessageDef = {
  name: 'gnoi.system.RebootRequest',
  fields: [
    enumField(1, 'method', REBOOT_METHOD),
    { no: 2, name: 'delay', type: 'uint64' },
    { no: 3, name: 'message', type: 'string' },
    message(4, 'subcomponents', () => TypesPath, true),
    { no: 5, name: 'force', type: 'bool' },
  ],
};

const RebootStatusRequest: MessageDef = {
  name: 'gnoi.system.RebootStatusRequest',
  fields: [message(1, 'subcomponents', () => TypesPath, true)],
};

const RebootStatusMessage: MessageDef = {
  name: 'gnoi.system.RebootStatus',
  fields: [
    enumField(1, 'status', { STATUS_UNKNOWN: 0, STATUS_SUCCESS: 1, STATUS_RETRIABLE_FAILURE: 2, STATUS_FAILURE: 3 }),
    { no: 2, name: 'message', type: 'string' },
  ],
};

const RebootStatusResponse: MessageDef = {
  name: 'gnoi.system.RebootStatusResponse',
  fields: [
    { no: 1, name: 'active', type: 'bool' },
    { no: 2, name: 'wait', type: 'uint64' },
    { no: 3, name: 'when', type: 'uint64' },
    { no: 4, name: 'reason', type: 'string' },
    { no: 5, name: 'count', type: 'uint32' },
    enumField(6, 'method', REBOOT_METHOD),
    message(7, 'status', () => RebootStatusMessage),
  ],
};

const CancelRebootRequest: MessageDef = {
  name: 'gnoi.system.CancelRebootRequest',
  fields: [{ no: 1, name: 'message', type: 'string' }, message(2, 'subcomponents', () => TypesPath, true)],
};

const KillProcessRequest: MessageDef = {
  name: 'gnoi.system.KillProcessRequest',
  fields: [
    { no: 1, name: 'pid', type: 'uint32' },
    { no: 2, name: 'name', type: 'string' },
    enumField(3, 'signal', { SIGNAL_UNSPECIFIED: 0, SIGNAL_TERM: 1, SIGNAL_KILL: 2, SIGNAL_HUP: 3, SIGNAL_ABRT: 4 }),
    { no: 4, name: 'restart', type: 'bool' },
  ],
};

// gnoi.file

export const FilePutDetails: MessageDef = {
  name: 'gnoi.file.PutRequest.Details',
  fields: [
    { no: 1, name: 'remote_file', type: 'string' },
    { no: 2, name: 'permissions', type: 'uint32' },
  ],
};

export const FilePutRequest: MessageDef = {
  name: 'gnoi.file.PutRequest',
  fields: [
    message(1, 'open', () => FilePutDetails),
    { no: 2, name: 'contents', type: 'bytes' },
    message(3, 'hash', () => HashType),
  ],
};

export const FileGetRequest: MessageDef = {
  name: 'gnoi.file.GetRequest',
  fields: [{ no: 1, name: 'remote_file', type: 'string' }],
};

export const FileGetResponse: MessageDef = {
  name: 'gnoi.file.GetResponse',
  fields: [{ no: 1, name: 'contents', type: 'bytes' }, message(2, 'hash', () => HashType)],
};

const StatInfo: MessageDef = {
  name: 'gnoi.file.StatInfo',
  fields: [
    { no: 1, name: 'path', type: 'string' },
    { no: 2, name: 'last_modified', type: 'uint64' },
    { no: 3, name: 'permissions', type: 'uint32' },
    { no: 4, name: 'size', type: 'uint64' },
    { no: 5, name: 'umask', type: 'uint32' },
  ],
};

const StatRequest: MessageDef = { name: 'gnoi.file.StatRequest', fields: [{ no: 1, name: 'path', type: 'string' }] };
const StatResponse: MessageDef = { name: 'gnoi.file.StatResponse', fields: [message(1, 'stats', () => StatInfo, true)] };
const RemoveRequest: MessageDef = {
  name: 'gnoi.file.RemoveRequest',
  fields: [{ no: 1, name: 'remote_file', type: 'string' }],
};

// gnoi.healthz

const HEALTH_STATUS = { STATUS_UNSPECIFIED: 0, STATUS_HEALTHY: 1, STATUS_UNHEALTHY: 2 };

const FileArtifactType: MessageDef = {
  name: 'gnoi.healthz.FileArtifactType',
  fields: [
    { no: 1, name: 'name', type: 'string' },
    { no: 2, name: 'path', type: 'string' },
    { no: 3, name: 'mimetype', type: 'string' },
    { no: 4, name: 'size', type: 'int64' },
    message(5, 'hash', () => HashType),
  ],
};

const ArtifactHeader: MessageDef = {
  name: 'gnoi.healthz.ArtifactHeader',
  fields: [
    { no: 1, name: 'id', type: 'string' },
    message(101, 'file', () => FileArtifactType),
    message(102, 'proto', () => Empty),
    message(103, 'custom', () => Any),
  ],
};

const ComponentStatus: MessageDef = {
  name: 'gnoi.healthz.ComponentStatus',
  fields: [
    message(1, 'path', () => TypesPath),
    message(2, 'subcomponents', () => ComponentStatus, true),
    enumField(3, 'status', HEALTH_STATUS),
    message(5, 'artifacts', () => ArtifactHeader, true),
    { no: 6, name: 'id', type: 'string' },
    { no: 7, name: 'acknowledged', type: 'bool' },
    message(8, 'created', () => Timestamp),
    message(9, 'expires', () => Timestamp),
  ],
};

const HealthzGetRequest: MessageDef = { name: 'gnoi.healthz.GetRequest', fields: [message(1, 'path', () => TypesPath)] };
const HealthzGetResponse: MessageDef = {
  name: 'gnoi.healthz.GetResponse',
  fields: [message(1, 'component', () => ComponentStatus)],
};
const HealthzListRequest: MessageDef = {
  name: 'gnoi.healthz.ListRequest',
  fields: [message(1, 'path', () => TypesPath), { no: 2, name: 'include_acknowledged', type: 'bool' }],
};
const HealthzListResponse: MessageDef = {
  name: 'gnoi.healthz.ListResponse',
  fields: [message(1, 'statuses', () => ComponentStatus, true)],
};
const HealthzAcknowledgeRequest: MessageDef = {
  name: 'gnoi.healthz.AcknowledgeRequest',
  fields: [message(1, 'path', () => TypesPath), { no: 2, name: 'id', type: 'string' }],
};
const HealthzAcknowledgeResponse: MessageDef = {
  name: 'gnoi.healthz.AcknowledgeResponse',
  fields: [message(1, 'status', () => ComponentStatus)],
};
const HealthzCheckRequest: MessageDef = {
  name: 'gnoi.healthz.CheckRequest',
  fields: [message(1, 'path', () => TypesPath), { no: 2, name: 'event_id', type: 'string' }],
};
const HealthzCheckResponse: MessageDef = {
  name: 'gnoi.healthz.CheckResponse',
  fields: [message(1, 'status', () => ComponentStatus)],
};

// gnoi.bgp

const ClearBGPNeighborRequest: MessageDef = {
  name: 'gnoi.bgp.ClearBGPNeighborRequest',
  fields: [
    { no: 1, name: 'address', type: 'string' },
    { no: 2, name: 'routing_instance', type: 'string' },
    enumField(3, 'mode', { SOFT: 0, SOFTIN: 1, HARD: 2, HARD_RESET: 3, GRACEFUL_RESET: 4 }),
  ],
};

// gnoi.os

const VerifyResponse: MessageDef = {
  name: 'gnoi.os.VerifyResponse',
  fields: [
    { no: 1, name: 'version', type: 'string' },
    { no: 2, name: 'activation_fail_message', type: 'string' },
    { no: 4, name: 'individual_supervisor_install', type: 'bool' },
  ],
};

export const GNOI_MESSAGES = {
  PingRequest,
  PingResponse,
  TracerouteRequest,
  TracerouteResponse,
  TimeResponse,
  RebootRequest,
  RebootStatusRequest,
  RebootStatusResponse,
  CancelRebootRequest,
  KillProcessRequest,
  StatRequest,
  StatResponse,
  RemoveRequest,
  HealthzGetRequest,
  HealthzGetResponse,
  HealthzListRequest,
  HealthzListResponse,
  HealthzAcknowledgeRequest,
  HealthzAcknowledgeResponse,
  HealthzCheckRequest,
  HealthzCheckResponse,
  ClearBGPNeighborRequest,
  VerifyResponse,
};
