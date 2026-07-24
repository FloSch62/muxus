/** Statically analyzable feature loaders shared by React.lazy and intent preloads. */
export const loadHostEditorDialog = () => import('./components/HostEditorDialog.js');
export const loadHostOrganizationDialog = () => import('./components/HostOrganizationDialog.js');
export const loadSettingsDialog = () => import('./components/SettingsDialog.js');
export const loadCommandButtonsDialog = () => import('./components/CommandButtonsDialog.js');
export const loadShortcutsDialog = () => import('./components/ShortcutsDialog.js');
export const loadForwardingPanel = () => import('./components/ForwardingPanel.js');
export const loadSftpPanel = () => import('./components/SftpPanel.js');
export const loadRemoteEditorWorkspace = () => import('./components/RemoteEditorWorkspace.js');
export const loadTerminalViewImpl = () => import('./components/TerminalViewImpl.js');
export const loadMonacoTextEditor = () => import('./components/MonacoTextEditor.js');
