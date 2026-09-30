import type { ComponentProps } from 'react';
import { FolderContextMenu } from './FolderContextMenu.js';
import { HostContextMenu } from './HostContextMenu.js';
import { HostSessionsMenu } from './HostSessionsMenu.js';
import { LaunchGroupDialog } from './LaunchGroupDialog.js';
import { LocalShellContextMenu } from './LocalShellContextMenu.js';
import { PanelContextMenu } from './PanelContextMenu.js';

/**
 * The sidebar's on-demand surfaces in one lazy chunk.
 *
 * None of them can appear until the user right-clicks a row, clicks a host that
 * has open sessions or asks to launch a folder, and together they pull in MUI's
 * Menu, Dialog and a dozen icons — so they stay out of the initial bundle and
 * load on the first hover that could open them.
 */
export function SidebarMenus({
  host,
  sessions,
  folder,
  panel,
  shell,
  launch,
}: {
  host: ComponentProps<typeof HostContextMenu>;
  sessions: ComponentProps<typeof HostSessionsMenu>;
  folder: ComponentProps<typeof FolderContextMenu>;
  panel: ComponentProps<typeof PanelContextMenu>;
  shell: ComponentProps<typeof LocalShellContextMenu>;
  launch: ComponentProps<typeof LaunchGroupDialog>;
}) {
  return (
    <>
      <HostContextMenu {...host} />
      <HostSessionsMenu {...sessions} />
      <FolderContextMenu {...folder} />
      <PanelContextMenu {...panel} />
      <LocalShellContextMenu {...shell} />
      <LaunchGroupDialog {...launch} />
    </>
  );
}
