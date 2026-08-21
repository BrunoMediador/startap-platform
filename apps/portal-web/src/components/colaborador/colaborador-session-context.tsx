'use client';

/**
 * Contexto da sessão do COLABORADOR (SCRUM-32). slot + colaboradorId vêm do
 * servidor (guard /auth/colaborador/me) e ficam disponíveis pras telas usarem nas
 * query keys (isolamento de cache por barbeiro). READ-ONLY — nunca editável pelo
 * cliente. Separado de SessionProvider (dono) de propósito: o colaborador não tem
 * productType/seatCap/atendimentosEnabled — só a identidade dele.
 */
import { createContext, useContext } from 'react';

interface ColaboradorCtx {
  slot: string;
  colaboradorId: number;
  displayName: string;
  username: string;
  /** Fuso IANA do clone (do /auth/colaborador/me). null = ausente -> display cai no default SP. */
  timezone: string | null;
  /** Mesmo gate do owner: ausente = OFF/fail-closed. */
  crmClientesEnabled: boolean;
}

const Ctx = createContext<ColaboradorCtx | null>(null);

export function ColaboradorSessionProvider({
  slot,
  colaboradorId,
  displayName,
  username,
  timezone,
  crmClientesEnabled,
  children,
}: ColaboradorCtx & { children: React.ReactNode }) {
  return (
    <Ctx.Provider
      value={{ slot, colaboradorId, displayName, username, timezone, crmClientesEnabled }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useColaborador(): ColaboradorCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useColaborador precisa de <ColaboradorSessionProvider>');
  return ctx;
}
