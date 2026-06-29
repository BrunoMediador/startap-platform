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
 * `useTenantTz()` NÃO lança fora do provider: devolve o default São Paulo.
 *
 * Dois caminhos alimentam o MESMO contexto (logo, o MESMO `useTenantTz()`):
 *  - DONO: `TenantTzProvider` lê `GET /portal/status` (slot da sessão do dono).
 *  - COLABORADOR: sessão própria, sem acesso a /portal/status. O painel dele usa
 *    `TenantTzValueProvider` com o `timezone` que vem na resposta da agenda
 *    (portal-colaborador.ts) — ver colaborador-agenda-client.
 */
import { useStatus } from '@/lib/queries';
import { createContext, useContext } from 'react';
import { useTenant } from './session-context';

const DEFAULT_TZ = 'America/Sao_Paulo';

const TzCtx = createContext<string>(DEFAULT_TZ);

/**
 * Provider de BAIXO nível: fixa o fuso a partir de um valor JÁ resolvido (string IANA, ou
 * null/undefined enquanto não veio). Pra quem tem o fuso "na mão" — ex.: o painel do
 * COLABORADOR, que recebe `timezone` na resposta da agenda e não passa pelo provider do dono.
 * Vazio/null -> default São Paulo (seguro). `useTenantTz()` resolve igual nos dois caminhos.
 */
export function TenantTzValueProvider({
  timeZone,
  children,
}: {
  timeZone: string | null | undefined;
  children: React.ReactNode;
}) {
  return <TzCtx.Provider value={timeZone || DEFAULT_TZ}>{children}</TzCtx.Provider>;
}

/** DONO: lê o fuso do clone de GET /portal/status (dedup do React Query, sem fetch extra). */
export function TenantTzProvider({ children }: { children: React.ReactNode }) {
  const { slot } = useTenant();
  const { data } = useStatus(slot);
  return <TenantTzValueProvider timeZone={data?.timezone}>{children}</TenantTzValueProvider>;
}

/** Fuso IANA do tenant pro display. Default São Paulo (seguro) enquanto carrega / fora do provider. */
export function useTenantTz(): string {
  return useContext(TzCtx);
}
