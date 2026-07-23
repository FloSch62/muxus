import type { FastifyInstance } from 'fastify';
import type { SshConfigResponse } from '@muxus/shared';
import type { AppContext } from '../app.js';
import { defaultSshConfigPath, parseSshConfigHosts } from '../ssh/ssh-config.js';

export function registerSshRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get('/api/ssh/config-hosts', (): SshConfigResponse => {
    const configPath = defaultSshConfigPath();
    const { hosts, error } = parseSshConfigHosts(configPath);
    return { configPath, hosts: hosts.sort((a, b) => a.alias.localeCompare(b.alias)), error };
  });
}
