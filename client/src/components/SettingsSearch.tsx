import { useMemo, useState } from 'react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import InputAdornment from '@mui/material/InputAdornment';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { SvgIconComponent } from '@mui/icons-material';
import SearchIcon from '@mui/icons-material/Search';
import { useAppInfo } from '../api/queries.js';
import { searchSettings, type SettingsSearchEntry } from '../settings-search.js';
import type { SettingsSection } from '../state/ui.js';

export interface SettingsSectionInfo {
  id: SettingsSection;
  label: string;
  icon: SvgIconComponent;
}

const entryKey = (entry: SettingsSearchEntry) => `${entry.section}:${entry.kind ?? 'row'}:${entry.label}`;

/**
 * Find a setting by name or by what it is about. Results list as you type;
 * choosing one opens its section and outlines it.
 */
export function SettingsSearch({
  sections,
  onPick,
  inputRef,
}: {
  sections: readonly SettingsSectionInfo[];
  onPick: (entry: SettingsSearchEntry) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const platform = useAppInfo().data?.platform;
  const byId = useMemo(() => new Map(sections.map((section) => [section.id, section])), [sections]);
  const results = useMemo(
    () =>
      searchSettings(query, {
        sectionLabel: (id) => byId.get(id)?.label ?? id,
        desktop: !!window.muxusDesktop,
        platform,
      }),
    [byId, platform, query],
  );

  return (
    <Autocomplete<SettingsSearchEntry>
      size="small"
      options={results}
      // Already searched: the index ranks better than a plain substring filter.
      filterOptions={(options) => options}
      value={null}
      inputValue={query}
      onInputChange={(_event, value, reason) => {
        if (reason === 'input' || reason === 'clear') setQuery(value);
      }}
      onChange={(_event, entry) => {
        if (!entry) return;
        setQuery('');
        setOpen(false);
        onPick(entry);
      }}
      open={open && query.trim() !== ''}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      getOptionLabel={(entry) => entry.label}
      getOptionKey={entryKey}
      autoHighlight
      blurOnSelect
      clearOnEscape
      forcePopupIcon={false}
      noOptionsText="No settings match"
      slotProps={{
        // Wider than the field atop the section list, which is narrower than a result.
        popper: { placement: 'bottom-start', style: { minWidth: 380, maxWidth: 'calc(100vw - 32px)' } },
        listbox: { sx: { maxHeight: 420 } },
      }}
      renderOption={(props, entry) => {
        const { key, ...rest } = props;
        const section = byId.get(entry.section);
        const Icon = section?.icon;
        return (
          <Box
            component="li"
            key={key}
            {...rest}
            sx={{ display: 'flex', gap: 1.25, '&&': { alignItems: 'flex-start' } }}
          >
            {Icon ? <Icon sx={{ fontSize: 18, mt: 0.25, color: 'text.secondary', flexShrink: 0 }} /> : null}
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" sx={{ fontWeight: 550 }}>
                {entry.label}
              </Typography>
              <Typography variant="caption" color="textSecondary" component="div">
                {[section?.label, entry.group].filter(Boolean).join(' › ')}
              </Typography>
            </Box>
          </Box>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          inputRef={inputRef}
          placeholder="Search settings"
          slotProps={{
            ...params.slotProps,
            input: {
              ...params.slotProps.input,
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
            htmlInput: { ...params.slotProps.htmlInput, 'aria-label': 'Search settings' },
          }}
        />
      )}
    />
  );
}
