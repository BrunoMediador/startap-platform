/**
 * Tipos do contrato do portal-api (apps/portal-api/src/routes/*.ts).
 *
 * Espelham EXATAMENTE o shape que a API devolve — nao inventar campos.
 * Referencias:
 *   auth.ts            -> AuthMe, LoginResponse, LoginErrorBody
 *   portal-status.ts   -> StatusResponse, ContatosResponse
 *   portal-config.ts   -> ServicosResponse, HorariosResponse (+ Servico/Horarios)
 *   portal-pausas.ts   -> PausasResponse, PausaRow
 *   portal-agendamentos.ts -> AgendamentosResponse, Agendamento
 *   packages/core/src/schemas/flow-config.ts -> Servico / HorarioDia / DIAS_SEMANA
 */

// ── Auth ────────────────────────────────────────────────────────────────────

export interface LoginUser {
  username: string;
  display_name: string | null;
  must_change_password: boolean;
}

/**
 * Papel da sessão criada no login (SCRUM-32). `owner` = dono (fluxo de hoje);
 * `colaborador` = barbeiro de estabelecimento, visão READ-ONLY (/colaborador/*).
 * Owners legados pré-#394 podem vir SEM `role` -> o front trata ausência como owner.
 */
export type LoginRole = 'owner' | 'colaborador';

export interface LoginResponse {
  ok: true;
  /** SCRUM-32: roteia o front pra área certa após o login. Ver LoginRole. */
  role?: LoginRole;
  user: LoginUser;
}

/** Corpo de erro do login (401/403/429). `locked` presente quando travado. */
export interface LoginErrorBody {
  error: string;
  locked?: boolean;
}

/**
 * 201 do POST /auth/signup (portal-signup.ts, Missao 020 F1). A rota ja seta o
 * cookie httpOnly de sessao (auto-login) — o front so redireciona.
 * `trial_started` e sempre false aqui: o trial SO comeca no pareamento.
 */
export interface SignupResponse {
  ok: true;
  user: LoginUser;
  trial_started: boolean;
}

export type ProductType = 'individual' | 'estabelecimento';

/**
 * GET /portal/aceite/status (SCRUM-1, fluxo 2). `needs_acceptance` = o tenant logado
 * ainda NÃO aceitou a versão vigente dos Termos/Privacidade -> o app bloqueia até aceitar.
 */
export interface AceiteStatus {
  needs_acceptance: boolean;
  terms_version: string;
  privacy_version: string;
  accepted_terms_version: string | null;
  accepted_privacy_version: string | null;
}

/** 201 do POST /portal/aceite (registro do aceite pós-login). */
export interface AceiteResponse {
  ok: true;
  terms_version: string;
  privacy_version: string;
}

export interface AuthMe {
  username: string;
  slot: string;
  // Presentes SÓ quando o cliente é estabelecimento E a feature está ON (auth.ts).
  // Ausentes = individual: o portal renderiza IDÊNTICO ao de hoje (Cirilo/Samuel).
  product_type?: ProductType;
  seat_cap?: number | null;
  /**
   * App de gestão (atendimentos + relatórios). SEMPRE presente (true/false): o
   * backend deriva da flag ATENDIMENTOS_ENABLED. false => o portal esconde os
   * itens de menu de gestão e as páginas mostram "recurso indisponível".
   */
  atendimentos_enabled: boolean;
  /**
   * Billing derivado da agenda (ADR 0027 Fase C). Quando true, o faturamento passa
   * a vir dos eventos da agenda em DOIS baldes (Previsão = futuros / Faturado =
   * passados), editáveis linha a linha. Pode vir AUSENTE (contrato em construção no
   * backend, em paralelo) — o front trata ausente como false: com a flag OFF a área
   * de faturamento fica IDÊNTICA à de hoje (SOLO Cirilo/Samuel não regride).
   */
  atend_from_agenda?: boolean;
  /**
   * CRM de clientes (Missão 034). Default OFF no backend; ausente = tratar como
   * false e manter o portal byte-idêntico aos tenants sem rollout.
   */
  crm_clientes_enabled?: boolean;
}

// ── Colaborador (painel READ-ONLY do barbeiro — SCRUM-32, portal-colaborador.ts) ──
//
// O colaborador loga com username (slug do nome) + senha gerada pelo dono no gestão.
// A sessão nasce com role='colaborador' + colaboradorId; TODA query escopa por
// (slot + tenant + colaboradorId) DA SESSÃO no backend — o front nunca envia id.
// Visão só-leitura: a agenda dele e a comissão/faturamento dele. Sem ações do dono.

/** GET /auth/colaborador/me — identidade da sessão do colaborador (server guard). */
export interface ColaboradorMe {
  role: 'colaborador';
  username: string;
  display_name: string;
  colaborador_id: number;
  slot: string;
  /**
   * Fuso IANA do clone (ex.: "America/Sao_Paulo", "America/Cuiaba"). FONTE DE VERDADE do tz do
   * colaborador: o /auth/colaborador/me hidrata a sessão e o painel READ-ONLY exibe a agenda
   * neste fuso. Opcional: undefined enquanto a portal-api não devolve -> default São Paulo.
   */
  timezone?: string;
  /** Mesmo gate do owner: ausente = OFF/fail-closed. */
  crm_clientes_enabled?: boolean;
}

/**
 * GET /portal/colaborador/agenda — agenda do colaborador logado (read-only). MESMO shape
 * de AgendamentosResponse (id/titulo/inicio/fim); `gcal_configured:false` = agenda
 * dele ainda não conectada (pré-setup, estado esperado -> empty, não erro).
 */
export interface ColaboradorAgendaResponse {
  gcal_configured: boolean;
  count: number;
  agendamentos: Agendamento[];
}

export type AgendaBloqueioTipo = 'almoco' | 'ausencia' | 'ferias' | 'indisponivel';
export type AgendaBloqueioStatus = 'active' | 'gcal_cleanup_failed';

