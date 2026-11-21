import { describe, expect, it } from 'vitest';
import { isLoopbackOnlyPort, listeningPortTarget, type ForwardInfo, type ListeningPort } from '@muxus/shared';
import type { HostEnvironment } from '@muxus/shared';
import {
  forwardForPort,
  portCountLabel,
  portMatches,
  portPublishers,
  portReach,
  publishedContainerPorts,
  withPublishedPorts,
} from '../../../client/src/listening-ports.js';

const port = (number: number, addresses: string[], process?: string): ListeningPort => ({
  port: number,
  addresses,
  ...(process ? { process } : {}),
});

describe('where a forward connects to', () => {
  it('uses loopback for a port bound to every address', () => {
    expect(listeningPortTarget(port(80, ['*']))).toBe('127.0.0.1');
    expect(listeningPortTarget(port(22, ['0.0.0.0', '::']))).toBe('127.0.0.1');
  });

  it('uses the loopback address the port is bound to', () => {
    expect(listeningPortTarget(port(5432, ['127.0.0.1']))).toBe('127.0.0.1');
    expect(listeningPortTarget(port(53, ['127.0.0.53']))).toBe('127.0.0.53');
    expect(listeningPortTarget(port(6379, ['::1']))).toBe('::1');
  });

  it('uses IPv6 loopback for a port that only listens on IPv6', () => {
    expect(listeningPortTarget(port(8080, ['::']))).toBe('::1');
  });

  it('uses the one address a port is bound to when that is not loopback', () => {
    expect(listeningPortTarget(port(9100, ['10.0.0.4']))).toBe('10.0.0.4');
  });

  it('tells ports only the host itself can reach', () => {
    expect(isLoopbackOnlyPort(port(5432, ['127.0.0.1', '::1']))).toBe(true);
    expect(isLoopbackOnlyPort(port(22, ['0.0.0.0']))).toBe(false);
    expect(isLoopbackOnlyPort(port(53, ['127.0.0.53', '10.0.0.4']))).toBe(false);
  });
});

describe('the ports list', () => {
  it('words who can reach a port', () => {
    expect(portReach(port(5432, ['127.0.0.1']))).toBe('this host only');
    expect(portReach(port(22, ['0.0.0.0', '::']))).toBe('all addresses');
    expect(portReach(port(80, ['*']))).toBe('all addresses');
    expect(portReach(port(9100, ['10.0.0.4', '10.0.1.4']))).toBe('10.0.0.4, 10.0.1.4');
  });

  it('filters by number, program and address', () => {
    const nginx = port(8080, ['10.0.0.4'], 'nginx');
    expect(portMatches(nginx, '')).toBe(true);
    expect(portMatches(nginx, '80')).toBe(true);
    expect(portMatches(nginx, 'ngi')).toBe(true);
    expect(portMatches(nginx, '10.0')).toBe(true);
    expect(portMatches(nginx, 'postgres')).toBe(false);
  });

  it('counts what a filter leaves', () => {
    expect(portCountLabel(1, 1)).toBe('1 port');
    expect(portCountLabel(14, 14)).toBe('14 ports');
    expect(portCountLabel(2, 14)).toBe('2 of 14 ports');
  });
});

describe('finding the forward that already carries a port', () => {
  const forward = (overrides: Partial<ForwardInfo>): ForwardInfo => ({
    id: 'f1',
    connId: 'c1',
    type: 'local',
    bindPort: 8080,
    targetHost: '127.0.0.1',
    targetPort: 8080,
    origin: 'manual',
    lifecycle: 'session',
    status: 'active',
    ...overrides,
  });
  const nginx = port(8080, ['0.0.0.0'], 'nginx');

  it('matches a running local forward to the same place on the same connection', () => {
    expect(forwardForPort([forward({})], 'c1', nginx)?.id).toBe('f1');
  });

  it('ignores forwards of other connections, kinds, targets and states', () => {
    expect(forwardForPort([forward({ connId: 'c2' })], 'c1', nginx)).toBeUndefined();
    expect(forwardForPort([forward({ type: 'remote' })], 'c1', nginx)).toBeUndefined();
    expect(forwardForPort([forward({ targetPort: 9090 })], 'c1', nginx)).toBeUndefined();
    expect(forwardForPort([forward({ targetHost: '10.0.0.4' })], 'c1', nginx)).toBeUndefined();
    expect(forwardForPort([forward({ status: 'reconnecting' })], 'c1', nginx)).toBeUndefined();
    expect(forwardForPort([forward({})], undefined, nginx)).toBeUndefined();
  });
});

