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
import { atualizarAgendamento, removerAgendamento } from './agendamentos';
import { apiFetch } from './api';
import type {
  AgendaSlotsResponse,
  AgendamentosResponse,
  AtendimentoBalde,
  AtendimentosListResponse,
  AuthMe,
  ChargeView,
  CodigoResponse,
  ColaboradorInput,
  ComissaoReport,
  ConexaoResponse,
  ContatosResponse,
  CriarAgendamentoBody,
  CriarAgendamentoResponse,
  CriarAtendimentoBody,
  CriarAtendimentoResponse,
  EditarAgendamentoBody,
  EditarAgendamentoResponse,
  EditarAtendimentoBody,
  EditarAtendimentoResponse,
  EquipeResponse,
  ExcluirAgendamentoResponse,
  FaturamentoReport,
  Horarios,
  HorariosResponse,
  MensalidadeResponse,
  PausasResponse,
  PerfilNegocio,
  PerfilResponse,
  QrResponse,
  ReconectarResponse,
  SaveColaboradorResponse,
  SavePerfilResponse,
  Servico,
  ServicosResponse,
  SimularResponse,
  StatusConexaoResponse,
  StatusResponse,
} from './api-types';
import { patchRowNaLista, removerRowDaLista } from './atendimentos-balde';
import { mapColaboradorRow } from './equipe';

// ── Query keys (escopadas por slot da sessao) ────────────────────────────────

export const qk = {
  me: ['me'] as const,
  status: (slot: string) => ['status', slot] as const,
  servicos: (slot: string) => ['servicos', slot] as const,
  perfil: (slot: string) => ['perfil', slot] as const,
  horarios: (slot: string) => ['horarios', slot] as const,
  pausas: (slot: string) => ['pausas', slot] as const,
  contatos: (slot: string) => ['contatos', slot] as const,
  agendamentos: (slot: string) => ['agendamentos', slot] as const,
  /** Prefixo por tenant — usar pra invalidar TODAS as grades de slots de uma vez. */
  agendaSlotsBase: (slot: string) => ['agenda-slots', slot] as const,
  agendaSlots: (slot: string, data: string, servico: string) =>
    ['agenda-slots', slot, data, servico] as const,
  mensalidade: (slot: string) => ['mensalidade', slot] as const,
  conexao: (slot: string) => ['conexao', slot] as const,
  equipe: (slot: string) => ['equipe', slot] as const,
  /** Prefixo por tenant — invalida todos os relatórios (qualquer período) de uma vez. */
  relatoriosBase: (slot: string) => ['relatorios', slot] as const,
  faturamento: (slot: string, de: string, ate: string) =>
    ['relatorios', slot, 'faturamento', de, ate] as const,
  comissao: (slot: string, de: string, ate: string) =>
    ['relatorios', slot, 'comissao', de, ate] as const,
  /** Prefixo por tenant — invalida TODAS as listas de baldes (ambos, qualquer período). */
  atendimentosBaldeBase: (slot: string) => ['atendimentos-balde', slot] as const,
  atendimentosBalde: (slot: string, balde: AtendimentoBalde, de: string, ate: string) =>
    ['atendimentos-balde', slot, balde, de, ate] as const,
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

// ── Novo agendamento (Missão 020 F4) ─────────────────────────────────────────

/**
 * Grade de horários LIVRES de um dia pra um serviço (GET /portal/agenda/slots).
 * Só roda com dia E serviço escolhidos. staleTime 0 + sem retry: a agenda é
 * disputada com o robô — grade velha vira 409 no POST, então sempre refaz.
 */
export function useAgendaSlots(
  slot: string,
  data: string | null,
  servico: string | null,
): UseQueryResult<AgendaSlotsResponse> {
  return useQuery({
    queryKey: qk.agendaSlots(slot, data ?? '', servico ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<AgendaSlotsResponse>(
        `/portal/agenda/slots?data=${encodeURIComponent(data ?? '')}&servico=${encodeURIComponent(servico ?? '')}`,
        { signal },
      ),
    enabled: Boolean(data && servico),
    staleTime: 0,
    retry: false,
  });
}

/**
 * POST /portal/agendamentos — o dono marca um horário sem passar pelo robô.
 * No 201, faz prepend do evento no cache da lista da Início (aparece na hora,
 * padrão D5) + invalida pra ressincronizar em background, e derruba as grades
 * de slots em cache do tenant (um horário acabou de ser consumido).
 * 409 (conflito) e 422 (gcal/config) são tratados NA TELA — aqui só o sucesso.
 */
export function useCriarAgendamento(
  slot: string,
): UseMutationResult<CriarAgendamentoResponse, Error, CriarAgendamentoBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      apiFetch<CriarAgendamentoResponse>('/portal/agendamentos', { method: 'POST', body }),
    onSuccess: ({ agendamento }) => {
      client.setQueryData<AgendamentosResponse>(qk.agendamentos(slot), (prev) =>
        prev
          ? {
              ...prev,
              count: prev.count + 1,
              agendamentos: [
                agendamento,
                ...prev.agendamentos.filter((a) => a.id !== agendamento.id),
              ],
            }
          : prev,
      );
      client.invalidateQueries({ queryKey: qk.agendamentos(slot) });
      client.invalidateQueries({ queryKey: qk.agendaSlotsBase(slot) });
    },
  });
}

