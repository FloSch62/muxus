import { useMemo } from 'react';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Tooltip from '@mui/material/Tooltip';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FilterAltOutlinedIcon from '@mui/icons-material/FilterAltOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import PlayArrowRoundedIcon from '@mui/icons-material/PlayArrowRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import { formatGnmiPath, stripModulePrefix } from '@muxus/shared';
import { copyToClipboard } from '../../clipboard.js';
import { showErrorToast, showToast } from '../../state/toast.js';
import { namespaceChain, nodeToJson, type DataNode } from '../../management/data-tree.js';
import { defaultNetconfDraft, newItemId, type GnmiDraft, type NetconfDraft } from '../../management/requests.js';
import { gnmicCommand } from '../../management/copy-as.js';
import { editConfigFor, parseRpcReply, prettyXml, subtreeFilterFor, xpathFor } from '../../management/xml.js';
import type { GnmiProfile } from '@muxus/shared';
import { useWorkbench, type WorkbenchContextValue } from './context.js';
import { valueText } from './PathText.js';

function isLeaf(node: DataNode): boolean {
  return node.kind === 'leaf' || node.kind === 'leaf-list';
}

function copy(text: string, what: string): void {
  void copyToClipboard(text).then((ok) => showToast(ok ? 'success' : 'error', ok ? `Copied ${what}.` : 'Could not copy.'));
}

function innerXml(element: Element): string {
  const serializer = new XMLSerializer();
  return Array.from(element.children)
    .map((child) => prettyXml(serializer.serializeToString(child)))
    .join('\n');
}

/** What can be done with a node of device data, for either protocol. */
export function nodeActions(context: WorkbenchContextValue, root: DataNode) {
  const { store, controller, profile } = context;
  const gnmiDraft = () => store.getState().draft as GnmiDraft;
  const netconfDraft = () => store.getState().draft as NetconfDraft;
  const chain = (node: DataNode) => namespaceChain(root, node);
  const writableTarget = () => (controller.hasCapability(':candidate') ? 'candidate' : 'running');

  return {
    /** Load the node into a Get and run it. */
    get: (node: DataNode) => {
      if (profile.kind === 'gnmi') {
        const draft = { ...gnmiDraft(), operation: 'get' as const, paths: [formatGnmiPath(node.path)] };
        store.getState().replaceDraft(draft);
        controller.run(draft);
        return;
      }
      const draft: NetconfDraft = {
        ...netconfDraft(),
        operation: 'get',
        filterType: 'subtree',
        filter: prettyXml(subtreeFilterFor(chain(node))),
      };
      store.getState().replaceDraft(draft);
      controller.run(draft);
    },
    getConfig: (node: DataNode) => {
      const draft: NetconfDraft = {
        ...netconfDraft(),
        operation: 'get-config',
        source: 'running',
        filterType: 'subtree',
        filter: prettyXml(subtreeFilterFor(chain(node))),
      };
      store.getState().replaceDraft(draft);
      controller.run(draft);
    },
    /** Stream the node (gNMI). */
    watch: (node: DataNode) => {
      const current = gnmiDraft();
      const draft: GnmiDraft = {
        ...current,
        operation: 'subscribe',
        paths: [formatGnmiPath(node.path)],
        subscribe: {
          ...current.subscribe,
          listMode: 'stream',
          // Counters want samples; a single state leaf reads best on change.
          mode: isLeaf(node) && typeof node.value === 'string' && !/^\d+$/.test(node.value) ? 'on-change' : 'sample',
          sampleSeconds: Math.max(1, current.subscribe.sampleSeconds > 10 ? 1 : current.subscribe.sampleSeconds),
        },
      };
      store.getState().replaceDraft(draft);
      controller.run(draft);
    },
    /** Prepare a Set of the node's current value for editing (gNMI). */
    setValue: (node: DataNode) => {
      const value = isLeaf(node) ? node.value : nodeToJson(node);
      store.getState().replaceDraft({
        ...gnmiDraft(),
        operation: 'set',
        set: [
          {
            id: newItemId(),
            op: 'update',
            path: formatGnmiPath(node.path),
            value: JSON.stringify(value, null, 2),
            encoding: 'json_ietf',
          },
        ],
      });
    },
    /** Prepare a delete of the node, reviewed before it is sent. */
    remove: (node: DataNode) => {
      if (profile.kind === 'gnmi') {
        store.getState().replaceDraft({
          ...gnmiDraft(),
          operation: 'set',
          set: [{ id: newItemId(), op: 'delete', path: formatGnmiPath(node.path), value: '', encoding: 'json_ietf' }],
        });
        return;
      }
      store.getState().replaceDraft({
        ...defaultNetconfDraft(),
        operation: 'edit-config',
        target: writableTarget(),
        config: editConfigFor(chain(node), 'delete'),
      });
    },
    /** Fetch the node's configuration and open it in an edit-config (NETCONF). */
    editConfig: async (node: DataNode) => {
      const filter = subtreeFilterFor(chain(node));
      try {
        const result = await controller.request({
          ...defaultNetconfDraft(),
          operation: 'get-config',
          source: writableTarget() === 'candidate' ? 'candidate' : 'running',
          filterType: 'subtree',
          filter,
        });
        if (result.op !== 'netconf-rpc') return;
        const reply = parseRpcReply(result.xml);
        if (reply?.errors.length) throw new Error(reply.errors[0]?.message ?? 'get-config failed');
        const config = reply?.data ? innerXml(reply.data) : '';
        store.getState().replaceDraft({
          ...defaultNetconfDraft(),
          operation: 'edit-config',
          target: writableTarget(),
          config: config || editConfigFor(chain(node), 'edit'),
        });
      } catch (err) {
        showErrorToast(err);
      }
    },
    useAsFilter: (node: DataNode) => {
      const current = netconfDraft();
      store.getState().replaceDraft({
        ...current,
        operation: current.operation === 'get' || current.operation === 'get-config' ? current.operation : 'get',
        filterType: 'subtree',
        filter: prettyXml(subtreeFilterFor(chain(node))),
      });
    },
    copyPath: (node: DataNode) => {
      copy(profile.kind === 'gnmi' ? formatGnmiPath(node.path) : xpathFor(chain(node)), profile.kind === 'gnmi' ? 'the path' : 'the XPath');
    },
    copyFilter: (node: DataNode) => {
      copy(prettyXml(subtreeFilterFor(chain(node))), 'the subtree filter');
    },
    copyValue: (node: DataNode) => {
      copy(isLeaf(node) ? valueText(node.value) : JSON.stringify(nodeToJson(node), null, 2), 'the value');
    },
    copyGnmic: (node: DataNode) => {
      if (profile.kind !== 'gnmi') return;
      copy(
        gnmicCommand(profile as GnmiProfile, { ...gnmiDraft(), operation: 'get', paths: [formatGnmiPath(node.path)] }),
        'the gnmic command',
      );
    },
  };
}

