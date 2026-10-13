import TerminalOutlinedIcon from '@mui/icons-material/TerminalOutlined';
import {
  MAX_SECURECRT_IMPORT_BYTES,
  parseSecureCrtSessions,
  secureCrtConnections,
} from '../securecrt-import.js';
import { SessionImportDialog } from './SessionImportDialog.js';

export function SecureCrtImportDialog({ onClose }: { onClose: () => void }) {
  return (
    <SessionImportDialog
      onClose={onClose}
      vendorName="SecureCRT"
      icon={<TerminalOutlinedIcon color="primary" />}
      idleSubtitle="Bring exported SSH, Telnet and serial sessions, folders and button bars into Muxus."
      sourceIntro="In SecureCRT, use Tools → Export Settings, include Sessions and Button Bars, then choose the resulting XML file here."
      fileDescription="Choose an XML settings export created by SecureCRT."
      fileAccept=".xml,text/xml,application/xml"
      maxBytes={MAX_SECURECRT_IMPORT_BYTES}
      parse={parseSecureCrtSessions}
      connections={secureCrtConnections}
      reviewNotice="Passwords, private keys, logon actions, embedded files and global settings are not copied. Muxus will ask for SSH credentials when needed. Each button bar becomes a command button group, and hosts keep the bar SecureCRT showed for them."
      privacyNotice="Muxus reads SSH, Telnet and serial connection metadata and Send String buttons only. Local-shell sessions, session templates and unsupported or incomplete entries are skipped."
    />
  );
}
