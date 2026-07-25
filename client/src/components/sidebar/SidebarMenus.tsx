import type { ComponentProps } from 'react';
import { FolderContextMenu } from './FolderContextMenu.js';
import { HostContextMenu } from './HostContextMenu.js';
import { LaunchGroupDialog } from './LaunchGroupDialog.js';
import { PanelContextMenu } from './PanelContextMenu.js';

/**
 * The sidebar's on-demand surfaces in one lazy chunk.
 *
 * None of them can appear until the user right-clicks a row or asks to launch a
 * folder, and together they pull in MUI's Menu, Dialog and a dozen icons — so
 * they stay out of the initial bundle and load on the first hover that could
 * open them.
 */
export function SidebarMenus({
  host,
  folder,
  panel,
  launch,
}: {
  host: ComponentProps<typeof HostContextMenu>;
  folder: ComponentProps<typeof FolderContextMenu>;
  panel: ComponentProps<typeof PanelContextMenu>;
  launch: ComponentProps<typeof LaunchGroupDialog>;
}) {
  return (
    <>
      <HostContextMenu {...host} />
      <FolderContextMenu {...folder} />
      <PanelContextMenu {...panel} />
      <LaunchGroupDialog {...launch} />
    </>
  );
}
