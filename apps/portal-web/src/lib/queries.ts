'use client';

import {
  type ClientesFilters,
  clientesFiltersSearchParams,
} from '@/components/clientes/cliente-filters';
/**
 * Hooks de dados (TanStack Query) contra o portal-api via proxy same-origin.
 *
 * Multi-tenant: o slot e SEMPRE derivado da sessao no servidor (withTenant). O
 * front nunca envia slot. Mesmo assim, as query keys carregam o slot da sessao
 * (de /auth/me) pra isolar o cache por tenant — se trocar de login, as chaves
 * mudam e nada vaza. Logout faz queryClient.clear() (ver use-logout).
 */
import {
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { isAgendaConfigurada } from './agenda-config';
import { atualizarAgendamento, removerAgendamento } from './agendamentos';
import { ApiError, apiFetch } from './api';
import type {
  AgendaBloqueioInput,
  AgendaBloqueiosResponse,
  AgendaConfig,
  AgendaSlotsResponse,
  AgendamentosResponse,
  AtendimentoBalde,
  AtendimentoByEventoResponse,
  AtendimentosListResponse,
  AuthMe,
  BotDetectPausasResponse,
  BotPauseResponse,
  BotResumeResponse,
  ChargeView,
  ClientePerfil,
  ClientePerfilResponse,
  ClientesAniversariantesModo,
  ClientesAniversariantesResponse,
  ClientesListResponse,
  ClientesResumoResponse,
  ClientesSemRetornoResponse,
  CodigoResponse,
  ColaboradorAgendaResponse,
  ColaboradorComissaoResponse,
  ColaboradorInput,
  ComissaoReport,
  ConexaoResponse,
  ContatosResponse,
  CriarAgendaBloqueioResponse,
  CriarAgendaBloqueioSerieBody,
  CriarAgendaBloqueioSerieResponse,
  CriarAgendamentoBody,
  CriarAgendamentoResponse,
  CriarAtendimentoBody,
  CriarAtendimentoResponse,
  CriarSerieBody,
  CriarSerieResponse,
  EditarAgendamentoBody,
  EditarAgendamentoResponse,
  EditarAtendimentoBody,
  EditarAtendimentoResponse,
  EnviarWhatsappManualBody,
  EnviarWhatsappManualResponse,
  EquipeResponse,
  ExcluirAgendamentoResponse,
  FaturamentoReport,
  FrasePausa,
  FrasesPausaResponse,
  GerarSenhaColaboradorResponse,
  GoogleContaResponse,
  Horarios,
  HorariosResponse,
  LembretesConfig,
  LembretesPatch,
  MensalidadeResponse,
  PausasResponse,
  PerfilNegocio,
  PerfilResponse,
  PreviewAgendaBloqueioRecorrenciaBody,
  PreviewAgendaBloqueioRecorrenciaResponse,
  PreviewRecorrenciaBody,
  PreviewRecorrenciaResponse,
  QrResponse,
  ReconectarResponse,
  RemoverAgendaBloqueioResponse,
  RemoverAgendaBloqueioSerieResponse,
  SaveClienteBody,
  SaveClienteResponse,
  SaveColaboradorResponse,
  SavePerfilResponse,
  Servico,
  ServicosResponse,
  SimularResponse,
  StatusConexaoResponse,
  StatusResponse,
} from './api-types';
import { patchRowNaLista, removerRowDaLista } from './atendimentos-balde';
import { conexaoFromBotActionResponse } from './bot-pausa';
import {
  buildClientesAniversariantesSearchParams,
  buildClientesListSearchParams,
  buildClientesSemRetornoSearchParams,
  clienteAniversarianteFromApi,
  clienteSemRetornoFromApi,
} from './clientes';
import { whatsappManualPath } from './whatsapp-manual';
import {
  type CartaoConfigState,
  type CartaoEmojis,
  type CartaoPreviewLive,
  type SaveCartaoResult,
  fetchCartaoConfig,
  fetchCartaoPreview,
  putCartaoConfig,
} from './cartao-config';
import { mapColaboradorRow } from './equipe';
import { type BuilderDraft, fetchBuilderDraft } from './prompt-builder';
import {
  type TomNivel,
  type TomNivelOpcao,
  type TomState,
  fetchTomAssistente,
  putTomAssistente,
} from './tom-assistente';

// ── Query keys (escopadas por slot da sessao) ────────────────────────────────

export const qk = {
  me: ['me'] as const,
  status: (slot: string) => ['status', slot] as const,
  servicos: (slot: string) => ['servicos', slot] as const,
  perfil: (slot: string) => ['perfil', slot] as const,
  /** Config de Agendamento (modo atendente) — derivada do GET /portal/perfil. */
  agendaConfig: (slot: string) => ['agenda-config', slot] as const,
  /** Gates de "Meu atendente" (prompt_builder/sandbox, SCRUM-157) — derivados do GET /portal/perfil. */
  atendenteFeatures: (slot: string) => ['atendente-features', slot] as const,
  horarios: (slot: string) => ['horarios', slot] as const,
  pausas: (slot: string) => ['pausas', slot] as const,
  botDetectPausas: (slot: string) => ['bot-detect-pausas', slot] as const,
  lembretes: (slot: string) => ['lembretes', slot] as const,
  googleConta: (slot: string) => ['google-conta', slot] as const,
  contatos: (slot: string) => ['contatos', slot] as const,
  agendamentos: (slot: string) => ['agendamentos', slot] as const,
  agendaBloqueiosBase: (slot: string) => ['agenda-bloqueios', slot] as const,
  agendaBloqueios: (slot: string, colaboradorId: number | null) =>
    ['agenda-bloqueios', slot, colaboradorId ?? 'todos'] as const,
  /** Prefixo por tenant — usar pra invalidar TODAS as grades de slots de uma vez. */
  agendaSlotsBase: (slot: string) => ['agenda-slots', slot] as const,
  // `colaborador` no fim distingue a grade por profissional (estabelecimento); '' = individual.
  agendaSlots: (slot: string, data: string, servico: string, colaborador: number | null) =>
    ['agenda-slots', slot, data, servico, colaborador ?? ''] as const,
  mensalidade: (slot: string) => ['mensalidade', slot] as const,
  conexao: (slot: string) => ['conexao', slot] as const,
  equipe: (slot: string) => ['equipe', slot] as const,
  /** Prefixo por tenant — invalida todos os relatórios (qualquer período) de uma vez. */
  relatoriosBase: (slot: string) => ['relatorios', slot] as const,
  faturamento: (slot: string, de: string, ate: string) =>
    ['relatorios', slot, 'faturamento', de, ate] as const,
  comissao: (slot: string, balde: AtendimentoBalde, de: string, ate: string) =>
    ['relatorios', slot, 'comissao', balde, de, ate] as const,
  /** Prefixo por tenant — invalida TODAS as listas de baldes (ambos, qualquer período). */
  atendimentosBaldeBase: (slot: string) => ['atendimentos-balde', slot] as const,
  atendimentosBalde: (slot: string, balde: AtendimentoBalde, de: string, ate: string) =>
    ['atendimentos-balde', slot, balde, de, ate] as const,
  /** Linha de atendimento resolvida pelo event_id da agenda (edição de dinheiro no card). */
  atendimentoByEvento: (slot: string, eventId: string) =>
    ['atendimento-by-evento', slot, eventId] as const,
  // Colaborador (SCRUM-32): chaves escopadas por (slot + colaboradorId) DA SESSÃO
  // pra isolar o cache do barbeiro — nunca colide com o do dono nem de outro colab.
  colaboradorAgenda: (slot: string, colaboradorId: number, past: number, ahead: number) =>
    ['colaborador-agenda', slot, colaboradorId, past, ahead] as const,
  colaboradorBloqueiosBase: (slot: string, colaboradorId: number) =>
    ['colaborador-bloqueios', slot, colaboradorId] as const,
  colaboradorBloqueios: (slot: string, colaboradorId: number) =>
    ['colaborador-bloqueios', slot, colaboradorId] as const,
  colaboradorComissao: (slot: string, colaboradorId: number, de: string, ate: string) =>
    ['colaborador-comissao', slot, colaboradorId, de, ate] as const,
  /** Frases de comando (modo atendente) — GET/PUT /portal/frases-pausa. */
  frasesPausa: (slot: string) => ['frases-pausa', slot] as const,
  /** Builder de persona (SCRUM-92) — prévia do rascunho (GET /portal/prompt-builder/draft). */
  promptBuilder: (slot: string) => ['prompt-builder', slot] as const,
  /** Tom da conversa do assistente (SCRUM-92) — nível + catálogo (GET /portal/tom-assistente). */
  tomAssistente: (slot: string) => ['tom-assistente', slot] as const,
  /** Cartão de confirmação (SCRUM-92 inc.2) — GET/PUT /portal/cartao-config. */
  cartaoConfig: (slot: string) => ['cartao-config', slot] as const,
  /** Prévia FIEL ao vivo do cartão (SCRUM-99) — GET /portal/cartao-config/preview, por emojis. */
  cartaoPreview: (slot: string, emojis: CartaoEmojis) => ['cartao-preview', slot, emojis] as const,
  clientesBase: (slot: string) => ['clientes', slot] as const,
  clientesResumo: (slot: string) => ['clientes-resumo', slot] as const,
  clientes: (slot: string, page: number, pageSize: number, search: string) =>
    ['clientes', slot, page, pageSize, search] as const,
  clientesAniversariantesBase: (slot: string) => ['clientes-aniversariantes', slot] as const,
  clientesAniversariantes: (
    slot: string,
    mode: ClientesAniversariantesModo,
    monthOrDays: number,
    page: number,
    pageSize: number,
  ) => ['clientes-aniversariantes', slot, mode, monthOrDays, page, pageSize] as const,
  clientesSemRetornoBase: (slot: string) => ['clientes-sem-retorno', slot] as const,
  clientesSemRetorno: (slot: string, page: number, pageSize: number) =>
    ['clientes-sem-retorno', slot, page, pageSize] as const,
  clientePerfil: (slot: string, id: string) => ['cliente-perfil', slot, id] as const,
  colaboradorClientesBase: (slot: string, colaboradorId: number) =>
    ['colaborador-clientes', slot, colaboradorId] as const,
  colaboradorClientesResumo: (slot: string, colaboradorId: number) =>
    ['colaborador-clientes-resumo', slot, colaboradorId] as const,
  colaboradorClientes: (
    slot: string,
    colaboradorId: number,
    page: number,
    pageSize: number,
    search: string,
  ) => ['colaborador-clientes', slot, colaboradorId, page, pageSize, search] as const,
  colaboradorClientesAniversariantesBase: (slot: string, colaboradorId: number) =>
    ['colaborador-clientes-aniversariantes', slot, colaboradorId] as const,
  colaboradorClientesAniversariantes: (
    slot: string,
    colaboradorId: number,
    mode: ClientesAniversariantesModo,
    monthOrDays: number,
    page: number,
    pageSize: number,
  ) =>
    [
      'colaborador-clientes-aniversariantes',
      slot,
      colaboradorId,
      mode,
      monthOrDays,
      page,
      pageSize,
    ] as const,
  colaboradorClientesSemRetornoBase: (slot: string, colaboradorId: number) =>
    ['colaborador-clientes-sem-retorno', slot, colaboradorId] as const,
  colaboradorClientesSemRetorno: (
    slot: string,
    colaboradorId: number,
    page: number,
    pageSize: number,
  ) => ['colaborador-clientes-sem-retorno', slot, colaboradorId, page, pageSize] as const,
  colaboradorClientePerfil: (slot: string, colaboradorId: number, id: string) =>
    ['colaborador-cliente-perfil', slot, colaboradorId, id] as const,
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

export interface AgendaBloqueiosQueryData extends AgendaBloqueiosResponse {
  available: boolean;
}

export interface ClientesListQueryData extends ClientesListResponse {
  available: boolean;
}

export interface ClientesResumoQueryData extends ClientesResumoResponse {
  available: boolean;
}

export interface ClientesSemRetornoQueryData {
  available: boolean;
  clientes: ReturnType<typeof clienteSemRetornoFromApi>[];
  total: number;
  limit: number;
  offset: number;
}

export interface ClientesAniversariantesQueryData {
  available: boolean;
  clientes: Array<
    ReturnType<typeof clienteAniversarianteFromApi> & { ocorrencia_local_date?: string | null }
  >;
  total: number;
  limit: number;
  offset: number;
}

export interface ClientePerfilQueryData {
  available: boolean;
  cliente: ClientePerfil | null;
  historico: ClientePerfilResponse['historico'];
}

function isFeatureOff(error: unknown): boolean {
  return (
    error instanceof Error &&
    'status' in error &&
    (error as { status?: unknown }).status === 404 &&
    'body' in error &&
    typeof (error as { body?: unknown }).body === 'object' &&
    (error as { body?: { error?: unknown } }).body?.error === 'feature_off'
  );
}

function invalidateAgendaBloqueioCaches(client: QueryClient, slot: string) {
  client.invalidateQueries({ queryKey: qk.agendaBloqueiosBase(slot) });
  client.invalidateQueries({ queryKey: qk.agendamentos(slot) });
  client.invalidateQueries({ queryKey: ['colaborador-agenda', slot] });
  client.invalidateQueries({ queryKey: ['colaborador-bloqueios', slot] });
}

function isAgendaBloqueioSerie409(error: unknown): error is ApiError {
  return error instanceof ApiError && error.status === 409;
}

function agendaBloqueioSerieFrom409(error: unknown): CriarAgendaBloqueioSerieResponse | null {
  if (!isAgendaBloqueioSerie409(error) || !error.body || typeof error.body !== 'object')
    return null;
  if (!('serie_id' in error.body) || !('criados' in error.body) || !('falhas' in error.body)) {
    return null;
  }
  return error.body as CriarAgendaBloqueioSerieResponse;
}

export function useAgendaBloqueios(
  slot: string,
  colaboradorId: number | null,
  enabled = true,
): UseQueryResult<AgendaBloqueiosQueryData> {
  return useQuery({
    queryKey: qk.agendaBloqueios(slot, colaboradorId),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams();
      if (colaboradorId != null) params.set('colaborador_id', String(colaboradorId));
      try {
        const data = await apiFetch<AgendaBloqueiosResponse>(
          `/portal/agenda/bloqueios${params.size ? `?${params.toString()}` : ''}`,
          { signal },
        );
        return { ...data, available: true };
      } catch (error) {
        if (isFeatureOff(error)) return { available: false, count: 0, bloqueios: [] };
        throw error;
      }
    },
    enabled,
    retry: false,
  });
}

export function useCriarAgendaBloqueio(
  slot: string,
): UseMutationResult<CriarAgendaBloqueioResponse, Error, AgendaBloqueioInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      apiFetch<CriarAgendaBloqueioResponse>('/portal/agenda/bloqueios', { method: 'POST', body }),
    onSuccess: () => invalidateAgendaBloqueioCaches(client, slot),
  });
}

