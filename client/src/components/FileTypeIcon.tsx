import { memo, type ComponentType } from 'react';
import ArchiveRoundedIcon from '@mui/icons-material/ArchiveRounded';
import ArticleRoundedIcon from '@mui/icons-material/ArticleRounded';
import AudioFileRoundedIcon from '@mui/icons-material/AudioFileRounded';
import DataObjectRoundedIcon from '@mui/icons-material/DataObjectRounded';
import DescriptionRoundedIcon from '@mui/icons-material/DescriptionRounded';
import FolderRoundedIcon from '@mui/icons-material/FolderRounded';
import FontDownloadRoundedIcon from '@mui/icons-material/FontDownloadRounded';
import ImageRoundedIcon from '@mui/icons-material/ImageRounded';
import KeyRoundedIcon from '@mui/icons-material/KeyRounded';
import LinkRoundedIcon from '@mui/icons-material/LinkRounded';
import LockRoundedIcon from '@mui/icons-material/LockRounded';
import PictureAsPdfRoundedIcon from '@mui/icons-material/PictureAsPdfRounded';
import SettingsRoundedIcon from '@mui/icons-material/SettingsRounded';
import StorageRoundedIcon from '@mui/icons-material/StorageRounded';
import TerminalRoundedIcon from '@mui/icons-material/TerminalRounded';
import VerifiedUserRoundedIcon from '@mui/icons-material/VerifiedUserRounded';
import VideoFileRoundedIcon from '@mui/icons-material/VideoFileRounded';
import Box from '@mui/material/Box';
import type { SvgIconProps } from '@mui/material/SvgIcon';
import {
  fileIconKind,
  folderIconKind,
  type FileIconKind,
  type FolderIconKind,
} from '../file-icon-resolver.js';

type GlyphComponent = ComponentType<SvgIconProps>;

interface FileVisual {
  color: string;
  glyph?: GlyphComponent;
  label?: string;
  labelColor?: string;
}

const FILE_VISUALS: Readonly<Record<FileIconKind, FileVisual>> = {
  archive: { color: '#c49a6c', glyph: ArchiveRoundedIcon },
  audio: { color: '#66bb6a', glyph: AudioFileRoundedIcon },
  binary: { color: '#78909c', label: '01' },
  build: { color: '#ffb74d', label: '⚒', labelColor: '#4a2b00' },
  c: { color: '#5c6bc0', label: 'C' },
  certificate: { color: '#4db6ac', glyph: VerifiedUserRoundedIcon },
  code: { color: '#90a4ae', label: '<>' },
  config: { color: '#90a4ae', glyph: SettingsRoundedIcon },
  cpp: { color: '#5c6bc0', label: 'C+' },
  csharp: { color: '#9b4f96', label: 'C#' },
  css: { color: '#42a5f5', label: '#' },
  csv: { color: '#66bb6a', label: 'CSV', labelColor: '#143a17' },
  database: { color: '#ab47bc', glyph: StorageRoundedIcon },
  docker: { color: '#2496ed', label: 'DK' },
  env: { color: '#ecd53f', label: 'ENV', labelColor: '#3b3400' },
  file: { color: '#90a4ae', glyph: DescriptionRoundedIcon },
  font: { color: '#ab47bc', glyph: FontDownloadRoundedIcon },
  git: { color: '#f05032', label: '◆' },
  go: { color: '#00add8', label: 'GO', labelColor: '#00313d' },
  graphql: { color: '#e535ab', label: 'GQ' },
  html: { color: '#e44d26', label: '5' },
  image: { color: '#ba68c8', glyph: ImageRoundedIcon },
  java: { color: '#e76f00', label: 'JV' },
  javascript: { color: '#f7df1e', label: 'JS', labelColor: '#332f00' },
  json: { color: '#e9c46a', glyph: DataObjectRoundedIcon, labelColor: '#443600' },
  key: { color: '#f5c451', glyph: KeyRoundedIcon },
  kotlin: { color: '#7f52ff', label: 'KT' },
  license: { color: '#d4a72c', label: '§', labelColor: '#3e2d00' },
  lock: { color: '#e0a84b', glyph: LockRoundedIcon },
  log: { color: '#9e9e9e', label: 'LOG', labelColor: '#292929' },
  markdown: { color: '#519aba', label: 'M↓' },
  npm: { color: '#cb3837', label: 'N' },
  pdf: { color: '#ef5350', glyph: PictureAsPdfRoundedIcon },
  php: { color: '#777bb4', label: 'PHP' },
  pnpm: { color: '#f69220', label: 'PN', labelColor: '#442300' },
  powershell: { color: '#2671be', label: '>_' },
  proto: { color: '#f1b44c', label: 'PB', labelColor: '#3d2a00' },
  python: { color: '#3776ab', label: 'PY' },
  react: { color: '#61dafb', label: '⚛', labelColor: '#073642' },
  ruby: { color: '#cc342d', label: 'RB' },
  rust: { color: '#dea584', label: 'RS', labelColor: '#3d251b' },
  sass: { color: '#cd6799', label: 'S' },
  shell: { color: '#66bb6a', glyph: TerminalRoundedIcon },
  sql: { color: '#ec6f9e', label: 'SQL', labelColor: '#491729' },
  svelte: { color: '#ff3e00', label: 'SV' },
  swift: { color: '#f05138', label: 'SW' },
  terraform: { color: '#7b42bc', label: 'TF' },
  text: { color: '#90a4ae', glyph: ArticleRoundedIcon },
  toml: { color: '#9c6b53', label: 'T' },
  typescript: { color: '#3178c6', label: 'TS' },
  video: { color: '#ec6f9e', glyph: VideoFileRoundedIcon },
  vue: { color: '#42b883', label: 'V', labelColor: '#123a2d' },
  xml: { color: '#ef8d47', label: '<>' },
  yaml: { color: '#cb171e', label: 'YML' },
  yarn: { color: '#2c8ebb', label: 'Y' },
};