describe('ports that containers publish', () => {
  /** A lab host: its Grafana and Prometheus are lab nodes, the registry a plain container. */
  const environments: HostEnvironment[] = [
    {
      kind: 'containers',
      runtime: 'docker',
      containers: [
        {
          id: 'be691ece964b',
          name: 'grafana',
          image: 'grafana/grafana:13.0.1',
          state: 'running',
          status: 'Up 12 days',
          ports: [{ hostIp: '0.0.0.0', hostPort: 3000, containerPort: 3000, protocol: 'tcp' }],
          containerlab: { lab: 'st', node: 'grafana', kind: 'linux' },
        },
        {
          id: 'e1f43460da1a',
          name: 'client2',
          image: 'ghcr.io/srl-labs/network-multitool',
          state: 'running',
          status: 'Up 12 days',
          // Exposed by the image, published nowhere.
          ports: [
            { containerPort: 22, protocol: 'tcp' },
            { containerPort: 80, protocol: 'tcp' },
          ],
          containerlab: { lab: 'st', node: 'client2', kind: 'linux' },
        },
        {
          id: '0123456789ab',
          name: 'registry',
          image: 'registry:2',
          state: 'running',
          status: 'Up 2 hours',
          ports: [
            { hostIp: '127.0.0.1', hostPort: 5000, containerPort: 5000, protocol: 'tcp' },
            { hostIp: '0.0.0.0', hostPort: 5353, containerPort: 53, protocol: 'udp' },
          ],
        },
      ],
    },
    { kind: 'containerlab', labs: [] },
  ];

  it('finds the published TCP ports of one container, lab node or not', () => {
    expect(publishedContainerPorts(environments, 'docker', 'grafana')).toEqual([
      { hostIp: '0.0.0.0', hostPort: 3000, containerPort: 3000, protocol: 'tcp' },
    ]);
    expect(publishedContainerPorts(environments, 'docker', 'client2')).toEqual([]);
    expect(publishedContainerPorts(environments, 'docker', 'registry')).toHaveLength(1);
    expect(publishedContainerPorts(environments, 'podman', 'grafana')).toEqual([]);
    expect(publishedContainerPorts(environments, 'docker', 'missing')).toEqual([]);
  });

  it('names the container behind a host port, with its lab', () => {
    const publishers = portPublishers(environments);
    expect([...publishers.keys()]).toEqual([3000, 5000]);
    expect(publishers.get(3000)).toEqual({
      container: 'grafana',
      runtime: 'docker',
      containerPort: 3000,
      hostIp: '0.0.0.0',
      lab: 'st',
    });
    expect(publishers.get(5000)).toMatchObject({ container: 'registry', hostIp: '127.0.0.1' });
    expect(publishers.get(5000)?.lab).toBeUndefined();
  });

  it('lets the filter find a port by its container, which the host only knows as docker-proxy', () => {
    const proxied = port(3000, ['0.0.0.0', '::'], 'docker-proxy');
    expect(portMatches(proxied, 'graf')).toBe(false);
    expect(portMatches(proxied, 'graf', 'grafana')).toBe(true);
    expect(portMatches(proxied, 'docker', 'grafana')).toBe(true);
  });

  it('adds published ports nothing listens on, as on an engine without its userland proxy', () => {
    const publishers = portPublishers(environments);
    const listening = [port(22, ['0.0.0.0'], 'sshd'), port(3000, ['0.0.0.0'], 'docker-proxy'), port(9100, ['*'], 'node_exporter')];
    expect(withPublishedPorts(listening, publishers)).toEqual([
      port(22, ['0.0.0.0'], 'sshd'),
      port(3000, ['0.0.0.0'], 'docker-proxy'),
      // Published on loopback only, so the forward goes to loopback.
      port(5000, ['127.0.0.1']),
      port(9100, ['*'], 'node_exporter'),
    ]);
    expect(withPublishedPorts(listening, new Map())).toEqual(listening);
  });
});

