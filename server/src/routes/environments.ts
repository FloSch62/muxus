import net from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CONTAINER_NAME_PATTERN,
  CONTAINER_RUNTIMES,
  KUBE_CONTEXT_PATTERN,
  KUBE_NAME_PATTERN,
  LIBVIRT_DOMAIN_PATTERN,
  LIBVIRT_URIS,
  PROXMOX_MAX_VMID,
  PROXMOX_MIN_VMID,
  type EnvironmentPortResponse,
  type EnvironmentsResponse,
} from '@muxus/shared';
import type { AppContext } from '../app.js';
import {
  containerlabTopology,
  discoverEnvironments,
  kubernetesNamespaces,
  kubernetesPods,
  libvirtAddresses,
  libvirtDisplay,
  proxmoxAddresses,
  runEnvironmentAction,
} from '../environments/discovery.js';
import {
  localProbeRunner,
  remoteProbeRunner,
  scriptProbeRunner,
  type ProbeRunner,
} from '../environments/probe-runner.js';
import { HttpProblem, sendError } from '../util/errors.js';

const contextSchema = z.string().regex(KUBE_CONTEXT_PATTERN).optional();
const vmidSchema = z.coerce.number().int().min(PROXMOX_MIN_VMID).max(PROXMOX_MAX_VMID);
const uriSchema = z.enum(LIBVIRT_URIS).optional();
const domainSchema = z.string().regex(LIBVIRT_DOMAIN_PATTERN);

const discoveryQuery = z.object({ auto: z.literal('1').optional() });
const namespacesQuery = z.object({ context: contextSchema });
const podsQuery = z.object({
  context: contextSchema,
  /** Absent lists every namespace. */
  namespace: z.string().regex(KUBE_NAME_PATTERN).optional(),
});
const topologyQuery = z.object({
  runtime: z.enum(CONTAINER_RUNTIMES),
  lab: z.string().min(1).max(128),
});
const libvirtQuery = z.object({ uri: uriSchema, domain: domainSchema });
const proxmoxQuery = z.object({ type: z.enum(['qemu', 'lxc']), vmid: vmidSchema });

const actionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('container'),
    runtime: z.enum(CONTAINER_RUNTIMES),
    container: z.string().regex(CONTAINER_NAME_PATTERN),
    action: z.enum(['start', 'stop', 'restart', 'pause', 'unpause', 'remove']),
  }),
  z.object({
    kind: z.literal('compose'),
    runtime: z.enum(CONTAINER_RUNTIMES),
    project: z.string().min(1).max(128),
    action: z.enum(['start', 'stop', 'restart']),
  }),
  z.object({
    kind: z.literal('proxmox'),
    type: z.enum(['qemu', 'lxc']),
    vmid: z.number().int().min(PROXMOX_MIN_VMID).max(PROXMOX_MAX_VMID),
    action: z.enum(['start', 'shutdown', 'reboot', 'stop']),
  }),
  z.object({
    kind: z.literal('libvirt'),
    uri: uriSchema,
    domain: domainSchema,
    action: z.enum(['start', 'shutdown', 'reboot', 'destroy']),
  }),
]);

const portSchema = z.object({
  /** As seen from the SSH host: 127.0.0.1 for a published port, or a guest's address. */
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.:_-]+$/),
  port: z.number().int().min(1).max(65535),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid request');
  return parsed.data;
}

/** A free loopback port for a new listener. */
function freeLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

/**
 * Containers, clusters, labs and VMs on the computer running Muxus
 * (`/api/environments/local`) or on the far end of a live SSH connection
 * (`/api/environments/ssh/:connId`). Each request runs the host's own tools
 * over one exec channel of that connection; nothing is installed.
 *
 * Automatic discovery (`?auto=1`) skips a connection whose server never ran
 * a command, the way the status bar does: some network devices drop the
 * whole connection when a second channel asks to exec.
 */
