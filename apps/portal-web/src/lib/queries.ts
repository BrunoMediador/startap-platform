'use client';

/**
 * Hooks de dados (TanStack Query) contra o portal-api via proxy same-origin.
 *
 * Multi-tenant: o slot e SEMPRE derivado da sessao no servidor (withTenant). O
 * front nunca envia slot. Mesmo assim, as query keys carregam o slot da sessao
 * (de /auth/me) pra isolar o cache por tenant — se trocar de login, as chaves
 * mudam e nada vaza. Logout faz queryClient.clear() (ver use-logout).
 */
import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiFetch } from './api';
import type {
  AgendamentosResponse,
  AuthMe,
  ChargeView,
  CodigoResponse,
  ConexaoResponse,
  ContatosResponse,
  Horarios,
  HorariosResponse,
  MensalidadeResponse,
  PausasResponse,
  QrResponse,
  ReconectarResponse,
  Servico,
  ServicosResponse,
  SimularResponse,
  StatusConexaoResponse,
  StatusResponse,
} from './api-types';

// ── Query keys (escopadas por slot da sessao) ────────────────────────────────

export const qk = {
  me: ['me'] as const,
  status: (slot: string) => ['status', slot] as const,
  servicos: (slot: string) => ['servicos', slot] as const,
  horarios: (slot: string) => ['horarios', slot] as const,
  pausas: (slot: string) => ['pausas', slot] as const,
  contatos: (slot: string) => ['contatos', slot] as const,
  agendamentos: (slot: string) => ['agendamentos', slot] as const,
  mensalidade: (slot: string) => ['mensalidade', slot] as const,
  conexao: (slot: string) => ['conexao', slot] as const,
};

// ── Sessao ───────────────────────────────────────────────────────────────────

export function useMe(): UseQueryResult<AuthMe> {
  return useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) => apiFetch<AuthMe>('/auth/me', { signal }),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ── Status / Home (auto-refresh 60s em foco — spec D6) ───────────────────────

export function useStatus(slot: string): UseQueryResult<StatusResponse> {
  return useQuery({
    queryKey: qk.status(slot),
    queryFn: ({ signal }) => apiFetch<StatusResponse>('/portal/status', { signal }),
    refetchInterval: () => (typeof document !== 'undefined' && !document.hidden ? 60_000 : false),
    refetchIntervalInBackground: false,
  });
}

export function useAgendamentos(slot: string): UseQueryResult<AgendamentosResponse> {
  return useQuery({
    queryKey: qk.agendamentos(slot),
    queryFn: ({ signal }) => apiFetch<AgendamentosResponse>('/portal/agendamentos', { signal }),
  });
}

// ── Servicos ─────────────────────────────────────────────────────────────────

export function useServicos(slot: string): UseQueryResult<Servico[]> {
  return useQuery({
    queryKey: qk.servicos(slot),
    queryFn: ({ signal }) =>
      apiFetch<ServicosResponse>('/portal/servicos', { signal }).then((r) => r.servicos),
  });
}

export function useSaveServicos(slot: string): UseMutationResult<Servico[], Error, Servico[]> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (servicos: Servico[]) =>
      apiFetch<{ ok: true; servicos: Servico[] }>('/portal/servicos', {
        method: 'PUT',
        body: { servicos },
      }).then((r) => r.servicos),
    onSuccess: (servicos) => {
      client.setQueryData(qk.servicos(slot), servicos);
    },
  });
}

// ── Horarios ─────────────────────────────────────────────────────────────────

export function useHorarios(slot: string): UseQueryResult<Horarios> {
  return useQuery({
    queryKey: qk.horarios(slot),
    queryFn: ({ signal }) =>
      apiFetch<HorariosResponse>('/portal/horarios', { signal }).then((r) => r.horarios),
  });
}

export function useSaveHorarios(slot: string): UseMutationResult<Horarios, Error, Horarios> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (horarios: Horarios) =>
      apiFetch<{ ok: true; horarios: Horarios }>('/portal/horarios', {
        method: 'PUT',
        body: { horarios },
      }).then((r) => r.horarios),
    onSuccess: (horarios) => {
      client.setQueryData(qk.horarios(slot), horarios);
    },
  });
}

// ── Pausas ───────────────────────────────────────────────────────────────────

export function usePausas(slot: string): UseQueryResult<PausasResponse> {
  return useQuery({
    queryKey: qk.pausas(slot),
    queryFn: ({ signal }) => apiFetch<PausasResponse>('/portal/pausas', { signal }),
  });
}

export function useContatos(slot: string, enabled: boolean): UseQueryResult<ContatosResponse> {
  return useQuery({
    queryKey: qk.contatos(slot),
    queryFn: ({ signal }) => apiFetch<ContatosResponse>('/portal/contatos', { signal }),
    enabled,
    staleTime: 30_000,
  });
}

export function useAddPausa(slot: string): UseMutationResult<unknown, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (telefone: string) =>
      apiFetch('/portal/pausas', { method: 'POST', body: { telefone } }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.pausas(slot) });
      client.invalidateQueries({ queryKey: qk.status(slot) });
    },
  });
}

export function useRemovePausa(slot: string): UseMutationResult<unknown, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (telefone: string) =>
      apiFetch(`/portal/pausas/${encodeURIComponent(telefone)}`, { method: 'DELETE' }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.pausas(slot) });
      client.invalidateQueries({ queryKey: qk.status(slot) });
    },
  });
}

