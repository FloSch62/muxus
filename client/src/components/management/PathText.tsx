import { Fragment, useMemo } from 'react';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';
import { formatGnmiPath, stripModulePrefix, tryParseGnmiPath, type GnmiPath } from '@muxus/shared';
import { statusTextColor } from '../../theme.js';

export const MONO_FONT = '"JetBrains Mono", "SFMono-Regular", Consolas, monospace';

/**
 * A gNMI path set for reading: separators and key names recede, key values
 * stand out, YANG module prefixes are dropped unless asked for.
 */
export function PathText({
  path,
  skip = 0,
  showModules = false,
  sx,
}: {
  path: string | GnmiPath;
  /** Leading elements to leave out (they are shown elsewhere, e.g. a subscription's path). */
  skip?: number;
  showModules?: boolean;
  sx?: SxProps<Theme>;
}) {
  const parsed = useMemo(() => (typeof path === 'string' ? tryParseGnmiPath(path) : path), [path]);
  if (!parsed) {
    return (
      <Box component="span" sx={[{ fontFamily: MONO_FONT }, ...(Array.isArray(sx) ? sx : [sx])]}>
        {typeof path === 'string' ? path : formatGnmiPath(path)}
      </Box>
    );
  }
  const elems = parsed.elems.slice(skip);
  return (
    <Box
      component="span"
      sx={[
        { fontFamily: MONO_FONT, fontSize: 'inherit', wordBreak: 'break-word', overflowWrap: 'anywhere' },
        ...(Array.isArray(sx) ? sx : [sx]),
      ]}
    >
      {parsed.origin && skip === 0 && (
        <Box component="span" sx={{ color: 'text.secondary' }}>
          {parsed.origin}:
        </Box>
      )}
      {elems.length === 0 && (
        <Box component="span" sx={{ color: 'text.secondary' }}>
          /
        </Box>
      )}
      {elems.map((elem, index) => {
        const module = elem.name.includes(':') ? elem.name.slice(0, elem.name.indexOf(':') + 1) : '';
        return (
          <Fragment key={index}>
            <Box component="span" sx={{ color: 'text.disabled' }}>
              /
            </Box>
            {showModules && module && (
              <Box component="span" sx={{ color: 'text.disabled' }}>
                {module}
              </Box>
            )}
            <span>{stripModulePrefix(elem.name)}</span>
            {Object.entries(elem.keys ?? {}).map(([key, value]) => (
              <Box component="span" key={key} sx={{ whiteSpace: 'nowrap' }}>
                <Box component="span" sx={{ color: 'text.disabled' }}>
                  [{key}=
                </Box>
                <Box component="span" sx={{ color: 'secondary.main', fontWeight: 550 }}>
                  {value}
                </Box>
                <Box component="span" sx={{ color: 'text.disabled' }}>
                  ]
                </Box>
              </Box>
            ))}
          </Fragment>
        );
      })}
    </Box>
  );
}

/** A leaf value as text, the way the device sent it. */
export function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => valueText(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value.toString();
  return '';
}

export type ValueTone = 'success' | 'error' | 'info';

/** A hue for leaf values by what they look like: numbers, and states that read as good or bad. */
export function valueTone(value: unknown): ValueTone | undefined {
  if (typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))) return 'info';
  if (typeof value === 'string') {
    if (/^(up|enable|enabled|active|established|true|ok|running|ready)$/i.test(value)) return 'success';
    if (/^(down|disable|disabled|failed|error|idle|false|lower-layer-down|not-present)$/i.test(value)) return 'error';
  }
  return undefined;
}

/** sx color for a leaf value: readable status hues in both themes, plain text otherwise. */
export function valueColorSx(value: unknown): ((theme: Theme) => string) | string {
  const tone = valueTone(value);
  return tone ? statusTextColor(tone) : 'text.primary';
}
