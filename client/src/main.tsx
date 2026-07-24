import '@azurity/pure-nerd-font/pure-nerd-font.css';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, initAuthToken } from './api/http.js';
import { showErrorToast } from './state/toast.js';
import { installShortcuts } from './shortcuts.js';
import App from './App.js';

initAuthToken();
installShortcuts();

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    // Safety net so a failed action is never silent: mutations that handle
    // their own errors keep doing so. Unreachable-backend and stale-token
    // failures are excluded — the global status banner owns those.
    onError: (error, _variables, _context, mutation) => {
      if (mutation.options.onError) return;
      if (error instanceof ApiError && (error.status === 0 || error.status === 401)) return;
      showErrorToast(error);
    },
  }),
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