export function registerEnvironmentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const inFlight = new Map<string, Promise<EnvironmentsResponse>>();

  const withRunner = async <T>(
    req: FastifyRequest,
    work: (run: ProbeRunner) => Promise<T>,
    options: { auto?: boolean } = {},
  ): Promise<T | EnvironmentsResponse> => {
    const { connId } = (req.params ?? {}) as { connId?: string };
    if (!connId) return work(localProbeRunner());
    const system = ctx.systemOpenSsh.acquire(connId);
    if (system) {
      try {
        if (options.auto && !(await system.connection.runsCommands())) {
          return { status: 'unsupported', message: 'The host does not run commands.' };
        }
        return await work(scriptProbeRunner(system.connection.runScript));
      } finally {
        system.release();
      }
    }
    const lease = ctx.connections.acquire(connId, 'environments');
    if (!lease) throw new HttpProblem(404, 'connection not found');
    try {
      if (options.auto && !lease.connection.ranCommand()) {
        return { status: 'unsupported', message: 'The host does not run commands.' };
      }
      return await work(remoteProbeRunner(lease.connection.client));
    } finally {
      lease.release();
    }
  };

  const handle =
    <T>(work: (req: FastifyRequest) => Promise<T>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await work(req);
      } catch (err) {
        return sendError(reply, err);
      }
    };

  for (const prefix of ['/api/environments/local', '/api/environments/ssh/:connId']) {
    app.get(
      prefix,
      handle(async (req) => {
        const { auto } = parse(discoveryQuery, req.query);
        const { connId } = (req.params ?? {}) as { connId?: string };
        const key = `${connId ?? 'local'}:${auto ?? ''}`;
        let pending = inFlight.get(key);
        if (!pending) {
          pending = withRunner(
            req,
            async (run): Promise<EnvironmentsResponse> => ({
              status: 'ok',
              sampledAt: Date.now(),
              ...(await discoverEnvironments(run)),
            }),
            { auto: auto === '1' },
          ).finally(() => inFlight.delete(key));
          inFlight.set(key, pending);
        }
        return pending;
      }),
    );

    app.get(
      `${prefix}/kubernetes/namespaces`,
      handle(async (req) => {
        const { context } = parse(namespacesQuery, req.query);
        return withRunner(req, async (run) => ({ namespaces: await kubernetesNamespaces(run, context) }));
      }),
    );

    app.get(
      `${prefix}/kubernetes/pods`,
      handle(async (req) => {
        const { context, namespace } = parse(podsQuery, req.query);
        return withRunner(req, async (run) => ({ pods: await kubernetesPods(run, context, namespace) }));
      }),
    );

    app.get(
      `${prefix}/containerlab/topology`,
      handle(async (req) => {
        const { runtime, lab } = parse(topologyQuery, req.query);
        return withRunner(req, (run) => containerlabTopology(run, runtime, lab));
      }),
    );

    app.get(
      `${prefix}/libvirt/addresses`,
      handle(async (req) => {
        const { uri, domain } = parse(libvirtQuery, req.query);
        return withRunner(req, async (run) => ({ addresses: await libvirtAddresses(run, uri, domain) }));
      }),
    );

    app.get(
      `${prefix}/libvirt/display`,
      handle(async (req) => {
        const { uri, domain } = parse(libvirtQuery, req.query);
        return withRunner(req, async (run) => {
          const vnc = await libvirtDisplay(run, uri, domain);
          return vnc ? { vnc } : {};
        });
      }),
    );

    app.get(
      `${prefix}/proxmox/addresses`,
      handle(async (req) => {
        const { type, vmid } = parse(proxmoxQuery, req.query);
        return withRunner(req, async (run) => ({ addresses: await proxmoxAddresses(run, type, vmid) }));
      }),
    );

    app.post(
      `${prefix}/actions`,
      handle(async (req) => {
        const action = parse(actionSchema, req.body);
        return withRunner(req, (run) => runEnvironmentAction(run, action));
      }),
    );
  }

  /**
   * Open a port on the far side of an SSH host on this computer: a published
   * container port, a hypervisor's web interface, a guest's service. An
   * existing forward to the same place is reused.
   */
  app.post(
    '/api/environments/ssh/:connId/ports',
    handle(async (req): Promise<EnvironmentPortResponse> => {
      const { connId } = req.params as { connId: string };
      const { host, port } = parse(portSchema, req.body);
      const system = ctx.systemOpenSsh.acquire(connId);
      if (system) {
        system.release();
        throw new HttpProblem(400, 'Opening ports is not available with system OpenSSH.');
      }
      const existing = ctx.forwards
        .list(connId)
        .find(
          (forward) =>
            forward.type === 'local' &&
            forward.status === 'active' &&
            forward.targetHost === host &&
            forward.targetPort === port,
        );
      if (existing) return { forwardId: existing.id, localPort: existing.bindPort };
      const bindPort = await freeLocalPort();
      const info = await ctx.forwards.start({ connId, type: 'local', bindPort, targetHost: host, targetPort: port });
      return { forwardId: info.id, localPort: info.bindPort };
    }),
  );
}
