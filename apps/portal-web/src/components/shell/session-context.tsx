'use client';

/**
 * Contexto de sessao do client. O slot vem do servidor (guard /auth/me) e fica
 * disponivel pras telas usarem nas query keys (isolamento por tenant). Nunca e
 * editavel pelo cliente — so leitura.
 */
import { createContext, useContext } from 'react';

interface SessionCtx {
  slot: string;
  username: string;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({
  slot,
  username,
  children,
}: SessionCtx & { children: React.ReactNode }) {
  return <Ctx.Provider value={{ slot, username }}>{children}</Ctx.Provider>;
}

export function useTenant(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTenant precisa de <SessionProvider>');
  return ctx;
}
