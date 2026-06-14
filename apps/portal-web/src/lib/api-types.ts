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

export interface LoginResponse {
  ok: true;
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

export interface AuthMe {
  username: string;
  slot: string;
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
  created_at: string; // ISO (serializado de Date)
  updated_at: string;
}

export interface PausasResponse {
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

// ── Status / Home ────────────────────────────────────────────────────────────

export type BillingStatus = 'active' | 'overdue' | 'suspended';

export interface StatusBilling {
  next_due_date: string | null; // 'YYYY-MM-DD'
  dias_restantes: number | null;
  status: BillingStatus;
}

export interface StatusResponse {
  slot: string;
  display_name: string | null;
  flow_enabled: boolean;
  waha: { session: string | null; status: string };
  pausas_ativas: number;
  billing: StatusBilling | null;
}

// ── Agendamentos ─────────────────────────────────────────────────────────────

export interface Agendamento {
  id: string;
  titulo: string;
  inicio: string | null; // ISO ou date
  fim: string | null;
}

export interface AgendamentosResponse {
  gcal_configured: boolean;
  count: number;
  agendamentos: Agendamento[];
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

/** Body do POST /portal/agendamentos (telefone já só dígitos, com DDI). */
export interface CriarAgendamentoBody {
  servico: string;
  data: string; // 'YYYY-MM-DD'
  hora: string; // 'HH:mm'
  cliente_nome: string;
  cliente_telefone?: string;
}

/** 201 do POST — `agendamento` no MESMO shape da lista (prepend otimista ok). */
export interface CriarAgendamentoResponse {
  ok: true;
  agendamento: Agendamento;
}

/** Razões do 409 ({error:'conflito'}) do POST /portal/agendamentos. */
export type ConflitoReason = 'ocupado' | 'horario_passado' | 'fora_do_horario';

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
}

// ── Perfil do negocio (portal-perfil.ts — Missão 023 W13) ─────────────────────
//
// Dados do negocio que o cliente edita pelo portal (sem depender do gestao). Seis
// campos string, TODOS podem vir vazios. O slot vem da sessao (withTenant) — nunca
// no body. GET e PUT compartilham o mesmo shape.

export interface PerfilNegocio {
  nome_negocio: string;
  nome_prestador: string;
  telefone_contato: string;
  endereco: string;
  instagram: string;
  formas_pagamento: string;
}

/** GET /portal/perfil -> 200. PUT envia o mesmo shape e devolve o perfil salvo. */
export type PerfilResponse = PerfilNegocio;
