import type { ReactElement, ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Stack from '@mui/material/Stack';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import Typography from '@mui/material/Typography';
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import UsbOutlinedIcon from '@mui/icons-material/UsbOutlined';

export type ConnectionKind = 'ssh' | 'telnet' | 'serial';

export interface EditorSectionDef<S extends string> {
  value: S;
  label: string;
  icon: ReactElement;
  /** Shown as "Label (n)" when > 0, matching the SSH editor's rail. */
  count?: number;
}

/**
 * The one dialog anatomy every host editor renders into: title with a storage
 * caption, connection-type tabs while creating, a left section rail beside a
 * fixed-height content area, and a shared action row. Keeping this identical
 * for SSH, Telnet, and serial is what stops the dialog from jumping around
 * when the connection type changes.
 */
export function EditorShell<S extends string>({
  title,
  storage,
  typeKind,
  onTypeChange,
  sections,
  section,
  onSection,
  problem,
  loading,
  busy,
  onDelete,
  deletePending,
  onClose,
  onSave,
  children,
}: {
  title: string;
  /** Where the host is persisted (ssh_config path or Muxus app data). */
  storage: string;
  /** Set while creating a new host to offer the SSH/Telnet/serial switch. */
  typeKind?: ConnectionKind;
  onTypeChange?: (kind: ConnectionKind) => void;
  sections: EditorSectionDef<S>[];
  section: S;
  onSection: (section: S) => void;
  /** Blocks saving and is shown as a validation warning. */
  problem: string | null | undefined;
  /** Blocks saving while something the form needs is still in flight. */
  loading?: string | null;
  busy: boolean;
  onDelete?: () => void;
  deletePending?: boolean;
  onClose: () => void;
  onSave: (connect: boolean) => void;
  children: ReactNode;
}) {
  const tabLabel = (label: string, count?: number) =>
    count && count > 0 ? `${label} (${count})` : label;

  return (
    <>
      <DialogTitle sx={{ pb: 1 }}>
        {title}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {storage}
        </Typography>
      </DialogTitle>
      <DialogContent
        sx={{
          pb: 0.5,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {typeKind && onTypeChange && (
          <ConnectionTypeTabs kind={typeKind} onChange={onTypeChange} />
        )}
        <Stack
          direction="row"
          spacing={2.5}
          sx={{ flex: 1, minHeight: 0, pt: typeKind ? 1.5 : 0 }}
        >
          <Tabs
            orientation="vertical"
            value={section}
            onChange={(_e, v: S) => onSection(v)}
            sx={{
              borderRight: 1,
              borderColor: 'divider',
              minWidth: 178,
              flexShrink: 0,
              '& .MuiTab-root': { minHeight: 42, justifyContent: 'flex-start', textAlign: 'left', textTransform: 'none', fontSize: 13, gap: 1, pl: 0.5 },
            }}
          >
            {sections.map((def) => (
              <Tab
                key={def.value}
                value={def.value}
                icon={def.icon}
                iconPosition="start"
                label={tabLabel(def.label, def.count)}
              />
            ))}
          </Tabs>
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              overflowY: 'auto',
              // Outlined fields float their labels above the input border.
              // Keep that first label inside the scroll container's clip area.
              pt: 1.5,
              pr: 0.5,
              pb: 1,
            }}
          >
            {children}
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        {onDelete && (
          <Button color="error" disabled={deletePending} onClick={onDelete}>
            Delete
          </Button>
        )}
        {/* Validation is the user's problem to fix; a pending load is ours, so
            they read as different things even though both hold Save back. */}
        {problem ? (
          <Typography variant="caption" color="warning.main" sx={{ ml: 1, mr: 'auto' }}>
            {problem}
          </Typography>
        ) : loading ? (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1, mr: 'auto' }}>
            {loading}
          </Typography>
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={!!problem || !!loading || busy} onClick={() => onSave(false)}>
          Save
        </Button>
        <Button
          variant="contained"
          disabled={!!problem || !!loading || busy}
          onClick={() => onSave(true)}
        >
          Save & connect
        </Button>
      </DialogActions>
    </>
  );
}

export function ConnectionTypeTabs({
  kind,
  onChange,
}: {
  kind: ConnectionKind;
  onChange: (kind: ConnectionKind) => void;
}) {
  return (
    <Tabs
      value={kind}
      onChange={(_event, value: ConnectionKind) => onChange(value)}
      variant="fullWidth"
      sx={{ borderBottom: 1, borderColor: 'divider' }}
    >
      <Tab value="ssh" icon={<DnsOutlinedIcon fontSize="small" />} iconPosition="start" label="SSH" />
      <Tab value="telnet" icon={<LanguageOutlinedIcon fontSize="small" />} iconPosition="start" label="Telnet" />
      <Tab value="serial" icon={<UsbOutlinedIcon fontSize="small" />} iconPosition="start" label="Serial" />
    </Tabs>
  );
}