export function useRemoverAgendaBloqueio(
  slot: string,
): UseMutationResult<RemoverAgendaBloqueioResponse, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id) =>
      apiFetch<RemoverAgendaBloqueioResponse>(
        `/portal/agenda/bloqueios/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
        },
      ),
    onSuccess: () => invalidateAgendaBloqueioCaches(client, slot),
  });
}

export function usePreviewAgendaBloqueioRecorrencia(): UseMutationResult<
  PreviewAgendaBloqueioRecorrenciaResponse,
  Error,
  PreviewAgendaBloqueioRecorrenciaBody
> {
  return useMutation({
    mutationFn: (body) =>
      apiFetch<PreviewAgendaBloqueioRecorrenciaResponse>(
        '/portal/agenda/bloqueios/recorrencia/preview',
        {
          method: 'POST',
          body,
        },
      ),
  });
}

export function useCriarAgendaBloqueioSerie(
  slot: string,
): UseMutationResult<CriarAgendaBloqueioSerieResponse, Error, CriarAgendaBloqueioSerieBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      try {
        return await apiFetch<CriarAgendaBloqueioSerieResponse>('/portal/agenda/bloqueios/serie', {
          method: 'POST',
          body,
        });
      } catch (error) {
        const fallback = agendaBloqueioSerieFrom409(error);
        if (fallback) return fallback;
        throw error;
      }
    },
    onSuccess: () => invalidateAgendaBloqueioCaches(client, slot),
  });
}

export function useRemoverAgendaBloqueioSerie(
  slot: string,
): UseMutationResult<RemoverAgendaBloqueioSerieResponse, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (serieId) =>
      apiFetch<RemoverAgendaBloqueioSerieResponse>(
        `/portal/agenda/bloqueios/serie/${encodeURIComponent(serieId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => invalidateAgendaBloqueioCaches(client, slot),
  });
}

