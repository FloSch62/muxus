import type { FieldDef, MessageDef } from './protobuf.js';

/**
 * The gNMI messages Muxus sends and reads, transcribed from openconfig's
 * proto/gnmi/gnmi.proto (gNMI 0.10) and proto/gnmi_ext/gnmi_ext.proto.
 * Deprecated fields a device may still send (Update.value, TypedValue
 * float/decimal, the old Error messages) are kept so they decode.
 */

const message = (no: number, name: string, def: () => MessageDef, repeated = false): FieldDef => ({
  no,
  name,
  type: 'message',
  message: def,
  ...(repeated ? { repeated } : {}),
});

export const PathElem: MessageDef = {
  name: 'PathElem',
  fields: [
    { no: 1, name: 'name', type: 'string' },
    { no: 2, name: 'key', type: 'map' },
  ],
};

export const Path: MessageDef = {
  name: 'Path',
  fields: [
    { no: 1, name: 'element', type: 'string', repeated: true },
    { no: 2, name: 'origin', type: 'string' },
    message(3, 'elem', () => PathElem, true),
    { no: 4, name: 'target', type: 'string' },
  ],
};

export const Any: MessageDef = {
  name: 'google.protobuf.Any',
  fields: [
    { no: 1, name: 'type_url', type: 'string' },
    { no: 2, name: 'value', type: 'bytes' },
  ],
};

export const Duration: MessageDef = {
  name: 'google.protobuf.Duration',
  fields: [
    { no: 1, name: 'seconds', type: 'int64' },
    { no: 2, name: 'nanos', type: 'int32' },
  ],
};

export const Decimal64: MessageDef = {
  name: 'Decimal64',
  fields: [
    { no: 1, name: 'digits', type: 'int64' },
    { no: 2, name: 'precision', type: 'uint32' },
  ],
};

export const ScalarArray: MessageDef = {
  name: 'ScalarArray',
  fields: [message(1, 'element', () => TypedValue, true)],
};

export const TypedValue: MessageDef = {
  name: 'TypedValue',
  fields: [
    { no: 1, name: 'string_val', type: 'string' },
    { no: 2, name: 'int_val', type: 'int64' },
    { no: 3, name: 'uint_val', type: 'uint64' },
    { no: 4, name: 'bool_val', type: 'bool' },
    { no: 5, name: 'bytes_val', type: 'bytes' },
    { no: 6, name: 'float_val', type: 'float' },
    message(7, 'decimal_val', () => Decimal64),
    message(8, 'leaflist_val', () => ScalarArray),
    message(9, 'any_val', () => Any),
    { no: 10, name: 'json_val', type: 'bytes' },
    { no: 11, name: 'json_ietf_val', type: 'bytes' },
    { no: 12, name: 'ascii_val', type: 'string' },
    { no: 13, name: 'proto_bytes', type: 'bytes' },
    { no: 14, name: 'double_val', type: 'double' },
  ],
};

/** Deprecated pre-TypedValue value, still sent by some older targets. */
export const Value: MessageDef = {
  name: 'Value',
  fields: [
    { no: 1, name: 'value', type: 'bytes' },
    { no: 2, name: 'type', type: 'enum' },
  ],
};

export const Update: MessageDef = {
  name: 'Update',
  fields: [
    message(1, 'path', () => Path),
    message(2, 'value', () => Value),
    message(3, 'val', () => TypedValue),
    { no: 4, name: 'duplicates', type: 'uint32' },
  ],
};

export const Notification: MessageDef = {
  name: 'Notification',
  fields: [
    { no: 1, name: 'timestamp', type: 'int64' },
    message(2, 'prefix', () => Path),
    message(4, 'update', () => Update, true),
    message(5, 'delete', () => Path, true),
    { no: 6, name: 'atomic', type: 'bool' },
  ],
};

export const GnmiError: MessageDef = {
  name: 'Error',
  fields: [
    { no: 1, name: 'code', type: 'uint32' },
    { no: 2, name: 'message', type: 'string' },
    message(3, 'data', () => Any),
  ],
};

export const ModelData: MessageDef = {
  name: 'ModelData',
  fields: [
    { no: 1, name: 'name', type: 'string' },
    { no: 2, name: 'organization', type: 'string' },
    { no: 3, name: 'version', type: 'string' },
  ],
};

// gnmi_ext

export const Depth: MessageDef = {
  name: 'gnmi_ext.Depth',
  fields: [{ no: 1, name: 'level', type: 'uint32' }],
};

export const CommitRequest: MessageDef = {
  name: 'gnmi_ext.CommitRequest',
  fields: [message(1, 'rollback_duration', () => Duration)],
};

