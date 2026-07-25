import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import { useMemo } from 'react';
import { useSavedHostProfiles, useSshConfig } from '../api/queries.js';
import { folderLabel, folderParentPath, knownFolderPaths } from '../host-tree.js';
import { usePrefsStore } from '../state/prefs.js';

/**
 * The one control for choosing a sidebar folder. Offers every existing path
 * including ancestors, and accepts a new one typed with `/` between levels.
 */
export function FolderPathField({
  value,
  onChange,
  label = 'Folder',
  helperText,
  error,
  /** Paths to hide — a folder can never be moved inside itself. */
  exclude,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  helperText?: string;
  error?: boolean;
  exclude?: (path: string) => boolean;
}) {
  const { data: config } = useSshConfig();
  const { data: savedData } = useSavedHostProfiles();
  const emptyFolders = usePrefsStore((state) => state.sidebarEmptyFolders);

  const options = useMemo(() => {
    const paths = knownFolderPaths(
      config?.hosts ?? [],
      savedData?.profiles ?? [],
      emptyFolders,
    );
    return exclude ? paths.filter((path) => !exclude(path)) : paths;
  }, [config?.hosts, savedData?.profiles, emptyFolders, exclude]);

  return (
    <Autocomplete
      freeSolo
      options={options}
      value={value}
      onInputChange={(_event, next) => onChange(next)}
      onChange={(_event, next) => onChange(next ?? '')}
      renderOption={(props, option) => {
        const { key, ...rest } = props;
        const parent = folderParentPath(option);
        return (
          <Box component="li" key={key} {...rest}>
            {parent && (
              <Box component="span" sx={{ color: 'text.disabled', mr: 0.5 }}>
                {parent.split('/').join(' / ')} /
              </Box>
            )}
            <Box component="span">{folderLabel(option)}</Box>
          </Box>
        );
      }}
      renderInput={(params) => (
        <TextField
          {...params}
          label={label}
          error={error}
          placeholder="e.g. Production/EU"
          helperText={helperText ?? 'Use / to nest, e.g. Production/EU. Leave empty for no folder.'}
        />
      )}
    />
  );
}