// ── Colaborador (painel READ-ONLY — SCRUM-32) ────────────────────────────────
//
// O backend escopa TUDO por (slot + tenant + colaboradorId) DA SESSÃO; o front
// não envia identidade. slot/colaboradorId aqui entram só na query KEY (isolamento
// de cache por barbeiro). Logout faz queryClient.clear() (use-logout) — nada vaza.
//
// ATENÇÃO: os FETCHES vão pra /portal/colaborador/* (namespace PROXIADO pelo portal-web —
// só /auth, /portal e /demo chegam ao portal-api). NÃO usar /colaborador/* aqui: colide
// com as PÁGINAS Next (/colaborador/agenda|comissao) e o fetch cai no HTML da página em vez
// do portal-api -> agenda/comissão vazias. As ROTAS de navegação (hrefs) seguem /colaborador/*.

/**
 * Agenda do colaborador logado (read-only). Espelha useAgendamentos. A janela
 * [past, ahead] (dias relativos a hoje) vem do filtro de data da tela — derivada da
 * janela [de, ate] escolhida no picker (lib/colaborador-agenda-periodo). Com
 * `keepPreviousData`, trocar o período NÃO pisca o skeleton: a lista anterior fica
 * na tela enquanto a nova janela carrega (o filtro segue visível).
 */
export function useColaboradorAgenda(
  slot: string,
  colaboradorId: number,
  past: number,
  ahead: number,
): UseQueryResult<ColaboradorAgendaResponse> {
  return useQuery({
    queryKey: qk.colaboradorAgenda(slot, colaboradorId, past, ahead),
    queryFn: ({ signal }) =>
      apiFetch<ColaboradorAgendaResponse>(
        `/portal/colaborador/agenda?past=${past}&ahead=${ahead}`,
        { signal },
      ),
    placeholderData: keepPreviousData,
  });
}

