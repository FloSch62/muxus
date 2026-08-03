import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  WorkspaceRecord,
  WorkspaceSummary,
} from '@muxus/shared';
import { sessionProfileSchema } from '@muxus/shared/ws-protocol';
import type { AppContext } from '../app.js';
import { WorkspaceLockedError } from '../persistence/database.js';
import { HttpProblem, sendError } from '../util/errors.js';

const connectionRefSchema = z.object({
  source: z.enum(['openssh', 'profile']),
  id: z.string().min(1),
});

const workspaceTabSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('terminal'),
    title: z.string().max(500),
    profile: sessionProfileSchema,
    cwdHint: z.string().optional(),
    color: z.string().max(32).optional(),
    pinned: z.boolean().optional(),
    offerReconnect: z.boolean(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('sftp'),
    title: z.string().max(500),
    connection: connectionRefSchema,
    path: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('editor'),
    title: z.string().max(500),
    connection: connectionRefSchema,
    path: z.string().optional(),
  }),
]);

type WorkspaceNodeInput =
  | {
      id: string;
      type: 'pane';
      tabs: z.infer<typeof workspaceTabSchema>[];
      activeTabId?: string;
    }
  | {
      id: string;
      type: 'split';
      direction: 'horizontal' | 'vertical';
      ratio: number;
      children: [WorkspaceNodeInput, WorkspaceNodeInput];
    };

const workspaceNodeSchema: z.ZodType<WorkspaceNodeInput> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      id: z.string().min(1),
      type: z.literal('pane'),
      tabs: z.array(workspaceTabSchema),
      activeTabId: z.string().optional(),
    }),
    z.object({
      id: z.string().min(1),
      type: z.literal('split'),
      direction: z.enum(['horizontal', 'vertical']),
      ratio: z.number().min(0.1).max(0.9),
      children: z.tuple([workspaceNodeSchema, workspaceNodeSchema]),
    }),
  ]),
);

const workspaceLayoutSchema = z.object({
  version: z.literal(1),
  root: workspaceNodeSchema.nullable(),
  activePaneId: z.string().optional(),
}).superRefine((layout, ctx) => {
  if (!layout.root) return;
  const nodeIds = new Set<string>();
  const paneIds = new Set<string>();
  const tabIds = new Set<string>();
  const walk = (node: WorkspaceNodeInput): void => {
    if (nodeIds.has(node.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate workspace node id "${node.id}"` });
    }
    nodeIds.add(node.id);
    if (node.type === 'split') {
      walk(node.children[0]);
      walk(node.children[1]);
      return;
    }
    paneIds.add(node.id);
    const localTabs = new Set<string>();
    for (const tab of node.tabs) {
      if (tabIds.has(tab.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate workspace tab id "${tab.id}"` });
      }
      tabIds.add(tab.id);
      localTabs.add(tab.id);
    }
    if (node.activeTabId && !localTabs.has(node.activeTabId)) {
      ctx.addIssue({
        code: 'custom',
        message: `active tab "${node.activeTabId}" is not in pane "${node.id}"`,
      });
    }
  };
  walk(layout.root);
  if (layout.activePaneId && !paneIds.has(layout.activePaneId)) {
    ctx.addIssue({
      code: 'custom',
      message: `active pane "${layout.activePaneId}" does not exist`,
    });
  }
});

const workspaceSaveSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  layout: workspaceLayoutSchema,
  overwriteLocked: z.boolean().optional().default(false),
  multiExecGroups: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().trim().min(1).max(200),
      tabIds: z.array(z.string().min(1)).min(2),
    }).superRefine((group, ctx) => {
      if (new Set(group.tabIds).size !== group.tabIds.length) {
        ctx.addIssue({ code: 'custom', message: `multi-exec group "${group.name}" contains duplicate tabs` });
      }
    }),
  ).default([]),
}).superRefine((workspace, ctx) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  const terminalTabIds = new Set<string>();
  const collectTerminalTabs = (node: WorkspaceNodeInput): void => {
    if (node.type === 'split') {
      collectTerminalTabs(node.children[0]);
      collectTerminalTabs(node.children[1]);
      return;
    }
    for (const tab of node.tabs) {
      if (tab.kind === 'terminal') terminalTabIds.add(tab.id);
    }
  };
  if (workspace.layout.root) collectTerminalTabs(workspace.layout.root);
  for (const group of workspace.multiExecGroups) {
    if (ids.has(group.id)) {
      ctx.addIssue({ code: 'custom', message: `duplicate multi-exec group id "${group.id}"` });
    }
    ids.add(group.id);
    const name = group.name.trim().toLocaleLowerCase();
    if (names.has(name)) {
      ctx.addIssue({ code: 'custom', message: `duplicate multi-exec group name "${group.name}"` });
    }
    names.add(name);
    for (const tabId of group.tabIds) {
      if (!terminalTabIds.has(tabId)) {
        ctx.addIssue({
          code: 'custom',
          message: `multi-exec group "${group.name}" references unknown terminal tab "${tabId}"`,
        });
      }
    }
  }
});

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/workspaces', (): { workspaces: WorkspaceSummary[] } => ({
    workspaces: ctx.database.listWorkspaceSummaries(),
  }));

  app.get('/api/workspaces/latest', (): { workspace: WorkspaceRecord | null } => ({
    workspace: (ctx.database.latestWorkspace() as WorkspaceRecord | undefined) ?? null,
  }));

  app.get('/api/workspaces/startup', (): { workspace: WorkspaceRecord | null } => ({
    workspace: (ctx.database.startupWorkspace() as WorkspaceRecord | undefined) ?? null,
  }));

  app.put('/api/workspaces/startup', async (req, reply): Promise<{ workspace: WorkspaceRecord | null } | void> => {
    const parsed = z.object({ id: z.string().min(1).nullable() }).safeParse(req.body);
    if (!parsed.success) return sendError(reply, new HttpProblem(400, 'invalid startup workspace'));
    const workspace = ctx.database.setStartupWorkspace(parsed.data.id);
    if (parsed.data.id !== null && !workspace) {
      await reply.code(404).send({ message: 'workspace not found' });
      return;
    }
    return { workspace: (workspace as WorkspaceRecord | undefined) ?? null };
  });

  app.get('/api/workspaces/:id', async (req, reply): Promise<WorkspaceRecord | void> => {
    const { id } = req.params as { id: string };
    const workspace = ctx.database.workspace(id);
    if (!workspace) {
      await reply.code(404).send({ message: 'workspace not found' });
      return;
    }
    return workspace as WorkspaceRecord;
  });

  app.put('/api/workspaces', async (req, reply): Promise<WorkspaceRecord | void> => {
    try {
      const parsed = workspaceSaveSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid workspace');
      }
      const { overwriteLocked, ...workspace } = parsed.data;
      const saved = ctx.database.saveWorkspace(workspace, overwriteLocked) as WorkspaceRecord;
      ctx.database.pruneTerminalSnapshots();
      return saved;
    } catch (err) {
      if (err instanceof WorkspaceLockedError) {
        return sendError(reply, new HttpProblem(409, err.message, 'workspace-locked'));
      }
      return sendError(reply, err);
    }
  });

  app.patch('/api/workspaces/:id', async (req, reply): Promise<WorkspaceRecord | void> => {
    try {
      const { id } = req.params as { id: string };
      const parsed = z.union([
        z.object({ name: z.string().trim().min(1).max(200) }).strict(),
        z.object({ isLocked: z.boolean() }).strict(),
      ]).safeParse(req.body);
      if (!parsed.success) {
        throw new HttpProblem(400, parsed.error.issues[0]?.message ?? 'invalid workspace update');
      }
      const workspace = 'name' in parsed.data
        ? ctx.database.renameWorkspace(id, parsed.data.name)
        : ctx.database.setWorkspaceLocked(id, parsed.data.isLocked);
      if (!workspace) {
        await reply.code(404).send({ message: 'workspace not found' });
        return;
      }
      return workspace as WorkspaceRecord;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/api/workspaces/:id/open', async (req, reply): Promise<WorkspaceRecord | void> => {
    const { id } = req.params as { id: string };
    const workspace = ctx.database.openWorkspace(id);
    if (!workspace) {
      await reply.code(404).send({ message: 'workspace not found' });
      return;
    }
    return workspace as WorkspaceRecord;
  });

  app.delete('/api/workspaces/:id', (req) => {
    const { id } = req.params as { id: string };
    const deleted = ctx.database.deleteWorkspace(id);
    if (deleted) ctx.database.pruneTerminalSnapshots();
    return { deleted };
  });
}