export interface AgendaBloqueio {
  id: string;
  serie_id?: string | null;
  colaborador_id: number | null;
  gcal_event_id: string | null;
  inicio_at: string;
  fim_at: string;
  timezone: string;
  tipo: AgendaBloqueioTipo;
  motivo: string | null;
  status: AgendaBloqueioStatus;
  created_by_role: 'owner' | 'colaborador';
  created_by_user_id: number | null;
  created_by_colaborador_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface AgendaBloqueiosResponse {
  count: number;
  bloqueios: AgendaBloqueio[];
}

export interface AgendaBloqueioInput {
  inicio_at: string;
  fim_at: string;
  timezone: string;
  tipo: AgendaBloqueioTipo;
  motivo?: string;
  colaborador_id?: number;
}

export interface CriarAgendaBloqueioResponse {
  ok: true;
  bloqueio: AgendaBloqueio;
}

export interface RemoverAgendaBloqueioResponse {
  ok: true;
}

export interface RemoverAgendaBloqueioSerieResponse {
  ok: true;
  serie_id: string;
  /**
   * O backend atual devolve a lista de bloqueios futuros afetados. O front só
   * depende da contagem; por isso o shape interno segue opaco aqui.
   */
  removidos: unknown[];
}

/** Um balde do relatório de comissão do colaborador (faturado OU previsão). */
export interface ColaboradorComissaoBalde {
  /** Faturamento bruto dele no período (base da comissão), em centavos. */
  total_bruto_cents: number;
  /** % de comissão configurada (0–100). null = não configurada -> "—" na UI. */
  comissao_pct: number | null;
  /** O que ELE recebe (bruto × pct), em centavos. */
  comissao_cents: number;
  count: number;
  balde: AtendimentoBalde;
}

/**
 * GET /portal/colaborador/comissao?de=&ate= — faturamento + comissão do colaborador nos
 * DOIS baldes de uma vez (faturado = realizado/passado; previsao = agendado/futuro),
 * dentro da janela [de, ate]. profissional_nome pode vir null (nome apagado) -> fallback.
 */
export interface ColaboradorComissaoResponse {
  de: string; // 'YYYY-MM-DD'
  ate: string; // 'YYYY-MM-DD'
  colaborador_id: number;
  profissional_nome: string | null;
  faturado: ColaboradorComissaoBalde;
  previsao: ColaboradorComissaoBalde;
}

// ── Servicos ─────────────────────────────────────────────────────────────────

export interface Servico {
  nome: string;
  preco_cents: number;
  duracao_min: number;
}

export interface ServicosResponse {
  servicos: Servico[];
}

// ── Equipe / Colaboradores (estabelecimento — portal-equipe.ts) ──────────────

export interface Colaborador {
  id: number;
  nome: string;
  gcal_calendar_id: string | null;
  gcal_status: string;
  servicos: string[];
  ativo: boolean;
  ordem: number;
  /**
   * % de comissão sobre o BRUTO do atendimento (0–100). Vem como número do
   * backend (a coluna é NUMERIC, mas a rota /portal/equipe serializa pra number).
   * Default 0 = profissional sem comissão configurada.
   */
  comissao_pct: number;
  created_at: string;
  updated_at: string;
}

export interface EquipeResponse {
  /** Teto contratual de vagas. null = sem teto. */
  seat_cap: number | null;
  /** Colaboradores ATIVOS (vagas em uso). */
  usados: number;
  colaboradores: Colaborador[];
}

export interface SaveColaboradorResponse {
  ok: true;
  colaborador: Colaborador;
}

/**
 * Corpo de criação/edição de colaborador (slot/tenant vêm da sessão, nunca aqui).
 * Todos opcionais porque o PATCH é parcial (ex.: toggle de `ativo` só envia ativo).
 * Na criação, a validação do form (lib/equipe) garante o `nome`.
 */
export interface ColaboradorInput {
  nome?: string;
  servicos?: string[];
  ativo?: boolean;
  ordem?: number;
  /** % de comissão sobre o bruto (0–100). Opcional no PATCH parcial. */
  comissao_pct?: number;
}

/**
 * Resposta de POST /portal/equipe/:id/gerar-senha — o dono gera/regenera a senha de
 * login de um colaborador dele. A senha em claro vem UMA vez (o backend só guarda o
 * hash); a UI mostra + permite copiar e nunca a refetcha.
 */
export interface GerarSenhaColaboradorResponse {
  ok: true;
  username: string;
  generated_password: string;
}

// ── Horarios ─────────────────────────────────────────────────────────────────

export interface HorarioDia {
  abre: string | null; // 'HH:MM'
  fecha: string | null; // 'HH:MM'
  fechado: boolean;
}

export const DIAS_SEMANA = [
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
  'domingo',
] as const;

export type DiaSemana = (typeof DIAS_SEMANA)[number];

export type Horarios = Partial<Record<DiaSemana, HorarioDia>>;

export interface HorariosResponse {
  horarios: Horarios;
}

// ── Pausas ───────────────────────────────────────────────────────────────────

export interface PausaRow {
  telefone: string;
  source: string | null;
  reason: string | null;
  /** Nome do contato snapshotado na criação da pausa (SCRUM-144). null = não capturado. */
  contact_name: string | null;
  created_at: string; // ISO (serializado de Date)
  updated_at: string;
}

export interface PausasResponse {
  count: number;
  pausas: PausaRow[];
}

// Suspeita de bot (SCRUM-4 PR-E): mesma forma de PausasResponse, só source='bot_detected'.
//   portal-bot-detect.ts -> GET /portal/bot-detect/pausas
export interface BotDetectPausasResponse {
  count: number;
  pausas: PausaRow[];
}

// ── Contatos recentes ────────────────────────────────────────────────────────

export interface RecentContact {
  phone: string;
  name: string | null;
  last_interaction: string; // ISO
}

export interface ContatosResponse {
  session: string | null;
  days?: number;
  count: number;
  contacts: RecentContact[];
  source?: 'waha' | 'db';
}

// ── CRM Clientes (Missão 034) ────────────────────────────────────────────────
//
// Contrato frontend esperado para a base canônica por tenant+telefone. A lista
// minimiza PII (telefone mascarado); o perfil autorizado pode trazer o telefone
// completo e, para o dono, os campos opcionais editáveis.

/** Aniversário sem ano civil — serializado como "MM-DD". */
export type ClienteAniversario = string;

export interface ClienteListItem {
  id: number;
  nome_preferido: string | null;
  telefone_masked: string | null;
  cidade: string | null;
  total_atendimentos: number;
  ultimo_atendimento_at: string | null;
  ultimo_profissional_nome: string | null;
}

export interface ClientesListResponse {
  items: ClienteListItem[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface ClienteHistoricoItem {
  atendimento_id: number;
  data: string;
  inicio_at: string | null;
  fim_at: string | null;
  servico_nome: string | null;
  profissional_nome: string | null;
  status: string | null;
}

export interface ClientePerfil {
  id: number;
  nome_preferido: string | null;
  telefone: string | null;
  telefone_masked: string | null;
  aniversario: ClienteAniversario | null;
  cidade: string | null;
  nota_interna: string | null;
  total_atendimentos: number;
  ultimo_atendimento_at: string | null;
  created_at: string;
  updated_at: string;
  historico: ClienteHistoricoItem[];
}

export interface ClientePerfilResponse {
  cliente: ClientePerfil;
}

export interface SaveClienteBody {
  aniversario?: ClienteAniversario | null;
  cidade?: string | null;
  nota_interna?: string | null;
}

export interface SaveClienteResponse {
  ok: true;
  cliente: ClientePerfil;
}

// ── Status / Home ────────────────────────────────────────────────────────────

export type BillingStatus = 'active' | 'overdue' | 'suspended';

export interface StatusBilling {
  next_due_date: string | null; // 'YYYY-MM-DD'
  dias_restantes: number | null;
  status: BillingStatus;
}

/** PORQUÊ da pausa (flow_enabled=false). null quando ativo OU pausa legada sem categoria. */
export type SuspendedKind = 'billing' | 'owner_request' | 'manual_other' | 'abuse';

/** Eixos públicos do estado operacional composto (ADR 0037 / SCRUM-170). */
export type WahaOperationalState = 'working' | 'disconnected' | 'failed' | 'unknown';
export type StartapSuspensionKind = 'billing' | 'manual_other' | 'abuse';
export type EffectiveOperationalState =
  | 'working'
  | 'disconnected'
  | 'paused_by_owner'
  | 'blocked_billing'
  | 'blocked_startap'
  | 'unknown';
export type ResumeOwnerDeniedReason =
  | 'billing_overdue'
  | 'startap_billing'
  | 'startap_manual_other'
  | 'startap_abuse';

/**
 * Projeção autoritativa retornada pela portal-api. O frontend só apresenta estes
 * eixos: não recalcula carência, vencimento efetivo nem precedência de bloqueios.
 */
export interface OperationalState {
  waha: { state: WahaOperationalState };
  atendimento: {
    configured: boolean;
    processing: boolean;
    responding: boolean;
  };
  owner_pause: { active: boolean };
  billing: { blocking: boolean; dias_restantes: number | null };
  startap_suspension: {
    active: boolean;
    kind: StartapSuspensionKind | null;
  };
  effective: EffectiveOperationalState;
  actions: {
    resume_owner: {
      allowed: boolean;
      denied_reason: ResumeOwnerDeniedReason | null;
    };
  };
}

export interface StatusResponse {
  slot: string;
  display_name: string | null;
  flow_enabled: boolean;
  /** Categoria da suspensão. Distingue pausa do dono de inadimplência (ver lib/suspensao). */
  suspended_kind: SuspendedKind | null;
  waha: { session: string | null; status: string };
  pausas_ativas: number;
  billing: StatusBilling | null;
  /** Aditivo durante rollout. Ausente = UI fail-closed, sem declarar falso ativo. */
  operational_state?: OperationalState;
  /**
   * Fuso IANA do clone (ex.: "America/Sao_Paulo", "America/Cuiaba"). Usado pra exibir
   * datas/horas da agenda no fuso da barbearia. Backend grava em flow_clones.timezone
   * (default São Paulo). Opcional: vem undefined enquanto a portal-api não foi atualizada —
   * o front cai no default São Paulo (ver TenantTzProvider).
   */
  timezone?: string;
}

// ── Agendamentos ─────────────────────────────────────────────────────────────

export interface Agendamento {
  id: string;
  titulo: string;
  inicio: string | null; // ISO ou date
  fim: string | null;
  /**
   * Estabelecimento (multi-profissional): de qual colaborador é o evento.
   * AUSENTES no individual (single-agenda) — a agenda renderiza idêntico a hoje.
   * Só presentes quando o backend agrega as agendas dos colaboradores.
   */
  colaborador_id?: number;
  profissional_nome?: string;
}

export interface AgendamentosResponse {
  gcal_configured: boolean;
  count: number;
  agendamentos: Agendamento[];
  /**
   * Onda 3 (SCRUM-68 / ADR 0030 D3): o clone ESCOLHEU agenda no signup, mas a agenda
   * Google ainda NÃO foi conectada pela nossa equipe (Service Account, ADR 0024).
   * Derivado no backend = `agenda_automatica === true && gcal_configured === false`.
   *
   * `true` -> a UI mostra o card "estamos conectando sua agenda" (em vez do empty
   * genérico "agenda não conectada"), com SLA e a tranquilização de que a assistente
   * já atende enquanto isso (degrade elegante). AUSENTE/`false` = comportamento de
   * hoje, byte-idêntico: clone em modo atendente (nunca terá agenda) OU já conectado.
   */
  aguardando_agenda?: boolean;
}

// ── Agenda: slots livres + criação manual (Missão 020 F4) ────────────────────
//
// Espelham portal-agenda-slots.ts e o POST de portal-agendamentos.ts. A grade
// vem SÓ com horários livres (ocupado nem aparece — doc 020 B3), agrupados em
// manhã (<12h), tarde (12h–17h59) e noite (>=18h).

export interface SlotsServico {
  nome: string;
  duracao_min: number;
}

export interface SlotsGrupos {
  manha: string[];
  tarde: string[];
  noite: string[];
}

/**
 * GET /portal/agenda/slots?data=YYYY-MM-DD&servico=<nome> → 200.
 * `gcal_configured:false` = agenda não conectada (estado esperado, não erro).
 * `aberto:false` = dia fechado na grade de Horários (slots sempre vazios).
 */
export interface AgendaSlotsResponse {
  gcal_configured: boolean;
  data: string; // 'YYYY-MM-DD'
  servico: SlotsServico;
  aberto: boolean;
  count: number;
  slots: string[]; // 'HH:mm'
  grupos: SlotsGrupos;
}

/**
 * Body do POST /portal/agendamentos (telefone já só dígitos, com DDI).
 *
 * 🔴 `cliente_telefone` é OBRIGATÓRIO a menos que `sem_whatsapp: true` (schema
 * `criarAgendamentoSchema` do backend, branch feat/agenda-recorrente, `.refine`):
 * é a identidade que `reminders.ts` usa como destino do lembrete. `sem_whatsapp`
 * é o escape hatch explícito pro dono que genuinamente não tem o número do
 * cliente — sem ele o backend responde 400 com `path: ['cliente_telefone']`.
 */
export interface CriarAgendamentoBody {
  servico: string;
  data: string; // 'YYYY-MM-DD'
  hora: string; // 'HH:mm'
  cliente_nome: string;
  cliente_telefone?: string;
  /** Escape hatch: sem WhatsApp do cliente → sem lembrete automático. Default false. */
  sem_whatsapp?: boolean;
  /**
   * Profissional do estabelecimento que vai atender. OBRIGATÓRIO quando o tenant é
   * `product_type=estabelecimento` (o backend responde 422 colaborador_obrigatorio
   * sem ele); AUSENTE no individual/SOLO (1 agenda só — comportamento de hoje).
   */
  colaborador_id?: number;
}

/** 201 do POST — `agendamento` no MESMO shape da lista (prepend otimista ok). */
export interface CriarAgendamentoResponse {
  ok: true;
  agendamento: Agendamento;
}

/** Razões do 409 ({error:'conflito'}) do POST /portal/agendamentos. */
export type ConflitoReason = 'ocupado' | 'horario_passado' | 'fora_do_horario';

// ── Recorrência (POST /portal/agendamentos/recorrencia/preview + /serie) ─────
// Contrato final do backend (branch feat/agenda-recorrente, apps/portal-api/src/
// routes/portal-agendamentos.ts) — front escrito contra ele antes do merge.

/** Espelha PERIODICIDADES de packages/core/src/recorrencia.ts. */
export type Periodicidade = 'semanal' | 'mensal' | 'trimestral' | 'semestral';
export type AgendaBloqueioPeriodicidade = Periodicidade | 'diaria';

/** Espelha OCORRENCIAS_MIN/MAX de packages/core/src/recorrencia.ts — cap duro (rate-limit GCal). */
export const OCORRENCIAS_MIN = 2;
export const OCORRENCIAS_MAX = 24;

/** Status de UMA ocorrência no preview — espelha AvaliarSlotStatus do backend. */
export type PreviewOcorrenciaStatus =
  | 'livre'
  | 'ocupado'
  | 'fora_do_horario'
  | 'fechado'
  | 'fora_da_janela'
  | 'passado';

/** Presente só quando status==='ocupado' — horário do evento existente que colide. */
export interface PreviewConflito {
  inicio: string | null; // ISO
  fim: string | null; // ISO
}

export interface PreviewOcorrencia {
  data: string; // 'YYYY-MM-DD'
  hora: string; // 'HH:mm'
  status: PreviewOcorrenciaStatus;
  conflito?: PreviewConflito;
}

/** Body do POST /portal/agendamentos/recorrencia/preview — SÓ LÊ, não grava nada. */
export interface PreviewRecorrenciaBody {
  servico: string;
  data: string; // 'YYYY-MM-DD' — âncora (1ª ocorrência)
  hora: string; // 'HH:mm'
  cliente_nome: string;
  cliente_telefone?: string;
  sem_whatsapp?: boolean;
  colaborador_id?: number;
  periodicidade: Periodicidade;
  ocorrencias: number; // 2..24
}

export interface PreviewRecorrenciaResponse {
  ok: true;
  previews: PreviewOcorrencia[];
}

/** Uma data já confirmada pelo dono na tela de revisão (o servidor NÃO recalcula). */
export interface SerieDataHora {
  data: string; // 'YYYY-MM-DD'
  hora: string; // 'HH:mm'
}

/** Body do POST /portal/agendamentos/serie — GRAVA a lista explícita que o dono confirmou. */
export interface CriarSerieBody {
  servico: string;
  cliente_nome: string;
  cliente_telefone?: string;
  sem_whatsapp?: boolean;
  colaborador_id?: number;
  datas: SerieDataHora[]; // 2..24
}

export interface SerieOcorrenciaCriada {
  id: string; // eventId do GCal
  data: string;
  hora: string;
}

export interface SerieOcorrenciaFalha {
  data: string;
  hora: string;
  error: string;
  reason: string;
}

/**
 * Resposta do POST /portal/agendamentos/serie. Status HTTP conta a história:
 *   201 = tudo criado (falhas vazio) · 207 = parcial (ok:true, ALGUMAS falharam,
 *   NÃO é exceção — trate como sucesso parcial na UI) · 409 = nenhuma criada.
 */
export interface CriarSerieResponse {
  ok: boolean;
  serie_id: string;
  criados: SerieOcorrenciaCriada[];
  falhas: SerieOcorrenciaFalha[];
}

// ── Recorrência de bloqueios (preview + revisão + /serie) ────────────────────

/**
 * Body do POST /portal/agenda/bloqueios/recorrencia/preview — mesmo payload do
 * bloqueio simples, mais periodicidade e número de ocorrências. Só calcula; não
 * grava nada. O colaborador usa o MESMO shape, mas sem `colaborador_id` vindo do
 * client (a identidade continua na sessão).
 */
export interface PreviewAgendaBloqueioRecorrenciaBody extends AgendaBloqueioInput {
  periodicidade: AgendaBloqueioPeriodicidade;
  ocorrencias: number; // 2..24
}

/** Uma ocorrência candidata da série de bloqueios, com faixa completa e estado. */
export interface PreviewAgendaBloqueioRecorrencia {
  inicio_at: string;
  fim_at: string;
  status?: PreviewOcorrenciaStatus | null;
}

export interface PreviewAgendaBloqueioRecorrenciaResponse {
  ok: true;
  previews: PreviewAgendaBloqueioRecorrencia[];
}

/**
 * Body do POST /portal/agenda/bloqueios/serie — reenviamos os MESMOS parâmetros
 * canônicos que geraram a prévia. O backend recalcula a série server-side antes
 * de gravar na Agenda Google.
 */
export interface CriarAgendaBloqueioSerieBody extends AgendaBloqueioInput {
  periodicidade: AgendaBloqueioPeriodicidade;
  ocorrencias: number; // 2..24
}

export interface AgendaBloqueioSerieCriado {
  id: string;
  serie_id?: string | null;
  inicio_at: string;
  fim_at: string;
}

export interface AgendaBloqueioSerieFalha {
  serie_id?: string | null;
  inicio_at: string;
  fim_at: string;
  error: string;
  reason?: string | null;
}

/**
 * Resposta do POST /portal/agenda/bloqueios/serie. Status HTTP conta a história:
 *   201 = tudo criado · 207 = parcial · 409 = nenhum criado (mas a resposta ainda
 *   traz as listas completas, então a UI revisa o resultado sem inventar estado).
 */
export interface CriarAgendaBloqueioSerieResponse {
  ok: boolean;
  serie_id: string;
  criados: AgendaBloqueioSerieCriado[];
  falhas: AgendaBloqueioSerieFalha[];
}

/**
 * 200 do DELETE /portal/agendamentos/:eventId — cancela/exclui o evento no GCal
 * do tenant (ação irreversível: apaga de verdade na agenda Google).
 *
 * CONTRATO DOCUMENTADO (Missão 023 W10): o backend ainda está construindo esta
 * rota num worktree próprio. O front consome contra este shape; se a rota ainda
 * não existir (404 sem corpo conhecido), a UI degrada com mensagem amigável.
 * `already_gone:true` = o evento já não estava lá (idempotente, trata como
 * sucesso na UI — o objetivo do dono foi alcançado).
 */
export interface ExcluirAgendamentoResponse {
  ok: true;
  already_gone?: boolean;
}

/**
 * Body do PATCH /portal/agendamentos/:eventId (Bloco C — remarcar/trocar serviço).
 *
 * CONTRATO (backend-senior, em paralelo): todos os campos OPCIONAIS, mas pelo
 * menos UM obrigatório (o backend valida ≥1; o front também trava o botão se
 * nada mudou). `data`+`hora` viajam juntos no remarcar; `servico` no trocar.
 * `cliente_*` ficam disponíveis no contrato, mas a UI desta entrega só usa
 * servico/data/hora (editar nome/telefone é tech debt aceito).
 *
 * Respostas:
 *   200 { ok, agendamento }   · 400 payload inválido · 404 evento não pertence
 *   409 conflito (recarregar a grade de slots) · 422 config ausente · 502 GCal.
 */
export interface EditarAgendamentoBody {
  servico?: string;
  data?: string; // 'YYYY-MM-DD'
  hora?: string; // 'HH:mm'
  cliente_nome?: string;
  cliente_telefone?: string;
}

/** 200 do PATCH — `agendamento` no MESMO shape da lista (atualização in-place). */
export interface EditarAgendamentoResponse {
  ok: true;
  agendamento: Agendamento;
}

// ── Mensalidade / Pagamento PIX (portal-billing.ts — ADR 0013 F3 / ADR 0014) ──

/** Estado da cobranca PIX do ciclo atual. */
export type ChargeStatus = 'pending' | 'paid' | 'expired' | 'cancelled';

/**
 * Estado de cobranca por DATA DE VENCIMENTO (ADR 0014, modelo `due_date`).
 * Fonte unica no backend (computeBillingState). Janela default = 7 dias.
 *   sem_config | em_dia (d>7) | a_vencer (1..7) | vencido (d<=0).
 */
export type BillingDueState = 'em_dia' | 'a_vencer' | 'vencido' | 'sem_config';

/**
 * Projecao publica da cobranca (chargeView no backend) — sem snapshot de valor
 * nem ids internos. `br_code` = copia-e-cola; `br_code_base64` = QR pronto pra
 * <img src>. `null` quando ainda nao gerada.
 */
export interface ChargeView {
  cycle: string; // 'YYYY-MM'
  status: ChargeStatus;
  br_code: string | null;
  br_code_base64: string | null; // 'data:image/png;base64,...'
  expires_at: string | null; // ISO
  paid_at: string | null; // ISO
  /** true quando a cobranca `pending` ja passou da validade (backend reemite no POST /pix). */
  is_expired?: boolean;
}

/**
 * Resumo da mensalidade + cobranca do ciclo atual (GET /portal/mensalidade).
 *
 * COMPATIBILIDADE FLAG (ADR 0014, H): o backend serve DOIS contratos atras de
 * `BILLING_DUE_DATE_MODEL`. Os campos do modelo novo (`model`/`state`/
 * `pode_gerar_pix`) sao OPCIONAIS — vem SO com a flag ON. O front detecta o
 * modelo pela PRESENCA de `state`: presente => modelo `due_date` (janela);
 * ausente => modelo legado por ciclo de mes (render atual intacto). Assim o
 * deploy e seguro com a flag off e o novo comportamento liga sem novo deploy.
 */
export interface MensalidadeResponse {
  /** 'due_date' so no modelo novo (flag ON). Ausente no legado. */
  model?: 'due_date';
  /** Estado por data de vencimento (flag ON). Ausente => modelo legado. */
  state?: BillingDueState;
  amount_cents: number | null;
  next_due_date: string | null; // 'YYYY-MM-DD'
  dias_restantes: number | null;
  billing_status: BillingStatus | null;
  /** Janela de pagamento aberta (flag ON). Em dia/sem_config => false; charge=null. */
  pode_gerar_pix?: boolean;
  charge: ChargeView | null;
  /** true quando a chave configurada e Dev (mostra "Simular pagamento"). */
  dev_mode: boolean;
}

/** Resposta do disparo de simulacao (POST /portal/mensalidade/simular). */
export interface SimularResponse {
  simulated: true;
}

// ── Conexao WhatsApp (portal-conexao.ts — reconexao self-service) ─────────────
//
// Espelha EXATAMENTE o contrato travado da API (5 rotas). A feature inteira e
// gated por `enabled`: com `false`, esconder o item de menu e o banner (flag OFF
// no backend). O telefone so chega MASCARADO (`registered_phone_masked`) — o
// cliente nunca edita o numero.

/**
 * Estado da conexao do WhatsApp do robo (GET /portal/conexao).
 *   enabled                 -> feature flag (esconde tudo quando false).
 *   session                 -> nome da sessao WAHA (so referencia, nao exibido).
 *   status                  -> status WAHA cru (WORKING, SCAN_QR_CODE, FAILED, ...).
 *   connected               -> true sse status === WORKING.
 *   needs_action            -> banner de reconexao deve aparecer (status != WORKING).
 *   has_registered_phone    -> ha numero cadastrado (gate da reconexao por codigo).
 *   registered_phone_masked -> "55 11 9••••-1234" (so leitura, nunca editavel).
 *   can_reconnect           -> botao de reconectar habilitado (anti-abuso no back).
 *   reconnect_cooldown_seconds -> cooldown sugerido pro botao apos reconectar.
 *   ever_connected          -> OPCIONAL. Clone JA pareou alguma vez? Deriva de
 *     flow_clones.first_connected_at (migration 062: NULL = nunca pareou). Distingue
 *     a PRIMEIRA conexao (onboarding, copy positiva) da RECONEXAO ("desconectou").
 *     AUSENTE enquanto o backend nao expoe -> o front assume reconexao (byte-identico,
 *     ver lib/conexao-copy.ts). Contrato: `ever_connected = first_connected_at != null`.
 *
 * PAUSA (eixo SEPARADO da conexao WAHA — flow_enabled, gated por PORTAL_BOT_PAUSE):
 * a conexao WAHA e a pausa do atendimento sao independentes (um robo pode estar
 * conectado E pausado). Os 3 campos abaixo sao OPCIONAIS: vem AUSENTES quando a
 * flag PORTAL_BOT_PAUSE esta OFF no backend — nesse caso o card de pausa some
 * (degrada limpo, sem regredir a tela atual).
 *   bot_paused   -> flow_enabled === false (atendimento pausado, por quem quer que seja).
 *   pause_self   -> bot_paused && suspended_kind === 'owner_request' (o cliente pausou; pode retomar).
 *   pause_locked -> bot_paused && !pause_self (suspenso pela Startap: billing/manual_other/abuse;
 *                   toggle TRAVADO, sem expor o motivo cru — so "fale com o suporte").
 */
export interface ConexaoResponse {
  enabled: boolean;
  session: string | null;
  status: string;
  connected: boolean;
  needs_action: boolean;
  has_registered_phone: boolean;
  registered_phone_masked: string | null;
  can_reconnect: boolean;
  reconnect_cooldown_seconds: number;
  /** Clone ja pareou alguma vez (first_connected_at != null). Ausente = backend
   *  ainda nao expoe -> front assume reconexao (default seguro, byte-identico). */
  ever_connected?: boolean;
  bot_paused?: boolean;
  pause_self?: boolean;
  pause_locked?: boolean;
  /** Aditivo durante rollout. As ações continuam gated pelos campos legados acima. */
  operational_state?: OperationalState;
}

/** POST /portal/bot/pause -> 200. Atendimento pausado pelo cliente. */
export interface BotPauseResponse {
  bot_paused: boolean;
  /** Opcional por retrocompatibilidade; o endpoint atual é reconciliado por refetch. */
  operational_state?: OperationalState;
}

/** POST /portal/bot/resume -> 200. Atendimento retomado pelo cliente. */
export interface BotResumeResponse {
  bot_paused: boolean;
  operational_state?: OperationalState;
}

/** POST /portal/conexao/reconectar -> 202. Inicia o restart da sessao. */
export interface ReconectarResponse {
  state: 'restarting';
  poll_after_ms: number;
}

/**
 * POST /portal/conexao/codigo -> 200. Pairing code de 8 digitos "XXXX-XXXX" pra
 * digitar no WhatsApp. Chamar de novo = gerar um codigo NOVO (o anterior cai).
 */
export interface CodigoResponse {
  pairing_code: string; // 'XXXX-XXXX'
  expires_in_seconds: number; // tipicamente 60
  phone_masked: string;
}

/**
 * GET /portal/conexao/qr -> 200. QR como data-URI pronto pra <img>. Quando ja
 * conectado, `qr` vem null com `connected:true`.
 */
export interface QrResponse {
  qr: string | null; // 'data:image/png;base64,...'
  connected?: boolean;
}

/**
 * GET /portal/conexao/status -> poll a cada 2s. Para quando `terminal` = true
 * (chegou num estado final: conectado, ou falha definitiva).
 */
export interface StatusConexaoResponse {
  status: string;
  connected: boolean;
  terminal: boolean;
  operational_state?: OperationalState;
}

// ── Perfil do negocio (portal-perfil.ts — Missão 023 W13) ─────────────────────
//
// Dados do negocio que o cliente edita pelo portal (sem depender do gestao). Seis
// campos string, TODOS podem vir vazios (campo vazio = ""). O slot vem da sessao
// (withTenant) — nunca no body.
//
// CONTRATO (#306, confirmado): o backend usa ENVELOPE `perfil` em GET e PUT.
//   GET /portal/perfil       -> 200 { perfil: PerfilNegocio }
//   PUT /portal/perfil  body =      { perfil: Partial<PerfilNegocio> } (campos opcionais)
//                            -> 200 { ok: true, perfil: PerfilNegocio }
//   erro de validacao        -> 400 { error, issues }
// Regra do PUT: chave ausente no body = nao toca; "" = limpa. Instagram e
// guardado SEM "@" no backend (a normalizacao client casa com isso).

/**
 * Formas de pagamento = SELECAO de opcoes FIXAS (checklist), nao texto livre
 * (SCRUM-23, "selecionar, nao digitar"). Espelha FORMAS_PAGAMENTO_OPCOES do
 * backend (@startap/core/schemas) — manter em sincronia. Lista provisoria do
 * Bruno: pode mudar antes do merge.
 */
export const FORMAS_PAGAMENTO_OPCOES = [
  'Dinheiro',
  'PIX',
  'Cartão de débito',
  'Cartão de crédito',
] as const;

export type FormaPagamentoOpcao = (typeof FORMAS_PAGAMENTO_OPCOES)[number];

export interface PerfilNegocio {
  nome_negocio: string;
  nome_prestador: string;
  telefone_contato: string;
  endereco: string;
  instagram: string;
  /** Subconjunto de FORMAS_PAGAMENTO_OPCOES que o negocio aceita ([] = nenhuma). */
  formas_pagamento: FormaPagamentoOpcao[];
  /**
   * Modo atendente (SCRUM-59). Quando false, o bot NÃO agenda pela agenda do Google:
   * só atende, tira dúvidas e (se houver) manda o link_agendamento. Default true.
   * Só relevante/editável quando a feature `modo_atendente` está ligada pro clone.
   * Opcional: clone sem a feature nunca recebe/envia estes campos.
   */
  agenda_automatica?: boolean;
  /** Link externo de agendamento (Booksy/Trinks/agenda própria...). Opcional. */
  link_agendamento?: string | null;
}

/**
 * GET /portal/perfil -> 200 { perfil, timezone, features }. O `timezone` (IANA) é
 * TOP-LEVEL, FORA do objeto perfil: vem da coluna flow_clones.timezone (não da
 * personalizacao). Opcional: undefined enquanto a portal-api não devolve -> a tela
 * pré-seleciona pelo /portal/status (useTenantTz). O hook usePerfil expõe só
 * `r.perfil` no cache.
 *
 * `features` = flags por-clone calculadas no backend (env MODO_ATENDENTE_SLOTS,
 * NÃO flags globais): só o clone do piloto recebe modo_atendente=true.
 * Ausente/false = a seção gateada (Agendamento) não renderiza (byte-idêntico
 * pros clientes atuais).
 */
export interface PerfilResponse {
  perfil: PerfilNegocio;
  timezone?: string;
  features?: {
    modo_atendente: boolean;
    /**
     * SCRUM-74: o clone tem um Google Calendar UTILIZÁVEL, conectado pelo TIME no
     * gestão (ADR 0024). Só quando true o portal deixa o dono LIGAR o agendamento
     * automático (Switch); false = seção vira CTA "fale com o suporte pra habilitar".
     * AUSENTE/undefined (backend antigo) = tratado como true (retrocompat — não trava
     * clone cujo agendamento já funciona). Ver @/lib/agenda-config#isAgendaConfigurada.
     */
    agenda_configurada?: boolean;
    /**
     * SCRUM-92/#541: gate GLOBAL (não por-clone) da flag PROMPT_BUILDER_ENABLED. Usado
     * pra decidir se a aba "Personalidade" de "Meu atendente" aparece ANTES de navegar
     * (SCRUM-157) — junto com o sinal "tom disponível" (OR resolvido no chamador).
     */
    prompt_builder?: boolean;
    /**
     * SCRUM-101/#541: gate GLOBAL (não por-clone) da flag SANDBOX_ENABLED. Usado pra
     * decidir se a aba "Testar" de "Meu atendente" aparece (SCRUM-157).
     */
    sandbox?: boolean;
  };
  /**
   * WhatsApp da recepção (SCRUM-59 PR-E) = destino dos avisos de lead/escalação ao
   * dono (RAW `alert_owner_phone`, E.164 BR "55DDDNUMERO"). TOP-LEVEL, presente SÓ com
   * features.modo_atendente; null quando não setado. Também é o destino do aviso de
   * desconexão (#390) — um único "número da equipe".
   */
  recepcao_telefone?: string | null;
}

/**
 * Visão FLAT da config de Agendamento (modo atendente), derivada do GET /portal/perfil
 * pela tela "Meu negócio" (features.modo_atendente + perfil.agenda_automatica +
 * perfil.link_agendamento + recepcao_telefone). Ver @/lib/agenda-config.
 */
export interface AgendaConfig {
  modo_atendente: boolean;
  agenda_automatica: boolean;
  link_agendamento: string;
  /** RAW E.164 BR ("55DDDNUMERO") ou "" quando não setado. */
  recepcao_telefone: string;
  /**
   * SCRUM-74: a agenda (Google) já está conectada pelo time (features.agenda_configurada,
   * com retrocompat default TRUE). false = esconde o Switch de auto-habilitar e mostra o
   * CTA de suporte; true = comportamento atual. Normalizado no hook useAgendaConfig.
   */
  agenda_configurada: boolean;
}

/**
 * PUT /portal/perfil -> 200 { ok, perfil, timezone, recepcao_telefone? }. Request body =
 * { perfil, timezone?, recepcao_telefone? } (timezone + recepcao_telefone TOP-LEVEL).
 * Devolve o perfil salvo, o timezone efetivo e (com modo atendente) o telefone vigente.
 */
export interface SavePerfilResponse {
  ok: true;
  perfil: PerfilNegocio;
  timezone?: string;
  recepcao_telefone?: string | null;
}

// ── Lembretes de agendamento (portal-lembretes.ts — config self-service) ──────
//
// O dono liga/desliga o lembrete automático e escolhe QUANDO enviar (uma ou mais
// janelas, em minutos antes do horário). O worker que ENVIA é backend (PR
// companheiro); aqui é só o contrato da config. Escopado por slot da sessão
// (withTenant) — o front nunca envia slot.
//
// CONTRATO CONGELADO (backend constrói em paralelo; se divergir, QA reconcilia):
//   GET   /portal/lembretes -> 200 { enabled, windows_min }
//   PATCH /portal/lembretes body { enabled?, windows_min? } -> 200 (estado novo)
// Janelas permitidas (min antes do agendamento): 1440 (24h), 180 (3h), 120 (2h),
// 60 (1h). A normalização/validação dessas regras vive em @/lib/lembretes (pura,
// testável). Gating: a feature depende dos atendimentos derivados da agenda
// (atend_from_agenda do /auth/me) — sem agenda ativa, não há o que lembrar.

export interface LembretesConfig {
  enabled: boolean;
  /** Janelas (min antes do agendamento). Permitidas: 1440, 180, 120, 60. */
  windows_min: number[];
}

/** Body do PATCH /portal/lembretes — parcial; a UI manda o estado completo. */
export interface LembretesPatch {
  enabled?: boolean;
  windows_min?: number[];
}

// ── Conta Google da agenda (GET /portal/google-conta) ────────────────────────
//
// Credencial da conta Google que o dono usa pra instalar/logar o app Google
// Agenda no celular/computador e receber notificação dos agendamentos. A SENHA já
// vem DECRIPTADA do backend (decryptSecret de @startap/core; formato no banco =
// enc:v2:iv:tag:ciphertext, o MESMO do gcal e do painel-admin). O backend responde
// com header `cache-control: no-store` — o hook NÃO cacheia agressivo.
//
// Gated por GOOGLE_ACCOUNT_PORTAL_ENABLED (default OFF -> 404, tratado como
// feature-off na tela: a seção some). Escopado por slot da sessão (withTenant) — o
// front nunca envia slot. Campos null = feature ON mas sem credencial cadastrada.
//
// ⚠️ A senha NUNCA pode entrar em log (nem em erro) — não logar este objeto.

export interface GoogleContaResponse {
  /** E-mail da conta Google (null = não cadastrado). */
  google_account_email: string | null;
  /** Senha JÁ decriptada server-side (null = não cadastrada). NUNCA logar. */
  google_account_password: string | null;
}

// ── App de gestão: atendimentos + relatórios (ADR 0026, migration 058) ────────
//
// Fase 1 do app de gestão (faturamento + comissão). TODA rota é gated por
// ATENDIMENTOS_ENABLED no backend (404 se OFF) e escopada por slot da sessão
// (withTenant) — o front nunca envia slot. Valores monetários SEMPRE em centavos
// (*_cents). `atendimentos` (Postgres) é a fonte da verdade do dinheiro do cliente
// final; é SEPARADO de client_billing/AbacatePay (nossa mensalidade B2B).

/** Formas de pagamento aceitas pelo POST /portal/atendimentos. */
export type FormaPagamento = 'dinheiro' | 'pix' | 'credito' | 'debito' | 'pacote' | 'outro';

/**
 * Linha de atendimento registrado (201 do POST /portal/atendimentos).
 *
 * GOTCHA: `comissao_pct` volta como STRING (a coluna é NUMERIC no pg e o
 * serializador não converte). Não usar em cálculo no front sem Number(); a UI
 * desta entrega só exibe a linha, não recalcula comissão (o relatório já vem
 * pronto do backend).
 */
export interface AtendimentoRow {
  id: number;
  servico_nome: string | null;
  valor_cents: number;
  desconto_cents: number;
  // O backend permite forma nula (lançamento sem forma informada). Tratar no render.
  forma_pagamento: FormaPagamento | null;
  colaborador_id: number | null;
  comissao_pct: string;
  cliente_nome: string | null;
  cliente_contato: string | null;
  data: string; // 'YYYY-MM-DD'
  created_at: string; // ISO
}

/**
 * Body do POST /portal/atendimentos. Só `valor_cents` é obrigatório. Regra do
 * backend: forma_pagamento==='pacote' ZERA o valor (a UI antecipa isso travando
 * o campo em R$0). `colaborador_id` ausente = SOLO (sem comissão).
 */
export interface CriarAtendimentoBody {
  valor_cents: number;
  servico_nome?: string;
  desconto_cents?: number;
  colaborador_id?: number;
  forma_pagamento?: FormaPagamento;
  cliente_nome?: string;
  cliente_contato?: string;
  data?: string; // 'YYYY-MM-DD'
}

/** 201 do POST /portal/atendimentos. */
export interface CriarAtendimentoResponse {
  ok: true;
  atendimento: AtendimentoRow;
}

// ── Billing derivado da agenda (ADR 0027 Fase C) ─────────────────────────────
//
// O faturamento passa a ser DERIVADO da agenda, em dois baldes:
//   - 'previsao' : eventos FUTUROS    -> receita esperada.
//   - 'faturado' : eventos que já PASSARAM -> realizado.
// Cada linha pode ser EDITADA (valor/forma/serviço/cliente) — editar ≠ excluir; a
// edição é sticky (volta em `dirty_fields`) e marca o badge "Editado". Se o
// atendimento não rolou, REMOVE a linha (soft-delete) e ela some das listas.
//
// CONTRATO CONGELADO (o backend implementa isto em paralelo; se algo divergir no
// fim, QA reconcilia). TODA rota é gated por ATENDIMENTOS_ENABLED + atend_from_agenda
// e escopada por slot da sessão (withTenant). Valores SEMPRE em centavos. Campos
// nullable são `| null` de verdade — render com fallback ("Sem profissional"/"Sem
// forma"), nunca repetir o bug de tipo do #344.

/** Os dois baldes do billing-da-agenda. */
export type AtendimentoBalde = 'previsao' | 'faturado';

/**
 * Linha de atendimento DERIVADA da agenda (GET /portal/atendimentos?balde=...).
 *
 * `origem`:
 *   - 'agenda' : nasceu de um evento da agenda (auto). Sem dirty -> badge "Auto".
 *   - 'manual' : lançado na mão (tela Registrar / walk-in) -> badge "Manual".
 * `dirty_fields`: colunas EDITADAS pelo dono (ex.: ['valor_cents']). Não-vazio =>
 *   a linha foi tocada -> badge "Editado" (sobrepõe Auto/Manual).
 * Campos nullable (`forma_pagamento`, `colaborador_id`, `profissional_nome`,
 *   `cliente_*`, `servico_nome`) podem vir null — render com fallback.
 */
export interface AtendimentoBaldeRow {
  id: number;
  data: string; // 'YYYY-MM-DD'
  inicio_at: string | null; // ISO (início do evento) ou null (sem horário)
  fim_at: string | null; // ISO (fim do evento) ou null
  cliente_nome: string | null;
  cliente_contato: string | null;
  servico_nome: string | null;
  valor_cents: number;
  desconto_cents: number;
  forma_pagamento: FormaPagamento | null;
  colaborador_id: number | null;
  profissional_nome: string | null;
  origem: 'agenda' | 'manual';
  /** Colunas editadas (sticky). Vazio = nunca tocada. */
  dirty_fields: string[];
  status: string;
}

/** 200 do GET /portal/atendimentos?balde=&de=&ate= — linhas do balde + total. */
export interface AtendimentosListResponse {
  atendimentos: AtendimentoBaldeRow[];
  total_cents: number;
}

/**
 * Body do PATCH /portal/atendimentos/:id — editar uma linha. TODOS opcionais
 * (PATCH parcial); a UI só envia o que mudou. O backend devolve a Row atualizada
 * com `dirty_fields` incluindo as colunas tocadas (a edição é sticky).
 */
export interface EditarAtendimentoBody {
  valor_cents?: number;
  desconto_cents?: number;
  forma_pagamento?: FormaPagamento;
  servico_nome?: string;
  cliente_nome?: string;
}

/** 200 do PATCH — a Row atualizada (já com `dirty_fields` novos). */
export interface EditarAtendimentoResponse {
  atendimento: AtendimentoBaldeRow;
}

/**
 * 200 do GET /portal/atendimentos/by-evento/:eventId — resolve a linha de
 * atendimento (mesma Row do balde) a partir do `event_id` da agenda. 404 quando
 * NÃO existe linha pra esse evento (clone individual fora do gate atend_from_agenda,
 * ou evento que ainda não materializou atendimento). A UI usa pra abrir a edição de
 * dinheiro a partir do card da agenda — gated por atend_from_agenda + presença (200).
 *
 * CONTRATO CONGELADO (backend constrói em paralelo). Gated por ATENDIMENTOS_ENABLED
 * + atend_from_agenda e escopado por slot da sessão (withTenant); evento de outro
 * tenant => 404 (anti-IDOR).
 *
 * A resposta É a Row CRUA (sem envelope) — o backend faz `reply.send(row)` direto
 * (portal-atendimentos.ts) e o teste de contrato congela isso (sem chave `atendimento`).
 */
export type AtendimentoByEventoResponse = AtendimentoBaldeRow;

// Relatório de faturamento (GET /portal/relatorios/faturamento?de=&ate=).

export interface FaturamentoPorForma {
  // null = atendimentos sem forma informada (agrupados num bucket "Sem forma").
  forma_pagamento: FormaPagamento | null;
  total_cents: number;
  count: number;
}

export interface FaturamentoPorProfissional {
  // No SOLO (sem colaborador) ambos vêm null — render usa fallback "Sem profissional".
  colaborador_id: number | null;
  profissional_nome: string | null;
  total_cents: number;
  count: number;
}

export interface FaturamentoReport {
  de: string; // 'YYYY-MM-DD'
  ate: string; // 'YYYY-MM-DD'
  total_cents: number;
  count: number;
  ticket_medio_cents: number;
  por_forma_pagamento: FaturamentoPorForma[];
  por_profissional: FaturamentoPorProfissional[];
}

// Relatório de comissão (GET /portal/relatorios/comissao?balde=&de=&ate=). SOLO =
// vazio; só aparece no estabelecimento. O MESMO seletor Previsão|Faturado da tela
// Billing filtra a comissão (balde) — assim o "quanto pagar" acompanha o que está
// sendo olhado (esperado vs realizado). Default balde=faturado no backend.
//
// CONTRATO CONGELADO (backend constrói em paralelo). `comissao_pct` e
// `total_bruto_cents` foram ADICIONADOS pro layout aprovado (bruto · % · comissão).
// Se algo divergir no fim, QA reconcilia.

export interface ComissaoPorProfissional {
  // O backend de comissão filtra colaborador_id IS NOT NULL — id é sempre presente.
  // `profissional_nome` ainda pode vir null (nome apagado); render usa fallback.
  colaborador_id: number;
  profissional_nome: string | null;
  /** Bruto do período (base da comissão) em centavos. */
  total_bruto_cents: number;
  /** % de comissão aplicada (0–100). Pode vir null se não configurada -> fallback "—". */
  comissao_pct: number | null;
  /** Valor da comissão (bruto × pct) em centavos. */
  comissao_cents: number;
  count: number;
}

export interface ComissaoReport {
  de: string; // 'YYYY-MM-DD'
  ate: string; // 'YYYY-MM-DD'
  /** Balde do recorte (espelha o seletor da tela Billing). Pode vir ausente. */
  balde?: AtendimentoBalde;
  total_cents: number;
  por_profissional: ComissaoPorProfissional[];
}

// ── Frases de comando (portal-frases-pausa.ts — modo atendente, SCRUM-59) ─────
//
// Quando a IA e o atendente humano dividem o MESMO número, a recepção digita uma frase
// no próprio chat pra pausar/retomar o assistente. O dono personaliza essas frases
// (elas APARECEM na conversa — o cliente final vê). Escopado por slot da sessão
// (withTenant) — o front nunca envia slot; a query key carrega o slot pra isolar cache.
//
// CONTRATO (backend em paralelo; NÃO mudar — se divergir, PARAR e reportar):
//   GET /portal/frases-pausa -> 200 { frases: FrasePausa[] }        (404 = feature off)
//   PUT /portal/frases-pausa body { frases: FrasePausa[] } -> 200 { frases } (replace-set)
//   Regras: máx 10; keyword 2..80; sem duplicata por (command, keyword normalizada);
//   400 { error } na violação. Gate: features.modo_atendente (GET /portal/perfil).
// A normalização/validação dessas regras vive em @/lib/frases-pausa (pura, testável).

export interface FrasePausa {
  command: 'pause' | 'resume';
  keyword: string;
  enabled: boolean;
}

export interface FrasesPausaResponse {
  frases: FrasePausa[];
}