export function useColaboradorClientes(
  slot: string,
  colaboradorId: number,
  page: number,
  pageSize: number,
  searchOrFilters: string | ClientesFilters,
  enabled = true,
): UseQueryResult<ClientesListQueryData> {
  const qs =
    typeof searchOrFilters === 'string'
      ? buildClientesListSearchParams({ page, pageSize, search: searchOrFilters })
      : clientesFiltersSearchParams(searchOrFilters, pageSize, (page - 1) * pageSize);
  return useQuery({
    queryKey: qk.colaboradorClientes(slot, colaboradorId, page, pageSize, qs),
    queryFn: async ({ signal }) => {
      try {
        const data = await apiFetch<ClientesListResponse>(`/portal/colaborador/clientes?${qs}`, {
          signal,
        });
        return { ...data, available: true };
      } catch (error) {
        if (isFeatureOff(error)) {
          return { available: false, clientes: [], total: 0, limit: pageSize, offset: 0 };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useColaboradorClientesResumo(
  slot: string,
  colaboradorId: number,
  enabled = true,
): UseQueryResult<ClientesResumoQueryData> {
  return useQuery({
    queryKey: qk.colaboradorClientesResumo(slot, colaboradorId),
    queryFn: async ({ signal }) => {
      try {
        const data = await apiFetch<ClientesResumoResponse>('/portal/colaborador/clientes/resumo', {
          signal,
        });
        return { ...data, available: true };
      } catch (error) {
        if (isFeatureOff(error)) {
          return { available: false, total_clientes: 0, aniversariantes_hoje: 0, sem_retorno: 0 };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
  });
}

export function useColaboradorClientesAniversariantesCalendario(
  slot: string,
  colaboradorId: number,
  visao: 'semana' | 'mes',
  ancora: string,
  enabled = true,
): UseQueryResult<ClientesAniversariantesQueryData> {
  return useQuery({
    queryKey: [
      'colaborador-clientes-aniversariantes-calendario',
      slot,
      colaboradorId,
      visao,
      ancora,
    ],
    queryFn: async ({ signal }) => {
      try {
        const qs = new URLSearchParams({ modo: 'calendario', visao, ancora });
        const data = await apiFetch<ClientesAniversariantesResponse>(
          `/portal/colaborador/clientes/aniversariantes?${qs}`,
          { signal },
        );
        return {
          available: true,
          clientes: data.clientes.map((item) => ({
            ...clienteAniversarianteFromApi(item),
            ocorrencia_local_date: item.ocorrencia_local_date ?? null,
          })),
          total: data.total,
          limit: data.limit,
          offset: data.offset,
        };
      } catch (error) {
        if (isFeatureOff(error))
          return { available: false, clientes: [], total: 0, limit: 0, offset: 0 };
        throw error;
      }
    },
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useColaboradorClientesAniversariantes(
  slot: string,
  colaboradorId: number,
  mode: ClientesAniversariantesModo,
  monthOrDays: number,
  page: number,
  pageSize: number,
  enabled = true,
): UseQueryResult<ClientesAniversariantesQueryData> {
  return useQuery({
    queryKey: qk.colaboradorClientesAniversariantes(
      slot,
      colaboradorId,
      mode,
      monthOrDays,
      page,
      pageSize,
    ),
    queryFn: async ({ signal }) => {
      const qs = buildClientesAniversariantesSearchParams({
        page,
        pageSize,
        modo: mode,
        dias: monthOrDays,
        mes: monthOrDays,
      });
      try {
        const data = await apiFetch<ClientesAniversariantesResponse>(
          `/portal/colaborador/clientes/aniversariantes?${qs}`,
          { signal },
        );
        return {
          available: true,
          clientes: data.clientes.map((item) => ({
            ...clienteAniversarianteFromApi(item),
            ocorrencia_local_date: item.ocorrencia_local_date ?? null,
          })),
          total: data.total,
          limit: data.limit,
          offset: data.offset,
        };
      } catch (error) {
        if (isFeatureOff(error)) {
          return { available: false, clientes: [], total: 0, limit: pageSize, offset: 0 };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useColaboradorClientesSemRetorno(
  slot: string,
  colaboradorId: number,
  page: number,
  pageSize: number,
  enabled = true,
): UseQueryResult<ClientesSemRetornoQueryData> {
  return useQuery({
    queryKey: qk.colaboradorClientesSemRetorno(slot, colaboradorId, page, pageSize),
    queryFn: async ({ signal }) => {
      const qs = buildClientesSemRetornoSearchParams({ page, pageSize });
      try {
        const data = await apiFetch<ClientesSemRetornoResponse>(
          `/portal/colaborador/clientes/sem-retorno?${qs}`,
          { signal },
        );
        return {
          available: true,
          clientes: data.clientes.map(clienteSemRetornoFromApi),
          total: data.total,
          limit: data.limit,
          offset: data.offset,
        };
      } catch (error) {
        if (isFeatureOff(error)) {
          return { available: false, clientes: [], total: 0, limit: pageSize, offset: 0 };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useColaboradorClientePerfil(
  slot: string,
  colaboradorId: number,
  id: string | null,
  enabled = true,
): UseQueryResult<ClientePerfilQueryData> {
  return useQuery({
    queryKey: qk.colaboradorClientePerfil(slot, colaboradorId, id ?? ''),
    queryFn: async ({ signal }) => {
      if (id == null) return { available: true, cliente: null, historico: [] };
      try {
        const data = await apiFetch<ClientePerfilResponse>(`/portal/colaborador/clientes/${id}`, {
          signal,
        });
        return { available: true, cliente: data.cliente, historico: data.historico };
      } catch (error) {
        if (isFeatureOff(error)) return { available: false, cliente: null, historico: [] };
        throw error;
      }
    },
    enabled: enabled && id != null,
    retry: false,
  });
}

export function useColaboradorBloqueios(
  slot: string,
  colaboradorId: number,
  enabled = true,
): UseQueryResult<AgendaBloqueiosQueryData> {
  return useQuery({
    queryKey: qk.colaboradorBloqueios(slot, colaboradorId),
    queryFn: async ({ signal }) => {
      try {
        const data = await apiFetch<AgendaBloqueiosResponse>('/portal/colaborador/bloqueios', {
          signal,
        });
        return { ...data, available: true };
      } catch (error) {
        if (isFeatureOff(error)) return { available: false, count: 0, bloqueios: [] };
        throw error;
      }
    },
    enabled,
    retry: false,
  });
}

export function useCriarColaboradorBloqueio(
  slot: string,
  colaboradorId: number,
): UseMutationResult<CriarAgendaBloqueioResponse, Error, AgendaBloqueioInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      apiFetch<CriarAgendaBloqueioResponse>('/portal/colaborador/bloqueios', {
        method: 'POST',
        body,
      }),
    onSuccess: () => invalidateAgendaBloqueioCaches(client, slot),
  });
}

export function useRemoverColaboradorBloqueio(
  slot: string,
  colaboradorId: number,
): UseMutationResult<RemoverAgendaBloqueioResponse, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id) =>
      apiFetch<RemoverAgendaBloqueioResponse>(
        `/portal/colaborador/bloqueios/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => invalidateAgendaBloqueioCaches(client, slot),
  });
}

export function usePreviewColaboradorBloqueioRecorrencia(): UseMutationResult<
  PreviewAgendaBloqueioRecorrenciaResponse,
  Error,
  PreviewAgendaBloqueioRecorrenciaBody
> {
  return useMutation({
    mutationFn: (body) =>
      apiFetch<PreviewAgendaBloqueioRecorrenciaResponse>(
        '/portal/colaborador/bloqueios/recorrencia/preview',
        {
          method: 'POST',
          body,
        },
      ),
  });
}

export function useCriarColaboradorBloqueioSerie(
  slot: string,
  colaboradorId: number,
): UseMutationResult<CriarAgendaBloqueioSerieResponse, Error, CriarAgendaBloqueioSerieBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (body) => {
      try {
        return await apiFetch<CriarAgendaBloqueioSerieResponse>(
          '/portal/colaborador/bloqueios/serie',
          {
            method: 'POST',
            body,
          },
        );
      } catch (error) {
        const fallback = agendaBloqueioSerieFrom409(error);
        if (fallback) return fallback;
        throw error;
      }
    },
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.colaboradorBloqueiosBase(slot, colaboradorId) });
      invalidateAgendaBloqueioCaches(client, slot);
    },
  });
}

export function useRemoverColaboradorBloqueioSerie(
  slot: string,
  colaboradorId: number,
): UseMutationResult<RemoverAgendaBloqueioSerieResponse, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (serieId) =>
      apiFetch<RemoverAgendaBloqueioSerieResponse>(
        `/portal/colaborador/bloqueios/serie/${encodeURIComponent(serieId)}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.colaboradorBloqueiosBase(slot, colaboradorId) });
      invalidateAgendaBloqueioCaches(client, slot);
    },
  });
}

/** Faturamento + comissão do colaborador no período [de, ate] (read-only). */
export function useColaboradorComissao(
  slot: string,
  colaboradorId: number,
  de: string,
  ate: string,
): UseQueryResult<ColaboradorComissaoResponse> {
  return useQuery({
    queryKey: qk.colaboradorComissao(slot, colaboradorId, de, ate),
    queryFn: ({ signal }) =>
      apiFetch<ColaboradorComissaoResponse>(
        `/portal/colaborador/comissao?de=${encodeURIComponent(de)}&ate=${encodeURIComponent(ate)}`,
        { signal },
      ),
    enabled: Boolean(de && ate),
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
  // ESTABELECIMENTO (multi-profissional): a grade consulta a agenda DESTE colaborador.
  // null no INDIVIDUAL (single-agenda) — não vai na query. No estabelecimento o backend
  // exige (422 'colaborador_obrigatorio'), então só habilitamos a query com ele escolhido.
  colaboradorId: number | null = null,
): UseQueryResult<AgendaSlotsResponse> {
  return useQuery({
    queryKey: qk.agendaSlots(slot, data ?? '', servico ?? '', colaboradorId),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ data: data ?? '', servico: servico ?? '' });
      if (colaboradorId != null) params.set('colaborador_id', String(colaboradorId));
      return apiFetch<AgendaSlotsResponse>(`/portal/agenda/slots?${params.toString()}`, { signal });
    },
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
      // Billing-da-agenda (ADR 0027): um agendamento novo materializa uma linha de
      // atendimento (Previsão) → Previsão/comissão ficam stale sem isto.
      client.invalidateQueries({ queryKey: qk.atendimentosBaldeBase(slot) });
      client.invalidateQueries({ queryKey: qk.relatoriosBase(slot) });
    },
  });
}

/**
 * POST /portal/agendamentos/recorrencia/preview — SÓ LÊ, nunca grava (decisão do
 * Bruno: conflitos aparecem ANTES de gravar). Sem cache (mutation, não query): cada
 * chamada precisa refletir o estado vivo da agenda no instante da revisão.
 */
export function usePreviewRecorrencia(): UseMutationResult<
  PreviewRecorrenciaResponse,
  Error,
  PreviewRecorrenciaBody
> {
  return useMutation({
    mutationFn: (body) =>
      apiFetch<PreviewRecorrenciaResponse>('/portal/agendamentos/recorrencia/preview', {
        method: 'POST',
        body,
      }),
  });
}

/**
 * POST /portal/agendamentos/serie — grava a lista EXPLÍCITA de datas que o dono
 * confirmou na tela de revisão (o servidor não recalcula periodicidade). 201/207/409
 * são tratados NA TELA (207 é sucesso PARCIAL, não erro — a mutation resolve normal
 * nos três casos, quem decide o que mostrar é quem chama). Invalida os mesmos caches
 * do agendamento único: N eventos entraram de uma vez, prepend otimista não vale a
 * pena — deixa a lista ressincronizar.
 */
export function useCriarSerie(
  slot: string,
): UseMutationResult<CriarSerieResponse, Error, CriarSerieBody> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) =>
      apiFetch<CriarSerieResponse>('/portal/agendamentos/serie', { method: 'POST', body }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.agendamentos(slot) });
      client.invalidateQueries({ queryKey: qk.agendaSlotsBase(slot) });
      client.invalidateQueries({ queryKey: qk.atendimentosBaldeBase(slot) });
      client.invalidateQueries({ queryKey: qk.relatoriosBase(slot) });
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
      // Billing-da-agenda (ADR 0027): excluir o evento some/zera a linha derivada →
      // Previsão/Faturado/comissão precisam ressincronizar.
      client.invalidateQueries({ queryKey: qk.atendimentosBaldeBase(slot) });
      client.invalidateQueries({ queryKey: qk.relatoriosBase(slot) });
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
      // Billing-da-agenda (ADR 0027): remarcar/trocar serviço muda dia/valor da linha
      // derivada → Previsão e comissão ficam stale sem invalidar aqui (item 2).
      client.invalidateQueries({ queryKey: qk.atendimentosBaldeBase(slot) });
      client.invalidateQueries({ queryKey: qk.relatoriosBase(slot) });
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

/**
 * PUT /portal/perfil. Body = { perfil, timezone } — o `timezone` (IANA) é campo
 * TOP-LEVEL, irmão de `perfil` (o backend valida com isValidIanaTimezone e grava na
 * coluna flow_clones.timezone; NÃO entra no perfilSchema/personalizacao). A resposta
 * devolve `r.perfil` (sem tz) e é isso que fica no cache qk.perfil — o tz vive no
 * /portal/status (useTenantTz).
 */
export function useSavePerfil(
  slot: string,
): UseMutationResult<PerfilNegocio, Error, { perfil: PerfilNegocio; timezone: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ perfil, timezone }) =>
      apiFetch<SavePerfilResponse>('/portal/perfil', {
        method: 'PUT',
        body: { perfil, timezone },
      }).then((r) => r.perfil),
    onSuccess: (perfil) => {
      client.setQueryData(qk.perfil(slot), perfil);
    },
  });
}

// ── Agendamento / modo atendente (SCRUM-59) ──────────────────────────────────
//
// Deriva do MESMO GET/PUT /portal/perfil, mas numa query própria (qk.agendaConfig)
// pra NÃO tocar no cache/otimista do formulário principal do perfil (regressão zero
// pros clientes atuais). Uma leitura extra do endpoint (tiny, cacheado) é o preço da
// isolação. A seção só renderiza quando `modo_atendente` é true (calculado por-clone
// no backend via MODO_ATENDENTE_SLOTS — NÃO é flag global).

export function useAgendaConfig(slot: string): UseQueryResult<AgendaConfig> {
  return useQuery({
    queryKey: qk.agendaConfig(slot),
    queryFn: ({ signal }) =>
      apiFetch<PerfilResponse>('/portal/perfil', { signal }).then((r) => ({
        modo_atendente: r.features?.modo_atendente === true,
        agenda_automatica: r.perfil?.agenda_automatica ?? true,
        link_agendamento:
          typeof r.perfil?.link_agendamento === 'string' ? r.perfil.link_agendamento : '',
        recepcao_telefone: typeof r.recepcao_telefone === 'string' ? r.recepcao_telefone : '',
        // SCRUM-74: default TRUE quando o backend ainda não expõe o campo (retrocompat).
        agenda_configurada: isAgendaConfigurada(r.features?.agenda_configurada),
      })),
  });
}

/**
 * PUT parcial /portal/perfil com os campos da seção Agendamento: `{ perfil:
 * { agenda_automatica, link_agendamento }, recepcao_telefone? }`. O `perfil` é merge
 * parcial (chave ausente = não toca); `recepcao_telefone` é TOP-LEVEL (E.164 BR) e só
 * viaja quando o chamador o inclui — chave AUSENTE não toca; string "" LIMPA o telefone
 * (SCRUM-62; requer o backend que aceita ""). Erros: 400 telefone_invalido,
 * 404 recepcao_telefone_indisponivel.
 */
export function useSaveAgendaConfig(
  slot: string,
): UseMutationResult<
  SavePerfilResponse,
  Error,
  { agenda_automatica: boolean; link_agendamento: string; recepcao_telefone?: string }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ agenda_automatica, link_agendamento, recepcao_telefone }) =>
      apiFetch<SavePerfilResponse>('/portal/perfil', {
        method: 'PUT',
        body: {
          perfil: { agenda_automatica, link_agendamento },
          ...(recepcao_telefone !== undefined ? { recepcao_telefone } : {}),
        },
      }),
    onSuccess: (res) => {
      client.setQueryData(qk.agendaConfig(slot), (prev: AgendaConfig | undefined) => ({
        modo_atendente: prev?.modo_atendente ?? true,
        agenda_automatica: res.perfil.agenda_automatica ?? true,
        link_agendamento:
          typeof res.perfil.link_agendamento === 'string' ? res.perfil.link_agendamento : '',
        recepcao_telefone:
          typeof res.recepcao_telefone === 'string'
            ? res.recepcao_telefone
            : (prev?.recepcao_telefone ?? ''),
        // SCRUM-74: salvar link/telefone não muda o estado da agenda — preserva (default TRUE).
        agenda_configurada: prev?.agenda_configurada ?? true,
      }));
    },
  });
}

/**
 * Onda 1 (SCRUM-68) — DE-GATE do "WhatsApp da recepção" (destino do alerta ao dono,
 * `alert_owner_phone`) numa SEÇÃO PRÓPRIA, editável por TODOS os formatos (o toggle de
 * agenda automática NÃO é tocado — segue na AgendamentoSection, modo atendente).
 *
 * PUT /portal/perfil enviando SÓ o TOP-LEVEL `recepcao_telefone` (sem a chave `perfil`)
 * pra não escrever `agenda_automatica`/`link_agendamento` num clone que não tem modo
 * atendente (aquele campo segue gated no backend). '' LIMPA (SCRUM-62; fallback = número
 * da própria sessão). Só toca `recepcao_telefone` no cache de qk.agendaConfig; os demais
 * campos (que a AgendamentoSection lê) ficam intactos.
 */
export function useSaveRecepcao(
  slot: string,
): UseMutationResult<SavePerfilResponse, Error, { recepcao_telefone: string }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ recepcao_telefone }) =>
      apiFetch<SavePerfilResponse>('/portal/perfil', {
        method: 'PUT',
        body: { recepcao_telefone },
      }),
    onSuccess: (res) => {
      client.setQueryData(qk.agendaConfig(slot), (prev: AgendaConfig | undefined) =>
        prev
          ? {
              ...prev,
              recepcao_telefone:
                typeof res.recepcao_telefone === 'string'
                  ? res.recepcao_telefone
                  : prev.recepcao_telefone,
            }
          : prev,
      );
    },
  });
}

