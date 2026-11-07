import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import { App } from './App';
import { ApiError } from './lib/api';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // A rejected filter or an origin refusal will not change on retry.
      retry: (count, error) => count < 1 && !(error instanceof ApiError && (error.kind === 'invalid' || error.kind === 'forbidden')),
      retryDelay: 400,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