export function useNodeActions(root: DataNode) {
  const context = useWorkbench();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => nodeActions(context, root), [context.controller, context.store, context.profile, root]);
}

/** Inline buttons on a hovered row. */
export function NodeRowActions({ node, root }: { node: DataNode; root: DataNode }) {
  const { connected, profile } = useWorkbench();
  const actions = useNodeActions(root);
  if (!connected || node.kind === 'root') return null;
  const button = { p: 0.25 } as const;
  return (
    <>
      <Tooltip title={profile.kind === 'gnmi' ? 'Get' : 'Get with state'}>
        <IconButton size="small" aria-label="Get" sx={button} onClick={() => actions.get(node)}>
          <PlayArrowRoundedIcon sx={{ fontSize: 16 }} />
        </IconButton>
      </Tooltip>
      {profile.kind === 'gnmi' && (
        <Tooltip title="Watch (subscribe)">
          <IconButton size="small" aria-label="Watch" sx={button} onClick={() => actions.watch(node)}>
            <MonitorHeartOutlinedIcon sx={{ fontSize: 15 }} />
          </IconButton>
        </Tooltip>
      )}
    </>
  );
}

/** Right-click menu for a node of device data. */
export function NodeMenu({
  target,
  root,
  onClose,
}: {
  target: { node: DataNode; x: number; y: number } | null;
  root: DataNode;
  onClose: () => void;
}) {
  const { connected, profile } = useWorkbench();
  const actions = useNodeActions(root);
  const node = target?.node;
  const act = (action: (node: DataNode) => void | Promise<void>) => () => {
    onClose();
    if (node) void action(node);
  };
  const gnmi = profile.kind === 'gnmi';
  const leaf = node ? isLeaf(node) : false;
  const label = node ? stripModulePrefix(node.name) || '/' : '';
  return (
    <Menu
      open={!!target}
      onClose={onClose}
      anchorReference="anchorPosition"
      anchorPosition={target ? { top: target.y, left: target.x } : undefined}
      slotProps={{ list: { dense: true, sx: { minWidth: 240 } } }}
    >
      <MenuItem disabled sx={{ opacity: '1 !important', fontFamily: '"JetBrains Mono", monospace', fontSize: 12 }}>
        {label}
      </MenuItem>
      <MenuItem onClick={act(actions.get)} disabled={!connected}>
        <ListItemIcon>
          <PlayArrowRoundedIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary={gnmi ? 'Get' : 'Get with state'} />
      </MenuItem>
      {!gnmi && (
        <MenuItem onClick={act(actions.getConfig)} disabled={!connected}>
          <ListItemIcon>
            <SettingsOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Get configuration" />
        </MenuItem>
      )}
      {gnmi && (
        <MenuItem onClick={act(actions.watch)} disabled={!connected}>
          <ListItemIcon>
            <MonitorHeartOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Watch" secondary="Subscribe and stream updates" />
        </MenuItem>
      )}
      <Divider />
      {gnmi ? (
        <MenuItem onClick={act(actions.setValue)}>
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={leaf ? 'Set value…' : 'Edit as Set…'} />
        </MenuItem>
      ) : (
        <MenuItem onClick={act(actions.editConfig)} disabled={!connected}>
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Edit configuration…" />
        </MenuItem>
      )}
      {!gnmi && (
        <MenuItem onClick={act(actions.useAsFilter)}>
          <ListItemIcon>
            <FilterAltOutlinedIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Use as filter" />
        </MenuItem>
      )}
      <MenuItem onClick={act(actions.remove)}>
        <ListItemIcon>
          <DeleteOutlineIcon fontSize="small" color="error" />
        </ListItemIcon>
        <ListItemText primary="Delete…" />
      </MenuItem>
      <Divider />
      <MenuItem onClick={act(actions.copyPath)}>
        <ListItemIcon>
          <ContentCopyIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary={gnmi ? 'Copy path' : 'Copy XPath'} />
      </MenuItem>
      {!gnmi && (
        <MenuItem onClick={act(actions.copyFilter)}>
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Copy subtree filter" />
        </MenuItem>
      )}
      <MenuItem onClick={act(actions.copyValue)}>
        <ListItemIcon>
          <ContentCopyIcon fontSize="small" />
        </ListItemIcon>
        <ListItemText primary={leaf ? 'Copy value' : 'Copy as JSON'} />
      </MenuItem>
      {gnmi && (
        <MenuItem onClick={act(actions.copyGnmic)}>
          <ListItemIcon>
            <ContentCopyIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Copy gnmic get" />
        </MenuItem>
      )}
    </Menu>
  );
}

