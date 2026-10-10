import type { MessageDef } from '../gnmi/protobuf.js';
import { Empty, GNOI_MESSAGES as O } from './gnoi.js';
import { GNSI_MESSAGES as S } from './gnsi.js';

/**
 * Every gNOI and gNSI RPC the renderer may call, keyed by its gRPC method
 * path. Nothing outside this list reaches a device: the backend refuses
 * unknown methods instead of forwarding arbitrary calls.
 */

export type MethodKind = 'unary' | 'server-stream' | 'client-stream' | 'bidi';

export interface MethodDef {
  path: string;
  kind: MethodKind;
  request: MessageDef;
  response: MessageDef;
}

const method = (path: string, kind: MethodKind, request: MessageDef, response: MessageDef): MethodDef => ({
  path,
  kind,
  request,
  response,
});

const ALL: MethodDef[] = [
  // gnoi.system
  method('/gnoi.system.System/Ping', 'server-stream', O.PingRequest, O.PingResponse),
  method('/gnoi.system.System/Traceroute', 'server-stream', O.TracerouteRequest, O.TracerouteResponse),
  method('/gnoi.system.System/Time', 'unary', Empty, O.TimeResponse),
  method('/gnoi.system.System/Reboot', 'unary', O.RebootRequest, Empty),
  method('/gnoi.system.System/RebootStatus', 'unary', O.RebootStatusRequest, O.RebootStatusResponse),
  method('/gnoi.system.System/CancelReboot', 'unary', O.CancelRebootRequest, Empty),
  method('/gnoi.system.System/KillProcess', 'unary', O.KillProcessRequest, Empty),
  // gnoi.file (Get and Put have their own transfer ops with hash checks)
  method('/gnoi.file.File/Stat', 'unary', O.StatRequest, O.StatResponse),
  method('/gnoi.file.File/Remove', 'unary', O.RemoveRequest, Empty),
  // gnoi.healthz
  method('/gnoi.healthz.Healthz/Get', 'unary', O.HealthzGetRequest, O.HealthzGetResponse),
  method('/gnoi.healthz.Healthz/List', 'unary', O.HealthzListRequest, O.HealthzListResponse),
  method('/gnoi.healthz.Healthz/Acknowledge', 'unary', O.HealthzAcknowledgeRequest, O.HealthzAcknowledgeResponse),
  method('/gnoi.healthz.Healthz/Check', 'unary', O.HealthzCheckRequest, O.HealthzCheckResponse),
  // gnoi.bgp, gnoi.os
  method('/gnoi.bgp.BGP/ClearBGPNeighbor', 'unary', O.ClearBGPNeighborRequest, Empty),
  method('/gnoi.os.OS/Verify', 'unary', Empty, O.VerifyResponse),
  // gnsi.authz
  method('/gnsi.authz.v1.Authz/Get', 'unary', S.AuthzGetRequest, S.AuthzGetResponse),
  method('/gnsi.authz.v1.Authz/Probe', 'unary', S.AuthzProbeRequest, S.AuthzProbeResponse),
  method('/gnsi.authz.v1.Authz/Rotate', 'bidi', S.AuthzRotateRequest, S.AuthzRotateResponse),
  // gnsi.pathz
  method('/gnsi.pathz.v1.Pathz/Get', 'unary', S.PathzGetRequest, S.PathzGetResponse),
  method('/gnsi.pathz.v1.Pathz/Probe', 'unary', S.PathzProbeRequest, S.PathzProbeResponse),
  method('/gnsi.pathz.v1.Pathz/Rotate', 'bidi', S.PathzRotateRequest, S.PathzRotateResponse),
  // gnsi.certz
  method('/gnsi.certz.v1.Certz/GetProfileList', 'unary', Empty, S.CertzProfileListResponse),
  method('/gnsi.certz.v1.Certz/AddProfile', 'unary', S.CertzProfileRequest, Empty),
  method('/gnsi.certz.v1.Certz/DeleteProfile', 'unary', S.CertzProfileRequest, Empty),
  method('/gnsi.certz.v1.Certz/Rotate', 'bidi', S.CertzRotateRequest, S.CertzRotateResponse),
  // gnsi.credentialz
  method('/gnsi.credentialz.v1.Credentialz/GetPublicKeys', 'unary', Empty, S.GetPublicKeysResponse),
  method(
    '/gnsi.credentialz.v1.Credentialz/RotateAccountCredentials',
    'bidi',
    S.RotateAccountCredentialsRequest,
    S.RotateAccountCredentialsResponse,
  ),
  // gnsi.acctz
  method('/gnsi.acctz.v1.AcctzStream/RecordSubscribe', 'server-stream', S.RecordRequest, S.RecordResponse),
  method('/gnsi.acctz.v1.Acctz/RecordSubscribe', 'bidi', S.RecordRequest, S.RecordResponse),
];

export const METHODS: ReadonlyMap<string, MethodDef> = new Map(ALL.map((definition) => [definition.path, definition]));

export function methodDef(path: string): MethodDef | undefined {
  return METHODS.get(path);
}