/**
 * DELETE /portal/agendamentos/:eventId — cancela/exclui um evento na agenda do
 * tenant (W10 da Missão 023). AÇÃO IRREVERSÍVEL: apaga de verdade no Google
 * Calendar. No sucesso, remove o evento do cache da lista da Início na hora
 * (some sem reload), libera o horário (invalida grades de slots do tenant) e
 * ressincroniza a lista em background. 404/já-removido e erros de GCal são
 * tratados NA TELA (mensagem amigável) — aqui só o caminho feliz.
 *
 * O contrato do backend está em construção (worktree do backend); o front
 * consome `ExcluirAgendamentoResponse` e degrada com mensagem se a rota faltar.
 */
export function useExcluirAgendamento(
  slot: string,
): UseMutationResult<ExcluirAgendamentoResponse, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (eventId) =>
      apiFetch<ExcluirAgendamentoResponse>(`/portal/agendamentos/${encodeURIComponent(eventId)}`, {
        method: 'DELETE',
      }),
    onSuccess: (_res, eventId) => {
      client.setQueryData<AgendamentosResponse>(qk.agendamentos(slot), (prev) =>
        prev ? removerAgendamento(prev, eventId) : prev,
      );
      client.invalidateQueries({ queryKey: qk.agendamentos(slot) });
      client.invalidateQueries({ queryKey: qk.agendaSlotsBase(slot) });
    },
  });
}

/**
 * PATCH /portal/agendamentos/:eventId — remarca (data+hora) ou troca o serviço
 * de um evento já existente (Bloco C). No 200, faz update IN-PLACE no cache da
 * lista (o evento muda na hora, sem reload), libera/consome horário (invalida as
 * grades de slots do tenant) e ressincroniza a lista em background.
 *
 * Tratados NA TELA (sheet de detalhe), não aqui:
 *   400 payload · 404 não-pertence · 409 conflito (recarregar grade de slots)
 *   422 config ausente · 502 GCal. Aqui só o caminho feliz.
 *
 * O endpoint só fica live quando a PR do backend mergear+deployar; o front
 * consome contra o contrato (EditarAgendamentoBody/Response) e degrada com
 * mensagem amigável se a rota ainda não existir.
 */