// ── Gate das abas de "Meu atendente" (SCRUM-157) ─────────────────────────────
//
// Deriva do MESMO GET /portal/perfil, numa query própria (qk.atendenteFeatures) pra
// NÃO tocar no cache/otimista do formulário principal do perfil — mesma isolação de
// agendaConfig. Expõe os 2 gates GLOBAIS (prompt_builder, sandbox, #541)
// usados pelo layout de `/atendente/*` pra montar o NavGateContext ANTES de navegar
// (o gate real de cada seção, por 404, continua no componente).
//
// `faq_personalizado` NÃO faz mais parte deste contrato (refactor pós-plano do
// Bruno: conteúdo de FAQ passa a viver no prompt via IA, formulário próprio saiu).
// O gate de "Mensagens" (`atendenteMensagens`) agora depende só de cartão
// disponível — ver `atendente/layout.tsx`.

export interface AtendenteFeatures {
  prompt_builder: boolean;
  sandbox: boolean;
}

export function useAtendenteFeatures(slot: string): UseQueryResult<AtendenteFeatures> {
  return useQuery({
    queryKey: qk.atendenteFeatures(slot),
    queryFn: ({ signal }) =>
      apiFetch<PerfilResponse>('/portal/perfil', { signal }).then((r) => ({
        prompt_builder: r.features?.prompt_builder === true,
        sandbox: r.features?.sandbox === true,
      })),
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

// ── CRM Clientes (Missão 034) ────────────────────────────────────────────────

export function useClientes(
  slot: string,
  page: number,
  pageSize: number,
  searchOrFilters: string | ClientesFilters,
  enabled = true,
): UseQueryResult<ClientesListQueryData> {
  const qs =
    typeof searchOrFilters === 'string'
      ? buildClientesListSearchParams({ page, pageSize, search: searchOrFilters })
      : clientesFiltersSearchParams(searchOrFilters, pageSize, (page - 1) * pageSize);
  return useQuery({
    queryKey: qk.clientes(slot, page, pageSize, qs),
    queryFn: async ({ signal }) => {
      try {
        const data = await apiFetch<ClientesListResponse>(`/portal/clientes?${qs}`, { signal });
        return { ...data, available: true };
      } catch (error) {
        if (isFeatureOff(error)) {
          return { available: false, clientes: [], total: 0, limit: pageSize, offset: 0 };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useClientesResumo(
  slot: string,
  enabled = true,
): UseQueryResult<ClientesResumoQueryData> {
  return useQuery({
    queryKey: qk.clientesResumo(slot),
    queryFn: async ({ signal }) => {
      try {
        const data = await apiFetch<ClientesResumoResponse>('/portal/clientes/resumo', { signal });
        return { ...data, available: true };
      } catch (error) {
        if (isFeatureOff(error)) {
          return { available: false, total_clientes: 0, aniversariantes_hoje: 0, sem_retorno: 0 };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
  });
}

/** Calendário é deliberadamente uma query separada da lista compacta do card. */
export function useClientesAniversariantesCalendario(
  slot: string,
  visao: 'semana' | 'mes',
  ancora: string,
  enabled = true,
): UseQueryResult<ClientesAniversariantesQueryData> {
  return useQuery({
    queryKey: ['clientes-aniversariantes-calendario', slot, visao, ancora],
    queryFn: async ({ signal }) => {
      try {
        const qs = new URLSearchParams({ modo: 'calendario', visao, ancora });
        const data = await apiFetch<ClientesAniversariantesResponse>(
          `/portal/clientes/aniversariantes?${qs}`,
          { signal },
        );
        return {
          available: true,
          clientes: data.clientes.map((item) => ({
            ...clienteAniversarianteFromApi(item),
            ocorrencia_local_date: item.ocorrencia_local_date ?? null,
          })),
          total: data.total,
          limit: data.limit,
          offset: data.offset,
        };
      } catch (error) {
        if (isFeatureOff(error))
          return { available: false, clientes: [], total: 0, limit: 0, offset: 0 };
        throw error;
      }
    },
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useClientesAniversariantes(
  slot: string,
  mode: ClientesAniversariantesModo,
  monthOrDays: number,
  page: number,
  pageSize: number,
  enabled = true,
): UseQueryResult<ClientesAniversariantesQueryData> {
  return useQuery({
    queryKey: qk.clientesAniversariantes(slot, mode, monthOrDays, page, pageSize),
    queryFn: async ({ signal }) => {
      const qs = buildClientesAniversariantesSearchParams({
        page,
        pageSize,
        modo: mode,
        dias: monthOrDays,
        mes: monthOrDays,
      });
      try {
        const data = await apiFetch<ClientesAniversariantesResponse>(
          `/portal/clientes/aniversariantes?${qs}`,
          { signal },
        );
        return {
          available: true,
          clientes: data.clientes.map(clienteAniversarianteFromApi),
          total: data.total,
          limit: data.limit,
          offset: data.offset,
        };
      } catch (error) {
        if (isFeatureOff(error)) {
          return { available: false, clientes: [], total: 0, limit: pageSize, offset: 0 };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useClientesSemRetorno(
  slot: string,
  page: number,
  pageSize: number,
  enabled = true,
): UseQueryResult<ClientesSemRetornoQueryData> {
  return useQuery({
    queryKey: qk.clientesSemRetorno(slot, page, pageSize),
    queryFn: async ({ signal }) => {
      const qs = buildClientesSemRetornoSearchParams({ page, pageSize });
      try {
        const data = await apiFetch<ClientesSemRetornoResponse>(
          `/portal/clientes/sem-retorno?${qs}`,
          { signal },
        );
        return {
          available: true,
          clientes: data.clientes.map(clienteSemRetornoFromApi),
          total: data.total,
          limit: data.limit,
          offset: data.offset,
        };
      } catch (error) {
        if (isFeatureOff(error)) {
          return { available: false, clientes: [], total: 0, limit: pageSize, offset: 0 };
        }
        throw error;
      }
    },
    enabled,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useClientePerfil(
  slot: string,
  id: string | null,
  enabled = true,
): UseQueryResult<ClientePerfilQueryData> {
  return useQuery({
    queryKey: qk.clientePerfil(slot, id ?? ''),
    queryFn: async ({ signal }) => {
      if (id == null) return { available: true, cliente: null, historico: [] };
      try {
        const data = await apiFetch<ClientePerfilResponse>(`/portal/clientes/${id}`, { signal });
        return { available: true, cliente: data.cliente, historico: data.historico };
      } catch (error) {
        if (isFeatureOff(error)) return { available: false, cliente: null, historico: [] };
        throw error;
      }
    },
    enabled: enabled && id != null,
    retry: false,
  });
}

export function useSaveCliente(
  slot: string,
): UseMutationResult<ClientePerfil, Error, { id: string; body: SaveClienteBody }> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }) =>
      apiFetch<SaveClienteResponse>(`/portal/clientes/${id}`, {
        method: 'PATCH',
        body,
      }).then((r) => r.cliente),
    onSuccess: (cliente) => {
      client.setQueryData<ClientePerfilQueryData>(qk.clientePerfil(slot, cliente.id), (prev) => ({
        available: true,
        cliente,
        historico: prev?.historico ?? [],
      }));
      client.invalidateQueries({ queryKey: qk.clientesBase(slot) });
      client.invalidateQueries({ queryKey: ['colaborador-clientes', slot] });
      client.invalidateQueries({ queryKey: ['colaborador-cliente-perfil', slot] });
    },
  });
}

/**
 * Contrato assumido: POST /portal/clientes/:id/whatsapp-manual com
 * { mensagem, confirmed: true }. O portal-api deve revalidar flag/RBAC/escopo,
 * resolver o telefone e fazer o envio humanizado sem aceitar slot ou telefone.
 */
export function useEnviarWhatsappManual(
  slot: string,
): UseMutationResult<
  EnviarWhatsappManualResponse,
  Error,
  { id: string; body: EnviarWhatsappManualBody }
> {
  return useMutation({
    mutationFn: ({ id, body }) =>
      apiFetch<EnviarWhatsappManualResponse>(whatsappManualPath(id), {
        method: 'POST',
        body,
      }),
  });
}

// SCRUM-144: manda também o `nome` que o front já tem do contato selecionado no sheet de
// recentes, pra o backend snapshotar em contact_name (nome durável na pausa).
export interface AddPausaInput {
  telefone: string;
  nome?: string | null;
}

export function useAddPausa(slot: string): UseMutationResult<unknown, Error, AddPausaInput> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ telefone, nome }: AddPausaInput) =>
      apiFetch('/portal/pausas', { method: 'POST', body: { telefone, nome: nome ?? undefined } }),
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

// ── Suspeita de bot (SCRUM-4 PR-E) ──────────────────────────────────────────
//
// Lista os números que a auto-pausa do bot-detect pausou (source='bot_detected') e despausar do
// cliente (rede de proteção). Vem vazia enquanto a auto-pausa do worker estiver OFF -> a seção some.

export function useBotDetectPausas(slot: string): UseQueryResult<BotDetectPausasResponse> {
  return useQuery({
    queryKey: qk.botDetectPausas(slot),
    queryFn: ({ signal }) =>
      apiFetch<BotDetectPausasResponse>('/portal/bot-detect/pausas', { signal }),
  });
}

export function useRemoveBotDetectPausa(slot: string): UseMutationResult<unknown, Error, string> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (telefone: string) =>
      apiFetch(`/portal/bot-detect/pausas/${encodeURIComponent(telefone)}`, { method: 'DELETE' }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: qk.botDetectPausas(slot) });
      client.invalidateQueries({ queryKey: qk.status(slot) });
    },
  });
}

// ── Lembretes de agendamento (GET/PATCH /portal/lembretes) ───────────────────
//
// Config self-service do lembrete automático: enabled + janelas (min antes). O
// slot vem da sessão no backend (withTenant) — o front nunca envia slot; a query
// key carrega o slot pra isolar o cache por tenant. O contrato está CONGELADO mas
// o backend constrói em paralelo (PR companheiro do worker); a tela degrada com
// mensagem amigável se a rota ainda não existir.

export function useLembretes(slot: string): UseQueryResult<LembretesConfig> {
  return useQuery({
    queryKey: qk.lembretes(slot),
    queryFn: ({ signal }) => apiFetch<LembretesConfig>('/portal/lembretes', { signal }),
    retry: false,
  });
}

/**
 * PATCH /portal/lembretes — salva enabled + janelas. OTIMISTA: escreve o estado
 * novo no cache na hora (o toggle/chips não "voltam") e ressincroniza com a
 * resposta do servidor no sucesso. A tela faz o revert ao snapshot anterior no
 * erro (mesmo padrão D5 de perfil/serviços/horários).
 */
export function useSaveLembretes(
  slot: string,
): UseMutationResult<LembretesConfig, Error, LembretesPatch> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch) =>
      apiFetch<LembretesConfig>('/portal/lembretes', { method: 'PATCH', body: patch }),
    onSuccess: (config) => {
      client.setQueryData(qk.lembretes(slot), config);
    },
  });
}

// ── Conta Google da agenda (GET /portal/google-conta) ────────────────────────
//
// Credencial (e-mail + senha JÁ decriptada server-side) pra logar o app Google
// Agenda no celular/computador. Gated por GOOGLE_ACCOUNT_PORTAL_ENABLED (404 quando
// OFF = feature-off, tratado na seção). Escopado por slot da sessão (withTenant) — o
// front nunca envia slot; a query key carrega o slot pra isolar o cache por tenant.
//
// A SENHA vem `no-store` do backend e é sensível: NÃO cacheamos agressivo —
// staleTime 0 + gcTime 0 (some do cache assim que a tela desmonta) + sem refetch em
// foco/intervalo. Sem retry (404 não se resolve sozinho). NUNCA logar este dado.

export function useGoogleConta(slot: string): UseQueryResult<GoogleContaResponse> {
  return useQuery({
    queryKey: qk.googleConta(slot),
    queryFn: ({ signal }) => apiFetch<GoogleContaResponse>('/portal/google-conta', { signal }),
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
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

// ── Pausa do atendimento (POST /portal/bot/pause | /resume) ──────────────────
//
// Eixo SEPARADO da reconexao WAHA: flow_enabled (pausa) vs status WAHA (conexao).
// Gated por PORTAL_BOT_PAUSE no backend (404 se OFF — a tela ja esconde o card
// quando o GET nao expoe os campos). Slot SEMPRE da sessao (withTenant) — o front
// nunca envia slot. Não há update otimista: a UI usa operational_state da resposta
// ou um GET /portal/conexao final antes de anunciar o resultado.

export interface BotActionMutationResult<T extends BotPauseResponse | BotResumeResponse> {
  action: T;
  final: ConexaoResponse | null;
  syncFailed: boolean;
}

async function fetchFinalConexao(
  client: QueryClient,
  slot: string,
): Promise<ConexaoResponse | null> {
  try {
    const final = await apiFetch<ConexaoResponse>('/portal/conexao');
    client.setQueryData(qk.conexao(slot), final);
    return final;
  } catch {
    // A ação já pode ter sido confirmada. Não convertemos falha de reconciliação
    // em falsa "falha total"; mantemos o snapshot anterior e oferecemos retry.
    await client.invalidateQueries({ queryKey: qk.conexao(slot) });
    return null;
  }
}

function botResponseFromError(error: unknown): BotResumeResponse | null {
  if (!(error instanceof Error) || !('body' in error)) return null;
  const body = (error as { body?: unknown }).body;
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record.bot_paused !== 'boolean' || !record.operational_state) return null;
  return {
    bot_paused: record.bot_paused,
    operational_state: record.operational_state as BotResumeResponse['operational_state'],
  };
}

/** POST /portal/bot/pause — pausa o atendimento do proprio cliente (owner_request). */
export function usePausarBot(
  slot: string,
): UseMutationResult<BotActionMutationResult<BotPauseResponse>, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const action = await apiFetch<BotPauseResponse>('/portal/bot/pause', { method: 'POST' });
      const final = await fetchFinalConexao(client, slot);
      await client.invalidateQueries({ queryKey: qk.status(slot) });
      return { action, final, syncFailed: final?.operational_state == null };
    },
  });
}

/**
 * POST /portal/bot/resume — retoma o atendimento. 200 quando a pausa era do
 * proprio cliente; 409 { error:'suspensao_startap' } quando foi a Startap que
 * pausou (billing/manual_other/abuse) — nesse caso a tela mostra a `message` e o
 * cache fica intacto (o estado segue travado).
 */
export function useRetomarBot(
  slot: string,
): UseMutationResult<BotActionMutationResult<BotResumeResponse>, Error, void> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const action = await apiFetch<BotResumeResponse>('/portal/bot/resume', { method: 'POST' });
      if (action.operational_state) {
        client.setQueryData<ConexaoResponse>(qk.conexao(slot), (prev) =>
          prev ? conexaoFromBotActionResponse(prev, action) : prev,
        );
      }
      const final = await fetchFinalConexao(client, slot);
      await client.invalidateQueries({ queryKey: qk.status(slot) });
      return {
        action,
        final,
        syncFailed: final?.operational_state == null && !action.operational_state,
      };
    },
    onError: async (error) => {
      // 409 traz o snapshot final da transação. Aplicamos esse resultado antes
      // do refetch; nunca limpamos owner_request por hipótese local.
      const response = botResponseFromError(error);
      if (response) {
        client.setQueryData<ConexaoResponse>(qk.conexao(slot), (prev) =>
          prev ? conexaoFromBotActionResponse(prev, response) : prev,
        );
      }
      await Promise.all([
        client.invalidateQueries({ queryKey: qk.conexao(slot) }),
        client.invalidateQueries({ queryKey: qk.status(slot) }),
      ]);
    },
  });
}

// ── Equipe / Colaboradores (estabelecimento — GET/PATCH) ─────────────────────
//
// O portal SÓ lista (GET) e edita (PATCH: renomear/serviços/ativo/ordem) as vagas
// pré-provisionadas. Criar/excluir colaborador NÃO existem no portal de propósito
// (preço por barbeiro; agendas pré-provisionadas pelo operador no gestão) — não há
// mutation de POST/DELETE aqui. Toda rota é escopada por slot da sessão no backend
// (withTenant) + gated por product_type. O front nunca envia slot. A query key
// carrega o slot pra isolar o cache por tenant. A mutation invalida a lista
// (refetch): o backend é a fonte de verdade do seat_cap/uso (usados/seat_cap).

export function useEquipe(slot: string, enabled = true): UseQueryResult<EquipeResponse> {
  return useQuery({
    queryKey: qk.equipe(slot),
    // Normaliza id (BIGSERIAL -> string) e comissao_pct (NUMERIC) pra number no
    // boundary. Sem isso, id string quebra o gate de save e o POST de atendimento.
    queryFn: async ({ signal }) => {
      const res = await apiFetch<EquipeResponse>('/portal/equipe', { signal });
      return { ...res, colaboradores: res.colaboradores.map(mapColaboradorRow) };
    },
    enabled,
    retry: false,
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

/**
 * Gera/REGENERA a senha de login de um colaborador (POST /portal/equipe/:id/gerar-senha).
 * O backend devolve a senha em claro UMA vez (só guarda o hash) — por isso NÃO invalida a
 * lista nem cacheia: o componente exibe o resultado da mutation direto e descarta ao
 * fechar. Regenerar invalida a senha anterior no backend (idempotente). Mesma rota
 * escopada por slot da sessão (withTenant); o front nunca envia slot.
 */
export function useGerarSenhaColaborador(): UseMutationResult<
  GerarSenhaColaboradorResponse,
  Error,
  { id: number }
> {
  return useMutation({
    mutationFn: ({ id }) =>
      apiFetch<GerarSenhaColaboradorResponse>(`/portal/equipe/${id}/gerar-senha`, {
        method: 'POST',
      }),
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
 * GET /portal/relatorios/comissao?balde=&de=&ate= — só EMPRESA tem dados (SOLO
 * volta vazio). O `balde` (previsao|faturado) espelha o seletor da tela Billing: a
 * comissão acompanha o que está sendo olhado (esperado vs realizado). `de`/`ate`
 * OBRIGATÓRIOS (enabled só com os dois). 404 (flag off) na tela. Sem retry.
 */
export function useComissao(
  slot: string,
  balde: AtendimentoBalde,
  de: string | null,
  ate: string | null,
  enabled = true,
): UseQueryResult<ComissaoReport> {
  return useQuery({
    queryKey: qk.comissao(slot, balde, de ?? '', ate ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<ComissaoReport>(
        `/portal/relatorios/comissao?balde=${balde}&de=${encodeURIComponent(de ?? '')}&ate=${encodeURIComponent(ate ?? '')}`,
        { signal },
      ),
    enabled: enabled && Boolean(de && ate),
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
 * GET /portal/atendimentos/by-evento/:eventId — resolve a LINHA de atendimento
 * (mesma Row do balde) a partir do event_id da agenda, pra editar o DINHEIRO
 * (valor/desconto/forma) direto do card da agenda. 404 = não existe linha (clone
 * individual fora do gate, ou evento sem atendimento) → a UI ESCONDE a seção Valor.
 *
 * `enabled` extra: só dispara quando a feature está ligada (atend_from_agenda) e há
 * um eventId — defesa em profundidade (não bate na API à toa nos clones individuais).
 * Sem retry: 404 não se resolve sozinho. Escopado por slot da sessão (withTenant);
 * evento de outro tenant => 404 (anti-IDOR).
 */
export function useAtendimentoByEvento(
  slot: string,
  eventId: string | null,
  enabled = true,
): UseQueryResult<AtendimentoByEventoResponse> {
  return useQuery({
    queryKey: qk.atendimentoByEvento(slot, eventId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<AtendimentoByEventoResponse>(
        `/portal/atendimentos/by-evento/${encodeURIComponent(eventId ?? '')}`,
        { signal },
      ),
    enabled: enabled && Boolean(eventId),
    retry: false,
  });
}

/**
 * PATCH /portal/atendimentos/:id a partir do CARD DA AGENDA (edição de dinheiro
 * pelo sheet de agendamento). Mesmo endpoint sticky do billing (PINA dirty_fields),
 * mas SEM o período do balde em foco (o card da agenda não conhece de/ate): no
 * sucesso invalida o by-evento da linha + TODAS as listas de baldes + relatórios.
 * Assim a edição reflete nos dois lados (agenda ↔ billing) automaticamente. 400/404
 * tratados na tela.
 */
export function useEditarAtendimentoPorEvento(
  slot: string,
  eventId: string | null,
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
    onSuccess: () => {
      if (eventId) {
        client.invalidateQueries({ queryKey: qk.atendimentoByEvento(slot, eventId) });
      }
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

// ── Frases de comando (GET/PUT /portal/frases-pausa) ─────────────────────────
//
// Modo atendente (SCRUM-59): as frases que a recepção digita no chat pra pausar/
// retomar o assistente quando IA e humano dividem o MESMO número. Só é buscada quando
// a feature está ligada pro clone (`enabled` = features.modo_atendente do /portal/
// perfil) — clone sem a feature NÃO chama a rota (byte-idêntico). 404 = feature off no
// backend (rede de proteção): a seção some (mesmo critério do lembrete). retry:false
// pra não repetir um 404 que não se resolve sozinho. Escopado por slot da sessão.

export function useFrasesPausa(
  slot: string,
  enabled: boolean,
): UseQueryResult<FrasesPausaResponse> {
  return useQuery({
    queryKey: qk.frasesPausa(slot),
    queryFn: ({ signal }) => apiFetch<FrasesPausaResponse>('/portal/frases-pausa', { signal }),
    enabled,
    retry: false,
  });
}

/**
 * PUT /portal/frases-pausa — salva a LISTA COMPLETA (replace-set). Não é otimista: o
 * backend valida (máx 10, keyword 2..80, sem duplicata) e devolve o estado efetivo,
 * que fixamos no cache. A tela trava o Salvar em estado inválido; o 400 é rede de
 * proteção (tratado na seção).
 */
export function useSaveFrasesPausa(
  slot: string,
): UseMutationResult<FrasesPausaResponse, Error, FrasePausa[]> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (frases: FrasePausa[]) =>
      apiFetch<FrasesPausaResponse>('/portal/frases-pausa', { method: 'PUT', body: { frases } }),
    onSuccess: (res) => {
      client.setQueryData(qk.frasesPausa(slot), res);
    },
  });
}

// ── Builder de persona (SCRUM-92 — GET /portal/prompt-builder/draft) ──────────
//
// Prévia read-only do rascunho da persona (status + preview_final). É o PROBE de
// gating da seção "Monte seu atendente": 404 (flag PROMPT_BUILDER_ENABLED OFF) é
// normalizado por fetchBuilderDraft pra { status:'indisponivel' } -> a seção some
// (mesmo critério de lembretes/atendimentos/google-conta). Erro REAL (rede/500)
// propaga (isError) -> a seção mostra ErrorState com retry. retry:false porque um
// 404 não se resolve sozinho; staleTime curto pra refletir approve/reset logo após.
// A conversa em si é estado local do componente (efêmera); o Redis é a fonte no back.

export function useBuilderDraft(slot: string): UseQueryResult<BuilderDraft> {
  return useQuery({
    queryKey: qk.promptBuilder(slot),
    queryFn: ({ signal }) => fetchBuilderDraft(signal),
    retry: false,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
}

// ── Tom da conversa do assistente (SCRUM-92 — GET/PUT /portal/tom-assistente) ─
//
// Slider amigável que mapeia (no backend) pra temperatura do modelo — o dono nunca vê
// número. fetchTomAssistente normaliza 404 -> { status:'indisponivel' } (a seção some,
// mesmo critério do prompt-builder) e PROPAGA erro real (rede/500) -> ErrorState com retry.
// retry:false porque 404 não se resolve sozinho. Escopado por slot da sessão (withTenant) —
// o front nunca envia slot; a query key carrega o slot pra isolar o cache por tenant.

export function useTomAssistente(slot: string): UseQueryResult<TomState> {
  return useQuery({
    queryKey: qk.tomAssistente(slot),
    queryFn: ({ signal }) => fetchTomAssistente(signal),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * PUT /portal/tom-assistente — salva o novo nível (replace). No sucesso, fixa o estado OK no
 * cache; o backend pode reenviar o catálogo (`niveis`) — se não, preservamos o que já está em
 * cache (o catálogo não muda a cada save). Lança ApiError em falha -> o componente ramifica
 * 400 (nível inválido) / genérico no onError.
 */
export function useSaveTomAssistente(
  slot: string,
): UseMutationResult<{ nivel: TomNivel; niveis: TomNivelOpcao[] | null }, Error, TomNivel> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (nivel) => putTomAssistente(nivel),
    onSuccess: ({ nivel, niveis }) => {
      client.setQueryData<TomState>(qk.tomAssistente(slot), (prev) => {
        const catalogo = niveis ?? (prev?.status === 'ok' ? prev.niveis : []);
        return { status: 'ok', nivel, niveis: catalogo };
      });
    },
  });
}

// ── Cartão de confirmação (SCRUM-92 inc.2 — GET/PUT /portal/cartao-config) ─────
//
// GATEADO pela flag global (CARTAO_RUNTIME_ENABLED): fetchCartaoConfig NUNCA lança
// (404/flag OFF/rede/5xx -> { status:'hidden' }) — a seção SOME inteira (degradação
// graciosa). O contrato traz editable/locked_reason: editável (form) ou travado
// (read-only). Sem retry (404 do flag OFF não se resolve sozinho). Escopado por slot.

export function useCartaoConfig(slot: string): UseQueryResult<CartaoConfigState> {
  return useQuery({
    queryKey: qk.cartaoConfig(slot),
    queryFn: ({ signal }) => fetchCartaoConfig(signal),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/**
 * Prévia FIEL ao vivo (SCRUM-99): renderiza o cartão pros 3 templates com os emojis do rascunho,
 * pela MESMA função do runtime (backend). Keyed pelos emojis → cada combinação = 1 fetch cacheado
 * (troca de template NÃO refaz fetch: os 3 já vêm juntos). keepPreviousData evita flicker enquanto
 * o dono mexe. NUNCA lança (fetchCartaoPreview → null em falha); a seção cai no fallback client.
 */
export function useCartaoPreview(
  slot: string,
  emojis: CartaoEmojis,
): UseQueryResult<CartaoPreviewLive> {
  return useQuery({
    queryKey: qk.cartaoPreview(slot, emojis),
    queryFn: ({ signal }) => fetchCartaoPreview(emojis, signal),
    retry: false,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}

/**
 * PUT /portal/cartao-config — salva template + emojis (flip-on-customize). onSuccess grava
 * o estado editável devolvido (clone já em runtime). onError invalida a query pra
 * RE-SINCRONIZAR: se o clone virou travado por corrida (409 prompt_custom / 422
 * requer_revisao), o próximo GET reflete o read-only. O revert otimista vive na seção.
 */
export function useSaveCartaoConfig(
  slot: string,
): UseMutationResult<SaveCartaoResult, Error, Parameters<typeof putCartaoConfig>[0]> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload) => putCartaoConfig(payload),
    onSuccess: ({ state }) => {
      client.setQueryData(qk.cartaoConfig(slot), state);
    },
    onError: () => {
      client.invalidateQueries({ queryKey: qk.cartaoConfig(slot) });
    },
  });
}
