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

export type ProductType = 'individual' | 'estabelecimento';

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

export interface PerfilNegocio {
  nome_negocio: string;
  nome_prestador: string;
  telefone_contato: string;
  endereco: string;
  instagram: string;
  formas_pagamento: string;
}

/** GET /portal/perfil -> 200. O perfil vem dentro do envelope `perfil`. */
export interface PerfilResponse {
  perfil: PerfilNegocio;
}

/** PUT /portal/perfil -> 200. Devolve `ok` + o perfil salvo no mesmo envelope. */
export interface SavePerfilResponse {
  ok: true;
  perfil: PerfilNegocio;
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
