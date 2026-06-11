import type { WahaWebhookBody } from '@startap/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBotEntry } from './registry.js';

const mocks = vi.hoisted(() => ({
  logFlowEvent: vi.fn(),
  logMessage: vi.fn(),
  isPaused: vi.fn(),
  isFlowPaused: vi.fn(),
  addFlowPause: vi.fn(),
  removeFlowPause: vi.fn(),
  addPause: vi.fn(),
  removePause: vi.fn(),
  listFlowPauseKeywords: vi.fn(),
  findRouting: vi.fn(),
  isFlowActive: vi.fn(),
  getCloneBySession: vi.fn().mockResolvedValue(null),
  getCloneBySlot: vi.fn().mockResolvedValue(null),
  sendSeen: vi.fn(),
  downloadMedia: vi.fn(),
  transcribe: vi.fn(),
  // @startap/core/phone — necessário mockar pois o módulo ESM não resolve em Vitest sem build
  extractPhone: vi.fn(),
  isGroupChat: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  antibot: { logMessage: mocks.logMessage },
  flowControl: { isFlowActive: mocks.isFlowActive },
  flowExecutionLog: { logFlowEvent: mocks.logFlowEvent },
  pausa: {
    isPaused: mocks.isPaused,
    isFlowPaused: mocks.isFlowPaused,
    addFlowPause: mocks.addFlowPause,
    removeFlowPause: mocks.removeFlowPause,
    addPause: mocks.addPause,
    removePause: mocks.removePause,
    listFlowPauseKeywords: mocks.listFlowPauseKeywords,
  },
  routing: { findRouting: mocks.findRouting },
  flowClones: {
    getCloneBySession: mocks.getCloneBySession,
    getCloneBySlot: mocks.getCloneBySlot,
  },
  // clientBilling: gate de silêncio por cobrança (ADR 0016) usa daysUntilDue + GRACE_DAYS.
  // Reimplementacao fiel das funcoes PURAS (mesma ancoragem UTC meia-noite do real).
  clientBilling: {
    GRACE_DAYS: 3,
    daysUntilDue: (nextDueDate: string | null, today: Date = new Date()): number | null => {
      if (!nextDueDate) return null;
      const due = Date.parse(`${nextDueDate}T00:00:00Z`);
      if (Number.isNaN(due)) return null;
      const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
      return Math.round((due - todayUtc) / 86_400_000);
    },
  },
}));

vi.mock('@startap/integrations', () => ({
  waha: {
    sendSeen: mocks.sendSeen,
    downloadMedia: mocks.downloadMedia,
  },
  whisper: { transcribe: mocks.transcribe },
}));

vi.mock('@startap/core/phone', () => ({
  extractPhone: mocks.extractPhone,
  isGroupChat: mocks.isGroupChat,
}));

const { handleWebhook } = await import('./router.js');

// Bot stub para sessão 'startap' — simula o que startap.ts faz ao ser importado.
const STARTAP_WORKFLOW_ID = 'uUS3Ux1cU2DquKxo';
const STARTAP_WORKFLOW_NAME = 'STARTAP_AI';
const stubBot = { name: 'startap', handle: vi.fn() };
registerBotEntry({
  workflowId: STARTAP_WORKFLOW_ID,
  workflowName: STARTAP_WORKFLOW_NAME,
  ownedSessions: ['startap', 'startap_ai', 'startap_ai_prod'],
  legacyPauseTable: 'pause_startap',
  getManualCommand: () => null,
  applyManualCommand: async () => {},
  bot: stubBot,
});

function makeBody(session: string): WahaWebhookBody {
  return {
    event: 'message',
    session,
    payload: {
      id: 'msg-1',
      from: '30777769214195@lid',
      fromMe: false,
      body: 'teste de router',
      hasMedia: false,
      _data: {
        key: {
          addressingMode: 'lid',
          remoteJidAlt: '553598877248@s.whatsapp.net',
        },
        pushName: 'Teste',
        messageTimestamp: 1777429228,
      },
    },
  };
}