export function useEditarAgendamento(
  slot: string,
): UseMutationResult<
  EditarAgendamentoResponse,
  Error,
  { eventId: string; patch: EditarAgendamentoBody }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ eventId, patch }) =>
      apiFetch<EditarAgendamentoResponse>(`/portal/agendamentos/${encodeURIComponent(eventId)}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: ({ agendamento }) => {
      client.setQueryData<AgendamentosResponse>(qk.agendamentos(slot), (prev) =>
        prev ? atualizarAgendamento(prev, agendamento) : prev,
      );
      client.invalidateQueries({ queryKey: qk.agendamentos(slot) });
      client.invalidateQueries({ queryKey: qk.agendaSlotsBase(slot) });
    },
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

// ── Perfil do negocio (GET/PUT /portal/perfil — Missão 023 W13) ──────────────
//
// O backend (#306) usa ENVELOPE `perfil` nos dois sentidos:
//   GET  -> 200 { perfil }                  ; PUT body = { perfil } -> 200 { ok, perfil }
// Os hooks desembrulham o envelope e expoem o `PerfilNegocio` cru pra tela (mesmo
// padrao de useSaveServicos/useSaveHorarios). O cache guarda o perfil cru. O slot
// vem da sessao no backend (nunca no body).

export function usePerfil(slot: string): UseQueryResult<PerfilNegocio> {
  return useQuery({
    queryKey: qk.perfil(slot),
    queryFn: ({ signal }) =>
      apiFetch<PerfilResponse>('/portal/perfil', { signal }).then((r) => r.perfil),
  });
}

export function useSavePerfil(
  slot: string,
): UseMutationResult<PerfilNegocio, Error, PerfilNegocio> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (perfil: PerfilNegocio) =>
      apiFetch<SavePerfilResponse>('/portal/perfil', {
        method: 'PUT',
        body: { perfil },
      }).then((r) => r.perfil),
    onSuccess: (perfil) => {
      client.setQueryData(qk.perfil(slot), perfil);
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

// ── Equipe / Colaboradores (estabelecimento — GET/POST/PATCH/DELETE) ─────────
//
// Toda rota é escopada por slot da sessão no backend (withTenant) + gated por
// product_type. O front nunca envia slot. A query key carrega o slot pra isolar o
// cache por tenant. As mutations invalidam a lista (refetch) em vez de editar o
// cache na mão: o backend é a fonte de verdade do seat_cap/uso (usados/seat_cap).

export function useEquipe(slot: string): UseQueryResult<EquipeResponse> {
  return useQuery({
    queryKey: qk.equipe(slot),
    // Normaliza id (BIGSERIAL -> string) e comissao_pct (NUMERIC) pra number no
    // boundary. Sem isso, id string quebra o gate de save e o POST de atendimento.
    queryFn: async ({ signal }) => {
      const res = await apiFetch<EquipeResponse>('/portal/equipe', { signal });
      return { ...res, colaboradores: res.colaboradores.map(mapColaboradorRow) };
    },
    retry: false,
  });
}

export function useCreateColaborador(
  slot: string,
): UseMutationResult<SaveColaboradorResponse, Error, ColaboradorInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      const res = await apiFetch<SaveColaboradorResponse>('/portal/equipe', {
        method: 'POST',
        body,
      });
      return { ...res, colaborador: mapColaboradorRow(res.colaborador) };
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.equipe(slot) });
    },
  });
}

export function useUpdateColaborador(
  slot: string,
): UseMutationResult<SaveColaboradorResponse, Error, { id: number; patch: ColaboradorInput }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }) => {
      const res = await apiFetch<SaveColaboradorResponse>(`/portal/equipe/${id}`, {
        method: 'PATCH',
        body: patch,
      });
      return { ...res, colaborador: mapColaboradorRow(res.colaborador) };
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.equipe(slot) });
    },
  });
}

export function useRemoveColaborador(slot: string): UseMutationResult<{ ok: true }, Error, number> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiFetch<{ ok: true }>(`/portal/equipe/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.equipe(slot) });
    },
  });
}

// ── App de gestão: atendimentos + relatórios (ADR 0026) ──────────────────────
//
// Toda rota é gated por ATENDIMENTOS_ENABLED no backend (404 quando OFF) e
// escopada por slot da sessão (withTenant). O front nunca envia slot. As query
// keys carregam o slot pra isolar o cache por tenant. 404 (flag off) é tratado NA
// TELA (estado "recurso indisponível"); aqui os hooks só transportam o contrato.

/**
 * POST /portal/atendimentos — registra um atendimento (dinheiro do cliente final).
 * No 201, invalida TODOS os relatórios do tenant (qualquer período) pra refletir o
 * lançamento novo. 400 (validação) e 404 (flag off) são tratados na tela.
 */
export function useCriarAtendimento(
  slot: string,
): UseMutationResult<CriarAtendimentoResponse, Error, CriarAtendimentoBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      apiFetch<CriarAtendimentoResponse>('/portal/atendimentos', { method: 'POST', body }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.relatoriosBase(slot) });
    },
  });
}

/**
 * GET /portal/relatorios/faturamento?de=&ate= — `de`/`ate` OBRIGATÓRIOS no
 * backend, então o hook só roda com os dois preenchidos (enabled). 404 (flag off)
 * é tratado na tela. Sem retry: 404 não se resolve sozinho.
 */
