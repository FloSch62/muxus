import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import AddIcon from '@mui/icons-material/Add';
import TerminalIcon from '@mui/icons-material/Terminal';
import { openLocalTerminal } from '../session-actions.js';
import { usePrefsStore } from '../state/prefs.js';
import { useTabsStore } from '../state/tabs.js';
import { useUiStore } from '../state/ui.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { ForwardsDialog } from '../components/ForwardsDialog.js';
import { SessionSidebar } from '../components/SessionSidebar.js';
import { SftpPanel } from '../components/SftpPanel.js';
import { TabStrip } from '../components/TabStrip.js';
import { TerminalView } from '../components/TerminalView.js';
import { TopBar } from './TopBar.js';

/**
 * TopBar over sidebar + workspace. Every open tab stays mounted (hidden via
 * display:none) so terminals keep their buffers and connections alive.
 */
export function AppShell() {
  const sidebarCollapsed = usePrefsStore((s) => s.sidebarCollapsed);
  const tabs = useTabsStore((s) => s.tabs);
  const activeId = useTabsStore((s) => s.activeId);
  const activeTab = tabs.find((t) => t.id === activeId);
  const forwardsOpen = useUiStore((s) => s.forwardsOpen);
  const setForwardsOpen = useUiStore((s) => s.setForwardsOpen);
  const setHostEditor = useUiStore((s) => s.setHostEditor);

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <TopBar />
      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {!sidebarCollapsed && <SessionSidebar />}
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <TabStrip />
          <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
            <Box sx={{ flex: 1, minWidth: 0, position: 'relative' }}>
              {tabs.map((tab) => (
                <Box key={tab.id} sx={{ height: '100%', display: tab.id === activeId ? 'block' : 'none' }}>
                  <ErrorBoundary label="This terminal">
                    <TerminalView tab={tab} active={tab.id === activeId} />
                  </ErrorBoundary>
                </Box>
              ))}
              {tabs.length === 0 && (
                <Stack sx={{ height: '100%', alignItems: 'center', justifyContent: 'center' }} spacing={2}>
                  <TerminalIcon sx={{ fontSize: 44, color: 'text.disabled' }} />
                  <Typography variant="body1" color="text.secondary">
                    Connect to a session from the sidebar, or open a local terminal.
                  </Typography>
                  <Stack direction="row" spacing={1.5}>
                    <Button variant="contained" startIcon={<TerminalIcon />} onClick={() => openLocalTerminal()}>
                      Local terminal
                    </Button>
                    <Button variant="outlined" startIcon={<AddIcon />} onClick={() => setHostEditor({ mode: 'new' })}>
                      Add SSH host
                    </Button>
                  </Stack>
                </Stack>
              )}
            </Box>
            {activeTab?.sftpOpen && activeTab.connId && (
              <ErrorBoundary label="The file browser">
                <SftpPanel key={activeTab.connId} connId={activeTab.connId} />
              </ErrorBoundary>
            )}
          </Box>
        </Box>
      </Box>
      {activeTab?.connId && (
        <ForwardsDialog
          connId={activeTab.connId}
          target={activeTab.profile.kind === 'ssh' ? activeTab.profile.target : undefined}
          open={forwardsOpen}
          onClose={() => setForwardsOpen(false)}
        />
      )}
    </Box>
  );
}
