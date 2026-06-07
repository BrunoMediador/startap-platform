'use client';

import { ApiError } from '@/lib/api';
/**
 * Providers do client: TanStack Query + Toast.
 *
 * Logout limpa o cache (queryClient.clear()) — regra multi-tenant: nunca vazar
 * dados de um tenant pro proximo login. O QueryClient e criado uma vez por
 * montagem (useState) pra nao recriar a cada render.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { ToastProvider } from './ui/toast';

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: (failureCount, error) => {
              // Nao reintenta 4xx (auth/validacao); reintenta rede/5xx ate 2x.
              if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
                return false;
              }
              return failureCount < 2;
            },
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
