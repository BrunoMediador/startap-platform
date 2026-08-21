'use client';

/**
 * Contexto de sessao do client. O slot vem do servidor (guard /auth/me) e fica
 * disponivel pras telas usarem nas query keys (isolamento por tenant). Nunca e
 * editavel pelo cliente — so leitura.
 */
import type { ProductType } from '@/lib/api-types';
import { createContext, useContext } from 'react';

interface SessionCtx {
  slot: string;
  username: string;
  /** Tipo de conta (vem do servidor, READ-only). Default 'individual' — gating do
   *  painel de estabelecimento. Individual = portal enxuto idêntico ao de hoje. */
  productType: ProductType;
  /** Teto contratual de vagas do estabelecimento (null = sem teto / individual). */
  seatCap: number | null;
  /** App de gestão (atendimentos + relatórios) ligado p/ este cliente (flag do backend). */
  atendimentosEnabled: boolean;
  /**
   * Billing derivado da agenda (ADR 0027 Fase C). Quando true, a área de faturamento
   * ganha as abas Previsão/Faturado editáveis. false = faturamento IDÊNTICO ao de
   * hoje (SOLO Cirilo/Samuel não regride). Vem da sessão (READ-only).
   */
  atendFromAgenda: boolean;
  /** CRM Clientes (Missão 034). Acesso fail-closed: false/ausente esconde menu e rota. */
  crmClientesEnabled: boolean;
  /** WhatsApp manual do CRM: ausente/false não monta nenhuma ação de envio. */
  whatsappManualEnabled: boolean;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({
  slot,
  username,
  productType,
  seatCap,
  atendimentosEnabled,
  atendFromAgenda,
  crmClientesEnabled,
  whatsappManualEnabled,
  children,
}: SessionCtx & { children: React.ReactNode }) {
  return (
    <Ctx.Provider
      value={{
        slot,
        username,
        productType,
        seatCap,
        atendimentosEnabled,
        atendFromAgenda,
        crmClientesEnabled,
        whatsappManualEnabled,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTenant(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useTenant precisa de <SessionProvider>');
  return ctx;
}