// ── Mensalidade / Pagamento PIX (ADR 0013 F3) ────────────────────────────────

/**
 * Resumo da mensalidade + cobranca do ciclo. Enquanto a cobranca esta `pending`,
 * a query faz POLL a cada 10s (em foco) pra captar o `paid` que chega async pelo
 * webhook — assim a tela "vira pago" sozinha. Para o poll quando vira `paid`, ou
 * quando nao ha cobranca pendente (evita bater na API a toa).
 */
export function useMensalidade(slot: string): UseQueryResult<MensalidadeResponse> {
  return useQuery({
    queryKey: qk.mensalidade(slot),
    queryFn: ({ signal }) => apiFetch<MensalidadeResponse>('/portal/mensalidade', { signal }),
    refetchInterval: (query) => {
      const pending = query.state.data?.charge?.status === 'pending';
      if (!pending) return false;
      // So enquanto a aba esta visivel — pagamento e acao em foco do dono.
      return typeof document !== 'undefined' && !document.hidden ? 10_000 : false;
    },
    refetchIntervalInBackground: false,
  });
}

/**
 * Garante uma cobranca PIX PAGAVEL e valida do ciclo atual (POST idempotente): se
 * ja paga, devolve paga; se pending valida, reusa; se expirada/inexistente, gera/
 * reemite um QR novo. Em sucesso, escreve a cobranca no cache da query de
 * mensalidade — o QR aparece na hora, e o poll do useMensalidade assume dali (status
 * `pending`). Tambem invalida pra ressincronizar vencimento/billing quando o ciclo
 * ja veio `paid`. Disparada AUTOMATICAMENTE no mount da tela (sem botao "Gerar PIX").
 */
export function useGerarPix(slot: string): UseMutationResult<ChargeView, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<ChargeView>('/portal/mensalidade/pix', { method: 'POST' }),
    onSuccess: (charge) => {
      client.setQueryData<MensalidadeResponse>(qk.mensalidade(slot), (prev) =>
        prev ? { ...prev, charge } : prev,
      );
      // Se voltou `paid`, o due/billing mudou no backend — refetch pra refletir.
      if (charge.status === 'paid') {
        client.invalidateQueries({ queryKey: qk.mensalidade(slot) });
      }
    },
  });
}

/**
 * Dev-only: dispara o simulate-payment no gateway. O efeito (pago/renovacao) chega
 * async pelo WEBHOOK — entao apos disparar, invalidamos a query pra reativar o poll
 * e ver o status virar `paid`. 403 (simulacao_indisponivel) e tratado na tela.
 */
export function useSimularPagamento(slot: string): UseMutationResult<SimularResponse, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<SimularResponse>('/portal/mensalidade/simular', { method: 'POST' }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.mensalidade(slot) });
    },
  });
}

// ── Conexao WhatsApp (reconexao self-service) ────────────────────────────────

/**
 * Estado da conexao (GET /portal/conexao). Fonte da verdade pro item de menu, o
 * banner (needs_action) e o estado inicial da tela /conectar. Auto-refresh em
 * foco (60s) pra o badge-dot/banner reagirem quando o WhatsApp cai/volta fora da
 * tela de conexao. Sempre habilitada: o gate `enabled` e lido do resultado.
 */
export function useConexao(slot: string): UseQueryResult<ConexaoResponse> {
  return useQuery({
    queryKey: qk.conexao(slot),
    queryFn: ({ signal }) => apiFetch<ConexaoResponse>('/portal/conexao', { signal }),
    refetchInterval: () => (typeof document !== 'undefined' && !document.hidden ? 60_000 : false),
    refetchIntervalInBackground: false,
    retry: false,
  });
}

/**
 * Poll do status durante a reconexao (GET /portal/conexao/status, a cada 2s).
 * Liga/desliga por `enabled`; a propria tela para o poll quando `terminal:true`
 * setando enabled=false. Sem retry — cada tick e independente.
 */
export function useStatusConexao(
  slot: string,
  enabled: boolean,
): UseQueryResult<StatusConexaoResponse> {
  return useQuery({
    queryKey: [...qk.conexao(slot), 'status'] as const,
    queryFn: ({ signal }) => apiFetch<StatusConexaoResponse>('/portal/conexao/status', { signal }),
    enabled,
    refetchInterval: enabled ? 2_000 : false,
    refetchIntervalInBackground: false,
    gcTime: 0,
    retry: false,
  });
}

/** POST /portal/conexao/reconectar — inicia o restart da sessao WAHA (202). */
export function useReconectar(): UseMutationResult<ReconectarResponse, Error, void> {
  return useMutation({
    mutationFn: () =>
      apiFetch<ReconectarResponse>('/portal/conexao/reconectar', { method: 'POST' }),
  });
}

/** POST /portal/conexao/codigo — gera (ou regenera) o pairing code. */
export function useCodigoConexao(): UseMutationResult<CodigoResponse, Error, void> {
  return useMutation({
    mutationFn: () => apiFetch<CodigoResponse>('/portal/conexao/codigo', { method: 'POST' }),
  });
}

/** GET /portal/conexao/qr — busca o QR atual (data-URI) sob demanda. */
export function useQrConexao(): UseMutationResult<QrResponse, Error, void> {
  return useMutation({
    mutationFn: () => apiFetch<QrResponse>('/portal/conexao/qr'),
  });
}