interface FolderVisual {
  color: string;
  label?: string;
  labelColor?: string;
}

const FOLDER_VISUALS: Readonly<Record<FolderIconKind, FolderVisual>> = {
  assets: { color: '#ba68c8', label: '◇' },
  build: { color: '#ffb74d', label: '□', labelColor: '#4a2b00' },
  cloud: { color: '#4fc3f7', label: '☁', labelColor: '#063745' },
  config: { color: '#90a4ae', label: '⚙', labelColor: '#263238' },
  database: { color: '#ab47bc', label: 'DB' },
  dependencies: { color: '#66bb6a', label: 'N', labelColor: '#143a17' },
  docker: { color: '#2496ed', label: 'DK' },
  docs: { color: '#5c9ded', label: '¶' },
  folder: { color: '#d7a84d' },
  git: { color: '#f0785a', label: '◆', labelColor: '#4a160a' },
  public: { color: '#4dd0e1', label: '◎', labelColor: '#073b42' },
  scripts: { color: '#e4bd4b', label: '>_', labelColor: '#3b3100' },
  secure: { color: '#e0a84b', label: '●', labelColor: '#4a3000' },
  source: { color: '#64b5f6', label: '</>', labelColor: '#0a3554' },
  tests: { color: '#4db6ac', label: '✓', labelColor: '#0b3b37' },
};

function FileBadge({ visual }: { visual: FileVisual }) {
  if (visual.glyph) {
    const Glyph = visual.glyph;
    return <Glyph sx={{ color: visual.color, fontSize: 19 }} />;
  }

  return (
    <Box sx={{ position: 'relative', width: 20, height: 20, flexShrink: 0 }}>
      <DescriptionRoundedIcon sx={{ color: visual.color, fontSize: 20, position: 'absolute', inset: 0 }} />
      <Box
        component="span"
        sx={{
          position: 'absolute',
          inset: '5px 2px 1px 1px',
          display: 'grid',
          placeItems: 'center',
          color: visual.labelColor ?? '#fff',
          fontFamily: '"Inter Variable", "Inter", sans-serif',
          fontSize: visual.label && visual.label.length > 2 ? 5.5 : 7,
          fontWeight: 800,
          letterSpacing: -0.35,
          lineHeight: 1,
        }}
      >
        {visual.label}
      </Box>
    </Box>
  );
}

function FolderBadge({ name }: { name: string }) {
  const visual = FOLDER_VISUALS[folderIconKind(name)];
  return (
    <Box sx={{ position: 'relative', width: 21, height: 20, flexShrink: 0 }}>
      <FolderRoundedIcon sx={{ color: visual.color, fontSize: 21, position: 'absolute', inset: 0 }} />
      {visual.label ? (
        <Box
          component="span"
          sx={{
            position: 'absolute',
            inset: '7px 1px 1px',
            display: 'grid',
            placeItems: 'center',
            color: visual.labelColor ?? '#fff',
            fontFamily: '"Inter Variable", "Inter", sans-serif',
            fontSize: visual.label.length > 2 ? 5.5 : 7,
            fontWeight: 850,
            letterSpacing: -0.45,
            lineHeight: 1,
          }}
        >
          {visual.label}
        </Box>
      ) : null}
    </Box>
  );
}

/** A compact, vscode-icons-inspired icon for remote files, folders, and links. */
export const FileTypeIcon = memo(function FileTypeIcon({
  name,
  type = 'file',
}: {
  name: string;
  type?: 'file' | 'dir' | 'link' | 'other';
}) {
  if (type === 'dir') return <FolderBadge name={name} />;
  if (type === 'link') return <LinkRoundedIcon sx={{ color: '#78909c', fontSize: 19 }} />;
  return <FileBadge visual={FILE_VISUALS[fileIconKind(name)]} />;
});
