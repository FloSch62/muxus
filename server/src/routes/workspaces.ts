import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  WorkspaceRecord,
  WorkspaceSummary,
} from '@muxus/shared';
import { sessionProfileSchema } from '@muxus/shared/ws-protocol';
import type { AppContext } from '../app.js';
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
  name: z.string().min(1).max(200),
  layout: workspaceLayoutSchema,
});

export function registerWorkspaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/workspaces', (): { workspaces: WorkspaceSummary[] } => ({
    workspaces: ctx.database.listWorkspaces().map(({ layout: _layout, ...summary }) => summary),
  }));

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
      return ctx.database.saveWorkspace(parsed.data) as WorkspaceRecord;
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.delete('/api/workspaces/:id', (req) => {
    const { id } = req.params as { id: string };
    return { deleted: ctx.database.deleteWorkspace(id) };
  });
}
