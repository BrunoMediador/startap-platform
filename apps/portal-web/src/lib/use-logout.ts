'use client';

/**
 * Logout: chama POST /auth/logout (destroi a sessao no Redis + limpa cookie),
 * limpa TODO o cache do React Query (regra multi-tenant — nada do tenant anterior
 * sobrevive) e redireciona pro /login.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import { apiFetch } from './api';

export function useLogout() {
  const client = useQueryClient();
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const logout = useCallback(async () => {
    setPending(true);
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // logout e best-effort: mesmo se a chamada falhar, limpamos o estado local.
    } finally {
      client.clear();
      router.replace('/login');
      router.refresh();
    }
  }, [client, router]);

  return { logout, pending };
}