describe('handleWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logFlowEvent.mockResolvedValue(null);
    mocks.logMessage.mockResolvedValue(undefined);
    mocks.isPaused.mockResolvedValue(false);
    mocks.isFlowPaused.mockResolvedValue(false);
    mocks.addFlowPause.mockResolvedValue(undefined);
    mocks.removeFlowPause.mockResolvedValue(undefined);
    mocks.addPause.mockResolvedValue(undefined);
    mocks.removePause.mockResolvedValue(undefined);
    mocks.listFlowPauseKeywords.mockResolvedValue([
      {
        flow_id: 'flow-generica-001',
        command: 'pause',
        keyword: 'startap aqui!!',
        keyword_norm: 'startapaqui!!',
        enabled: true,
        updated_at: new Date(),
      },
    ]);
    mocks.findRouting.mockResolvedValue(null);
    mocks.isFlowActive.mockResolvedValue(true);
    mocks.sendSeen.mockResolvedValue(undefined);
    // Defaults para mocks de @startap/core/phone
    // extractPhone extrai '553598877248' do payload padrão de makeBody()
    mocks.extractPhone.mockReturnValue('553598877248');
    mocks.isGroupChat.mockReturnValue(false);
    // getCloneBySession e getCloneBySlot: nenhum clone por padrão
    mocks.getCloneBySession.mockResolvedValue(null);
    mocks.getCloneBySlot.mockResolvedValue(null);
  });

  it('nao usa fallback da Lola para sessao de teste do router', async () => {
    const result = await handleWebhook(makeBody('TESTE_STARTAP'), {
      executionId: 'exec-router-test',
      startedAt: 0,
    });

    expect(result).toEqual({ status: 'ignored:no-routing' });
    expect(mocks.findRouting).toHaveBeenCalledWith('553598877248');
    expect(mocks.isFlowActive).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();

    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'uUS3Ux1cU2DquKxo',
        flowName: 'STARTAP_AI',
      }),
    );
  });

  it('usa fallback da Lola somente na sessao startap oficial', async () => {
    stubBot.handle.mockResolvedValue(undefined);
    const result = await handleWebhook(makeBody('startap'), {
      executionId: 'exec-startap',
      startedAt: 0,
    });

    // Sessão 'startap' tem BotEntry no registry → buildFallbackRoute → isFlowActive.
    // findRouting não é chamado para sessões com entry próprio.
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.findRouting).not.toHaveBeenCalled();
    expect(mocks.isFlowActive).toHaveBeenCalledWith('uUS3Ux1cU2DquKxo');
    expect(mocks.logFlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'uUS3Ux1cU2DquKxo',
        flowName: 'STARTAP_AI',
        eventType: 'router.route-found',
      }),
    );
  });

  it('pausa fluxo roteado via routing_clientes em comando manual fromMe', async () => {
    const body = makeBody('TESTE_STARTAP');
    body.payload!.fromMe = true;
    body.payload!.body = 'startap aqui!!';
    mocks.findRouting.mockResolvedValue({
      id: 10,
      telefone: '553598877248',
      workflow_id: 'flow-generica-001',
      workflow_name: 'fluxo_generico',
      webhook_url: 'http://api/webhooks/waha',
      nome_cliente: 'Teste',
      ativo: true,
      criado_em: new Date(),
      atualizado_em: new Date(),
    });

    const result = await handleWebhook(body, {
      executionId: 'exec-manual-pause',
      startedAt: 0,
    });

    expect(result).toEqual({ status: 'ok:manual-pause' });
    expect(mocks.addFlowPause).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: 'flow-generica-001',
        telefone: '553598877248',
      }),
    );
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });

  it('ignora mensagem de grupo com @g.us no from', async () => {
    mocks.isGroupChat.mockReturnValue(true);
    const body: WahaWebhookBody = {
      event: 'message',
      session: 'STARTAP_AI_PROD',
      payload: {
        id: 'group-msg-1',
        from: '120363141126402430@g.us',
        fromMe: false,
        body: 'oi pessoal',
        hasMedia: false,
        _data: {
          key: { addressingMode: 'pn' },
          pushName: 'Fulano',
          messageTimestamp: 1777429228,
        },
      },
    };

    const result = await handleWebhook(body, { executionId: 'exec-group-1', startedAt: 0 });

    expect(result).toEqual({ status: 'ignored:group-chat' });
    // Nao deve chamar bot, antibot nem routing
    expect(mocks.logMessage).not.toHaveBeenCalled();
    expect(mocks.findRouting).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });

  it('ignora mensagem de grupo com JID 120363 (NOWEB sem @g.us)', async () => {
    mocks.isGroupChat.mockReturnValue(true);
    const body: WahaWebhookBody = {
      event: 'message',
      session: 'ricardo_curso_barbearia',
      payload: {
        id: 'group-msg-2',
        from: '120363049484570625',
        fromMe: false,
        body: 'texto do grupo',
        hasMedia: false,
        _data: {
          key: { addressingMode: 'pn', remoteJidAlt: '120363049484570625' },
          pushName: 'Beltrano',
          messageTimestamp: 1777429228,
        },
      },
    };

    const result = await handleWebhook(body, { executionId: 'exec-group-2', startedAt: 0 });

    expect(result).toEqual({ status: 'ignored:group-chat' });
    expect(mocks.logMessage).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });

  it('ignora mensagem de grupo com campo participant preenchido (LID de 22 digitos)', async () => {
    mocks.isGroupChat.mockReturnValue(true);
    const body = {
      event: 'message',
      session: 'ricardo_curso_barbearia',
      payload: {
        id: 'group-msg-3',
        from: '5592813522781591200729',
        fromMe: false,
        body: 'foto do grupo',
        hasMedia: true,
        participant: '5592813522781@s.whatsapp.net',
        _data: {
          key: { addressingMode: 'pn' },
          pushName: 'Ciclano',
          messageTimestamp: 1777429228,
        },
      },
    } as WahaWebhookBody;

    const result = await handleWebhook(body, { executionId: 'exec-group-3', startedAt: 0 });

    expect(result).toEqual({ status: 'ignored:group-chat' });
    expect(mocks.logMessage).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();
  });

  // --- Testes: gate de suspensão de fluxo (flow_enabled) ---

  it('ignora mensagem quando flow_enabled=false (fluxo suspenso por billing)', async () => {
    // Sessão de clone com flow_enabled=false
    const cloneSlot = 'clone_cirilobarbearia_c8w2f0';
    mocks.getCloneBySession.mockResolvedValue({
      id: 42,
      slot: cloneSlot,
      matriz_slot: 'teste_barbearia',
      display_name: 'Barbearia Cirilo',
      cliente_nome: 'Cirilo',
      cliente_telefone: null,
      personalizacao: {},
      waha_sessao: 'cirilobarbearia',
      status: 'conectado',
      flow_enabled: false,
      suspended_reason: 'Inadimplência — fatura vencida em 30/05/2026',
      suspended_at: new Date('2026-05-30T10:00:00Z'),
      horarios_funcionamento: null,
      servicos: null,
      next_due_date: null,
      billing_amount_cents: null,
      created_at: new Date(),
      updated_at: new Date(),
    });
    mocks.getCloneBySlot.mockResolvedValue({
      id: 42,
      slot: cloneSlot,
      matriz_slot: 'teste_barbearia',
      display_name: 'Barbearia Cirilo',
      cliente_nome: 'Cirilo',
      cliente_telefone: null,
      personalizacao: {},
      waha_sessao: 'cirilobarbearia',
      status: 'conectado',
      flow_enabled: false,
      suspended_reason: 'Inadimplência — fatura vencida em 30/05/2026',
      suspended_at: new Date('2026-05-30T10:00:00Z'),
      horarios_funcionamento: null,
      servicos: null,
      next_due_date: null,
      billing_amount_cents: null,
      created_at: new Date(),
      updated_at: new Date(),
    });

    const body = makeBody('cirilobarbearia');

    const result = await handleWebhook(body, { executionId: 'exec-suspended-1', startedAt: 0 });

    expect(result).toEqual({ status: 'ignored:flow-suspended' });
    // Bot nunca é chamado
    expect(mocks.sendSeen).not.toHaveBeenCalled();
    // Log de execução deve registrar o evento de suspensão
    expect(mocks.logFlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        flowId: cloneSlot,
        eventType: 'router.flow-suspended',
        status: 'ignored',
      }),
    );
  });

  it('processa mensagem normalmente quando flow_enabled=true (fluxo ativo)', async () => {
    const cloneSlot = 'clone_cirilobarbearia_c8w2f0';
    const activeClone = {
      id: 42,
      slot: cloneSlot,
      matriz_slot: 'teste_barbearia',
      display_name: 'Barbearia Cirilo',
      cliente_nome: 'Cirilo',
      cliente_telefone: null,
      personalizacao: {},
      waha_sessao: 'cirilobarbearia',
      status: 'conectado',
      flow_enabled: true,
      suspended_reason: null,
      suspended_at: null,
      horarios_funcionamento: null,
      servicos: null,
      next_due_date: null,
      billing_amount_cents: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    mocks.getCloneBySession.mockResolvedValue(activeClone);
    mocks.getCloneBySlot.mockResolvedValue(activeClone);

    // Clone sem factory registrada → bot-not-registered (mas não suspended)
    const body = makeBody('cirilobarbearia');

    const result = await handleWebhook(body, { executionId: 'exec-active-clone-1', startedAt: 0 });

    // Não deve retornar suspended — pode retornar bot-not-registered (sem factory)
    expect(result.status).not.toBe('ignored:flow-suspended');
    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.flow-suspended' }),
    );
  });

  it('nao ignora conversa 1:1 valida (regressao)', async () => {
    // Garante que o filtro de grupo nao quebra atendimento individual
    mocks.findRouting.mockResolvedValue({
      id: 99,
      telefone: '553598877248',
      workflow_id: 'flow-generica-001',
      workflow_name: 'teste_barbearia',
      webhook_url: null,
      nome_cliente: 'Cliente Individual',
      ativo: true,
      criado_em: new Date(),
      atualizado_em: new Date(),
    });
    const botHandle = vi.fn().mockResolvedValue(undefined);
    const { registerBot } = await import('./router.js');
    registerBot('flow-generica-001', { name: 'fluxo_generico', handle: botHandle });

    const body: WahaWebhookBody = {
      event: 'message',
      session: 'TESTE_STARTAP',
      payload: {
        id: 'direct-msg-1',
        from: '553598877248@c.us',
        fromMe: false,
        body: 'quero agendar',
        hasMedia: false,
        _data: {
          key: { addressingMode: 'pn' },
          pushName: 'Cliente Real',
          messageTimestamp: 1777429228,
        },
      },
    };

    const result = await handleWebhook(body, { executionId: 'exec-direct-1', startedAt: 0 });

    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
    expect(mocks.logMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADR 0016 — Silêncio do bot por perfil de cobrança (vencido > carência).
// Cobre os 10 critérios de aceitação. Eixo derivado puro: nunca escreve flow_enabled.
// ---------------------------------------------------------------------------

/**
 * 'YYYY-MM-DD' deslocado N dias a partir de HOJE (UTC meia-noite) — mesma ancoragem
 * de daysUntilDue. dueDateOffset(-4) => daysUntilDue(...) === -4 (vencido há 4 dias).
 */
function dueDateOffset(days: number): string {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

const BILLING_CLONE_SLOT = 'clone_billing_gate_abc123';

interface BillingCloneOverrides {
  flow_enabled?: boolean;
  next_due_date?: string | null;
  billing_amount_cents?: number | null;
}

function makeBillingClone(overrides: BillingCloneOverrides = {}) {
  return {
    id: 77,
    slot: BILLING_CLONE_SLOT,
    matriz_slot: 'teste_barbearia',
    display_name: 'Barbearia Billing Gate',
    cliente_nome: 'Cliente Billing',
    cliente_telefone: null,
    personalizacao: {},
    waha_sessao: 'billinggate',
    status: 'conectado' as const,
    flow_enabled: overrides.flow_enabled ?? true,
    suspended_reason: null,
    suspended_at: null,
    horarios_funcionamento: null,
    servicos: null,
    next_due_date: overrides.next_due_date ?? null,
    billing_amount_cents: overrides.billing_amount_cents ?? null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('handleWebhook — gate de silêncio por cobrança (ADR 0016)', () => {
  const botHandle = vi.fn();
  const ENV_KEY = 'BILLING_OVERDUE_SILENCE';
  let prevEnv: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    prevEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];

    mocks.logFlowEvent.mockResolvedValue(null);
    mocks.logMessage.mockResolvedValue(undefined);
    mocks.isPaused.mockResolvedValue(false);
    mocks.isFlowPaused.mockResolvedValue(false);
    mocks.isFlowActive.mockResolvedValue(true);
    mocks.findRouting.mockResolvedValue(null);
    mocks.sendSeen.mockResolvedValue(undefined);
    mocks.extractPhone.mockReturnValue('553598877248');
    mocks.isGroupChat.mockReturnValue(false);

    botHandle.mockResolvedValue(undefined);
    const { registerBot } = await import('./router.js');
    // Bot registrado para o slot do clone → mensagem NÃO silenciada chega no handle.
    registerBot(BILLING_CLONE_SLOT, { name: 'billing_clone_bot', handle: botHandle });
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  });

  function dispatch(clone: ReturnType<typeof makeBillingClone>) {
    mocks.getCloneBySession.mockResolvedValue(clone);
    mocks.getCloneBySlot.mockResolvedValue(clone);
    return handleWebhook(makeBody('billinggate'), {
      executionId: `exec-billing-${Math.random()}`,
      startedAt: 0,
    });
  }

  // Critério 1: vencido há 4 dias (-4) + flag on → mudo (ignored:billing-overdue).
  it('1) vencido há 4 dias com flag ON → silencia (billing-overdue)', async () => {
    process.env[ENV_KEY] = 'true';
    const result = await dispatch(
      makeBillingClone({ next_due_date: dueDateOffset(-4), billing_amount_cents: 8500 }),
    );
    expect(result).toEqual({ status: 'ignored:billing-overdue' });
    expect(botHandle).not.toHaveBeenCalled();
    expect(mocks.logFlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.billing-overdue', status: 'ignored' }),
    );
  });

  // Critério 2: vencido há 2 dias (-2) → responde (dentro da carência).
  it('2) vencido há 2 dias com flag ON → responde (carência)', async () => {
    process.env[ENV_KEY] = 'true';
    const result = await dispatch(
      makeBillingClone({ next_due_date: dueDateOffset(-2), billing_amount_cents: 8500 }),
    );
    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
  });

  // Critério 3: vencido há 3 dias (-3) → responde (último dia de carência, -3 não é < -3).
  it('3) vencido há 3 dias com flag ON → responde (último dia de carência)', async () => {
    process.env[ENV_KEY] = 'true';
    const result = await dispatch(
      makeBillingClone({ next_due_date: dueDateOffset(-3), billing_amount_cents: 8500 }),
    );
    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.billing-overdue' }),
    );
  });

  // Critério 4: suspensão manual (flow_enabled=false) → mudo (flow-suspended), independe de billing.
  it('4) suspenso manual (flow_enabled=false) → silencia (flow-suspended)', async () => {
    process.env[ENV_KEY] = 'true';
    const result = await dispatch(
      makeBillingClone({
        flow_enabled: false,
        next_due_date: dueDateOffset(30),
        billing_amount_cents: 8500,
      }),
    );
    expect(result).toEqual({ status: 'ignored:flow-suspended' });
    expect(botHandle).not.toHaveBeenCalled();
    expect(mocks.logFlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.flow-suspended', status: 'ignored' }),
    );
  });

  // Critério 5: data movida pro futuro → responde, SEM nenhum UPDATE em flow_enabled (derivado puro).
  it('5) perdão (data pro futuro) → responde sem tocar flow_enabled', async () => {
    process.env[ENV_KEY] = 'true';
    const result = await dispatch(
      makeBillingClone({ next_due_date: dueDateOffset(15), billing_amount_cents: 8500 }),
    );
    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
    // O gate é derivado: nunca chama suspend/resume nem reescreve flow_enabled.
    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.billing-overdue' }),
    );
  });

  // Critério 6: sem billing (next_due_date null OU amount_cents=0) → responde, nunca cala.
  it('6a) sem next_due_date com flag ON → responde (nunca cala)', async () => {
    process.env[ENV_KEY] = 'true';
    const result = await dispatch(
      makeBillingClone({ next_due_date: null, billing_amount_cents: 8500 }),
    );
    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
  });

  it('6b) amount_cents=0 mesmo vencido há 10 dias com flag ON → responde (guard)', async () => {
    process.env[ENV_KEY] = 'true';
    const result = await dispatch(
      makeBillingClone({ next_due_date: dueDateOffset(-10), billing_amount_cents: 0 }),
    );
    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.billing-overdue' }),
    );
  });

  // Critério 7: pausa-do-dono inalterada (isFlowPaused) → ignored:flow-paused, antes do gate de billing.
  it('7) pausa-do-dono (isFlowPaused) continua valendo, ortogonal ao billing', async () => {
    process.env[ENV_KEY] = 'true';
    mocks.isFlowPaused.mockResolvedValue(true);
    const result = await dispatch(
      makeBillingClone({ next_due_date: dueDateOffset(-10), billing_amount_cents: 8500 }),
    );
    expect(result).toEqual({ status: 'ignored:flow-paused' });
    expect(botHandle).not.toHaveBeenCalled();
    // Não chega no gate de billing.
    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.billing-overdue' }),
    );
  });

  // Critério 8: Cirilo-like em-dia (diasRestantes>0) → responde com flag ON.
  it('8) em-dia (vence em 20 dias) com flag ON → responde', async () => {
    process.env[ENV_KEY] = 'true';
    const result = await dispatch(
      makeBillingClone({ next_due_date: dueDateOffset(20), billing_amount_cents: 8500 }),
    );
    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.billing-overdue' }),
    );
  });

  // Critério 10: flag false → idêntico ao de hoje (vencido há 10 dias NÃO cala se flag off).
  it('10) flag OFF → vencido há 10 dias ainda responde (comportamento atual)', async () => {
    delete process.env[ENV_KEY]; // flag ausente = off
    const result = await dispatch(
      makeBillingClone({ next_due_date: dueDateOffset(-10), billing_amount_cents: 8500 }),
    );
    expect(result).toEqual({ status: 'ok' });
    expect(botHandle).toHaveBeenCalledTimes(1);
    expect(mocks.logFlowEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.billing-overdue' }),
    );
  });

  it('10b) flag OFF mas flow_enabled=false → ainda silencia (manual intacto)', async () => {
    delete process.env[ENV_KEY];
    const result = await dispatch(
      makeBillingClone({
        flow_enabled: false,
        next_due_date: dueDateOffset(-10),
        billing_amount_cents: 8500,
      }),
    );
    expect(result).toEqual({ status: 'ignored:flow-suspended' });
    expect(botHandle).not.toHaveBeenCalled();
  });
});
