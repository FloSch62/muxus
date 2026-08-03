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
      idleSubtitle="Bring exported SSH and serial sessions and folders into Muxus."
      sourceIntro="In SecureCRT, use Tools → Export Settings, include Sessions, then choose the resulting XML file here."
      fileDescription="Choose an XML settings export created by SecureCRT."
      fileAccept=".xml,text/xml,application/xml"
      maxBytes={MAX_SECURECRT_IMPORT_BYTES}
      parse={parseSecureCrtSessions}
      connections={secureCrtConnections}
      reviewNotice="Passwords, private keys, embedded files and global settings are not copied. Muxus will ask for SSH credentials when needed."
      privacyNotice="Muxus reads SSH and serial connection metadata only. Local-shell sessions and unsupported or incomplete entries are skipped."
    />
  );
}
