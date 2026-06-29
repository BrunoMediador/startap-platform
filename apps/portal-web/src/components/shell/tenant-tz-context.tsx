'use client';

/**
 * Fuso horário do clone (tenant) pro display da agenda. O backend grava
 * `flow_clones.timezone` (default São Paulo) e expõe em `GET /portal/status`; aqui a gente lê
 * via `useStatus(slot)` e disponibiliza pro display via `useTenantTz()`.
 *
 * Por quê: a barbearia de Mato Grosso (`America/Cuiaba`, UTC-4) via o horário 1h adiantado
 * porque o portal cravava `America/Sao_Paulo` (UTC-3). Os formatadores de `lib/format` agora
 * aceitam `timeZone`; este provider entrega o fuso certo pra cada tenant.
 *
 * Default seguro: enquanto o status carrega — OU se a portal-api ainda não devolve `timezone`
 * (deploy do backend pendente) — cai em São Paulo, mantendo a saída byte-idêntica à de hoje.
 * `useTenantTz()` NÃO lança fora do provider (ex.: painel do colaborador, que tem sessão
 * própria sem este provider): devolve o default São Paulo.
 */
import { useStatus } from '@/lib/queries';
import { createContext, useContext } from 'react';
import { useTenant } from './session-context';

const DEFAULT_TZ = 'America/Sao_Paulo';

const TzCtx = createContext<string>(DEFAULT_TZ);

export function TenantTzProvider({ children }: { children: React.ReactNode }) {
  const { slot } = useTenant();
  // Mesma queryKey do resto do app -> a request é deduplicada pelo React Query (sem fetch extra).
  const { data } = useStatus(slot);
  const tz = data?.timezone ?? DEFAULT_TZ;
  return <TzCtx.Provider value={tz}>{children}</TzCtx.Provider>;
}

/** Fuso IANA do tenant pro display. Default São Paulo (seguro) enquanto carrega / fora do provider. */
export function useTenantTz(): string {
  return useContext(TzCtx);
}