export function useFaturamento(
  slot: string,
  de: string | null,
  ate: string | null,
): UseQueryResult<FaturamentoReport> {
  return useQuery({
    queryKey: qk.faturamento(slot, de ?? '', ate ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<FaturamentoReport>(
        `/portal/relatorios/faturamento?de=${encodeURIComponent(de ?? '')}&ate=${encodeURIComponent(ate ?? '')}`,
        { signal },
      ),
    enabled: Boolean(de && ate),
    retry: false,
  });
}

/**
 * GET /portal/relatorios/comissao?de=&ate= — só EMPRESA tem dados (SOLO volta
 * vazio). `de`/`ate` OBRIGATÓRIOS (enabled só com os dois). 404 (flag off) na tela.
 */
export function useComissao(
  slot: string,
  de: string | null,
  ate: string | null,
): UseQueryResult<ComissaoReport> {
  return useQuery({
    queryKey: qk.comissao(slot, de ?? '', ate ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<ComissaoReport>(
        `/portal/relatorios/comissao?de=${encodeURIComponent(de ?? '')}&ate=${encodeURIComponent(ate ?? '')}`,
        { signal },
      ),
    enabled: Boolean(de && ate),
    retry: false,
  });
}

// ── Billing derivado da agenda (ADR 0027 Fase C) ─────────────────────────────
//
// Listas EDITÁVEIS por balde (previsao/faturado). Gated por ATENDIMENTOS_ENABLED +
// atend_from_agenda no backend (404 quando OFF, tratado na tela). Escopado por slot
// da sessão (withTenant) — o front nunca envia slot. Query key carrega slot + balde
// + período pra isolar o cache por tenant E não misturar os dois baldes.

/**
 * GET /portal/atendimentos?balde=&de=&ate= — linhas DERIVADAS da agenda do balde,
 * com `total_cents`. `de`/`ate` obrigatórios -> só roda com os dois (enabled). Sem
 * retry: 404 (flag off) não se resolve sozinho. `enabled` extra pra desligar quando
 * a feature está off (defesa em profundidade — não bate na API à toa).
 */
export function useAtendimentosBalde(
  slot: string,
  balde: AtendimentoBalde,
  de: string | null,
  ate: string | null,
  enabled = true,
): UseQueryResult<AtendimentosListResponse> {
  return useQuery({
    queryKey: qk.atendimentosBalde(slot, balde, de ?? '', ate ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<AtendimentosListResponse>(
        `/portal/atendimentos?balde=${balde}&de=${encodeURIComponent(de ?? '')}&ate=${encodeURIComponent(ate ?? '')}`,
        { signal },
      ),
    enabled: enabled && Boolean(de && ate),
    retry: false,
  });
}

/**
 * PATCH /portal/atendimentos/:id — edita uma linha (valor/forma/serviço/cliente).
 * No 200, faz update OTIMISTA in-place na lista do balde em foco (a Row volta com
 * `dirty_fields` -> badge "Editado" na hora) e invalida TODAS as listas de baldes
 * + os relatórios do tenant pra ressincronizar total/quebras. 400/404 na tela.
 */
export function useEditarAtendimento(
  slot: string,
  balde: AtendimentoBalde,
  de: string | null,
  ate: string | null,
): UseMutationResult<
  EditarAtendimentoResponse,
  Error,
  { id: number; patch: EditarAtendimentoBody }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }) =>
      apiFetch<EditarAtendimentoResponse>(`/portal/atendimentos/${id}`, {
        method: 'PATCH',
        body: patch,
      }),
    onSuccess: ({ atendimento }) => {
      client.setQueryData<AtendimentosListResponse>(
        qk.atendimentosBalde(slot, balde, de ?? '', ate ?? ''),
        (prev) => (prev ? patchRowNaLista(prev, atendimento) : prev),
      );
      client.invalidateQueries({ queryKey: qk.atendimentosBaldeBase(slot) });
      client.invalidateQueries({ queryKey: qk.relatoriosBase(slot) });
    },
  });
}

/**
 * DELETE /portal/atendimentos/:id — soft-delete (o atendimento não rolou). No
 * sucesso, remove a linha do cache do balde na hora (some sem reload) + invalida
 * todas as listas de baldes e os relatórios. 404 (já removido / flag off) na tela.
 */
export function useRemoverAtendimento(
  slot: string,
  balde: AtendimentoBalde,
  de: string | null,
  ate: string | null,
): UseMutationResult<{ ok: true }, Error, number> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id) => apiFetch<{ ok: true }>(`/portal/atendimentos/${id}`, { method: 'DELETE' }),
    onSuccess: (_res, id) => {
      client.setQueryData<AtendimentosListResponse>(
        qk.atendimentosBalde(slot, balde, de ?? '', ate ?? ''),
        (prev) => (prev ? removerRowDaLista(prev, id) : prev),
      );
      client.invalidateQueries({ queryKey: qk.atendimentosBaldeBase(slot) });
      client.invalidateQueries({ queryKey: qk.relatoriosBase(slot) });
    },
  });
}