const Empty: MessageDef = { name: 'Empty', fields: [] };

export const Commit: MessageDef = {
  name: 'gnmi_ext.Commit',
  fields: [
    { no: 1, name: 'id', type: 'string' },
    message(2, 'commit', () => CommitRequest),
    message(3, 'confirm', () => Empty),
    message(4, 'cancel', () => Empty),
  ],
};

export const Extension: MessageDef = {
  name: 'gnmi_ext.Extension',
  fields: [
    message(4, 'commit', () => Commit),
    message(5, 'depth', () => Depth),
  ],
};

// RPC messages

export const CapabilityRequest: MessageDef = {
  name: 'CapabilityRequest',
  fields: [message(1, 'extension', () => Extension, true)],
};

export const CapabilityResponse: MessageDef = {
  name: 'CapabilityResponse',
  fields: [
    message(1, 'supported_models', () => ModelData, true),
    { no: 2, name: 'supported_encodings', type: 'enum', repeated: true },
    { no: 3, name: 'gNMI_version', type: 'string' },
  ],
};

export const GetRequest: MessageDef = {
  name: 'GetRequest',
  fields: [
    message(1, 'prefix', () => Path),
    message(2, 'path', () => Path, true),
    { no: 3, name: 'type', type: 'enum' },
    { no: 5, name: 'encoding', type: 'enum' },
    message(6, 'use_models', () => ModelData, true),
    message(7, 'extension', () => Extension, true),
  ],
};

export const GetResponse: MessageDef = {
  name: 'GetResponse',
  fields: [
    message(1, 'notification', () => Notification, true),
    message(2, 'error', () => GnmiError),
  ],
};

export const SetRequest: MessageDef = {
  name: 'SetRequest',
  fields: [
    message(1, 'prefix', () => Path),
    message(2, 'delete', () => Path, true),
    message(3, 'replace', () => Update, true),
    message(4, 'update', () => Update, true),
    message(5, 'extension', () => Extension, true),
    message(6, 'union_replace', () => Update, true),
  ],
};

export const UpdateResult: MessageDef = {
  name: 'UpdateResult',
  fields: [
    { no: 1, name: 'timestamp', type: 'int64' },
    message(2, 'path', () => Path),
    message(3, 'message', () => GnmiError),
    { no: 4, name: 'op', type: 'enum' },
  ],
};

export const SetResponse: MessageDef = {
  name: 'SetResponse',
  fields: [
    message(1, 'prefix', () => Path),
    message(2, 'response', () => UpdateResult, true),
    message(3, 'message', () => GnmiError),
    { no: 4, name: 'timestamp', type: 'int64' },
  ],
};

export const Subscription: MessageDef = {
  name: 'Subscription',
  fields: [
    message(1, 'path', () => Path),
    { no: 2, name: 'mode', type: 'enum' },
    { no: 3, name: 'sample_interval', type: 'uint64' },
    { no: 4, name: 'suppress_redundant', type: 'bool' },
    { no: 5, name: 'heartbeat_interval', type: 'uint64' },
  ],
};

export const SubscriptionList: MessageDef = {
  name: 'SubscriptionList',
  fields: [
    message(1, 'prefix', () => Path),
    message(2, 'subscription', () => Subscription, true),
    { no: 5, name: 'mode', type: 'enum' },
    { no: 6, name: 'allow_aggregation', type: 'bool' },
    message(7, 'use_models', () => ModelData, true),
    { no: 8, name: 'encoding', type: 'enum' },
    { no: 9, name: 'updates_only', type: 'bool' },
  ],
};

export const SubscribeRequest: MessageDef = {
  name: 'SubscribeRequest',
  fields: [
    message(1, 'subscribe', () => SubscriptionList),
    message(3, 'poll', () => Empty),
    message(5, 'extension', () => Extension, true),
  ],
};

export const SubscribeResponse: MessageDef = {
  name: 'SubscribeResponse',
  fields: [
    message(1, 'update', () => Notification),
    { no: 3, name: 'sync_response', type: 'bool' },
    message(4, 'error', () => GnmiError),
  ],
};

export const ENCODING = { json: 0, bytes: 1, proto: 2, ascii: 3, json_ietf: 4 } as const;
export const DATA_TYPE = { all: 0, config: 1, state: 2, operational: 3 } as const;
export const LIST_MODE = { stream: 0, once: 1, poll: 2 } as const;
export const SUBSCRIPTION_MODE = { 'target-defined': 0, 'on-change': 1, sample: 2 } as const;
export const UPDATE_RESULT_OP = ['invalid', 'delete', 'replace', 'update', 'union-replace'] as const;
