import { Component, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import ErrorOutlinedIcon from '@mui/icons-material/ErrorOutlined';

interface Props {
  children: ReactNode;
  /** Names the crashed surface in the fallback, e.g. "This tab". */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors so one crashing surface (a tab pane, the SFTP panel)
 * shows an inline fallback instead of white-screening the whole app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, height: '100%', flexDirection: 'column', gap: 1.5, p: 4 }}>
        <Box
          sx={(theme) => ({
            width: 72,
            height: 72,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            color: 'error.main',
            bgcolor: alpha(theme.palette.error.main, theme.palette.mode === 'dark' ? 0.12 : 0.07),
            '& svg': { fontSize: 36 },
          })}
        >
          <ErrorOutlinedIcon />
        </Box>
        <Typography variant="h6">{this.props.label ?? 'This view'} ran into an error</Typography>
        <Typography
          variant="body2"
          color="text.secondary"
          sx={{ maxWidth: 560, textAlign: 'center', fontFamily: 'monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
        >
          {error.message}
        </Typography>
        <Button variant="outlined" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </Box>
    );
  }
}
