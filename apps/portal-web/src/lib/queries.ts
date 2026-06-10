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
  ContatosResponse,
  Horarios,
  HorariosResponse,
  MensalidadeResponse,
  PausasResponse,
  Servico,
  ServicosResponse,
  SimularResponse,
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
 * Gera (ou reusa, idempotente) a cobranca PIX do ciclo atual. Em sucesso, escreve
 * a cobranca no cache da query de mensalidade — o QR aparece na hora, e o poll do
 * useMensalidade assume dali (status `pending`).
 */
export function useGerarPix(slot: string): UseMutationResult<ChargeView, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<ChargeView>('/portal/mensalidade/pix', { method: 'POST' }),
    onSuccess: (charge) => {
      client.setQueryData<MensalidadeResponse>(qk.mensalidade(slot), (prev) =>
        prev ? { ...prev, charge } : prev,
      );
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
