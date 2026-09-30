import LaptopWindowsOutlinedIcon from '@mui/icons-material/LaptopWindowsOutlined';
import {
  MAX_MOBAXTERM_IMPORT_BYTES,
  mobaXtermConnections,
  parseMobaXtermSessions,
} from '../mobaxterm-import.js';
import { SessionImportDialog } from './SessionImportDialog.js';

export function MobaXtermImportDialog({ onClose }: { onClose: () => void }) {
  const desktop = window.muxusDesktop;
  const canAutoDetect =
    desktop?.platform === 'win32' && typeof desktop.readMobaXtermSessions === 'function';

  return (
    <SessionImportDialog
      onClose={onClose}
      vendorName="MobaXterm"
      icon={<LaptopWindowsOutlinedIcon color="primary" />}
      idleSubtitle="Bring your saved SSH, RDP and VNC sessions and folders into Muxus."
      sourceIntro="On Windows, Muxus can find bookmark data from the installed or portable edition. You can also choose an exported file on any platform."
      fileDescription="Choose MobaXterm.ini, .mxtsessions, .mobaconf or a text export."
      fileAccept=".ini,.mxtsessions,.mobaconf,.txt,text/plain"
      maxBytes={MAX_MOBAXTERM_IMPORT_BYTES}
      parse={parseMobaXtermSessions}
      connections={mobaXtermConnections}
      reviewNotice="Passwords are not copied, and private keys are referenced where they are, not copied. SSH gateways become jump hosts in a “MobaXterm jump hosts” folder. Muxus asks for credentials when you connect."
      privacyNotice="Muxus only reads connection metadata. It never imports MobaXterm passwords or writes secrets into your SSH config."
      autoSource={
        canAutoDetect
          ? {
              icon: <LaptopWindowsOutlinedIcon color="primary" />,
              title: 'Local MobaXterm',
              description: 'Read bookmark names, hosts and folders from this Windows account.',
              load: () => desktop.readMobaXtermSessions(),
            }
          : undefined
      }
    />
  );
}
