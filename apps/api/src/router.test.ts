import type { WahaWebhookBody } from '@startap/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerBotEntry } from './registry.js';

const mocks = vi.hoisted(() => ({
  logFlowEvent: vi.fn(),
  logMessage: vi.fn(),
  isPaused: vi.fn(),
  isFlowPaused: vi.fn(),
  addFlowPause: vi.fn(),
  addHumanReplyPause: vi.fn(),
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
  // Dedup (ADR 0019): mockado pra nao tocar Redis real nos testes do router.
  checkAndMarkDuplicate: vi.fn(),
  // Modo atendente (SCRUM-59): anti-eco + self-chat mockados pra nao tocar Redis real.
  isBotEcho: vi.fn(),
  isSelfChat: vi.fn(),
  // SCRUM-63: resolução @lid→telefone mockada aqui (foco do router = reagir à identidade
  // resolvida); a lógica real do resolver é testada em lib/lid-resolver.test.ts.
  resolveFromMeIdentity: vi.fn(),
  // SCRUM-58: update de ack de outbound mockado (data layer testada em outbound-messages.test.ts).
  applyAck: vi.fn(),
  // SCRUM-144: store durável de pushName. upsert no inbound; get pra snapshotar na human_reply.
  // Default = promises resolvidas (o router usa .catch()/void — precisa de thenable mesmo após
  // clearAllMocks, que NÃO reseta implementação).
  upsertContactName: vi.fn().mockResolvedValue(undefined),
  getContactName: vi.fn().mockResolvedValue(null),
  // Resolver env→coluna (ADR 0030 D1) mockado como env-only — o router testa o gate por env
  // (process.env.MODO_ATENDENTE_SLOTS); byte-idêntico ao isModoAtendenteEnabled de antes.
  csvGate: (slot: string, csv?: string | null): boolean => {
    if (!csv) return false;
    const e = csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return e.includes('*') || e.includes(slot);
  },
}));

vi.mock('@startap/db', () => ({
  antibot: { logMessage: mocks.logMessage },
  flowControl: { isFlowActive: mocks.isFlowActive },
  flowExecutionLog: { logFlowEvent: mocks.logFlowEvent },
  pausa: {
    isPaused: mocks.isPaused,
    isFlowPaused: mocks.isFlowPaused,
    addFlowPause: mocks.addFlowPause,
    addHumanReplyPause: mocks.addHumanReplyPause,
    removeFlowPause: mocks.removeFlowPause,
    addPause: mocks.addPause,
    removePause: mocks.removePause,
    listFlowPauseKeywords: mocks.listFlowPauseKeywords,
  },
  routing: { findRouting: mocks.findRouting },
  flowClones: {
    getCloneBySession: mocks.getCloneBySession,
    getCloneBySlot: mocks.getCloneBySlot,
    resolveModoAtendenteEnabledForSlot: (slot: string, csv?: string | null) =>
      mocks.csvGate(slot, csv),
  },
  outboundMessages: { applyAck: mocks.applyAck },
  contactNames: {
    upsertContactName: mocks.upsertContactName,
    getContactName: mocks.getContactName,
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
  // canonicalE164 é usado pela blocklist global (lib/bot-blocklist) carregada via
  // router. Reimplementação fiel do essencial (DDI BR + regra do 9º dígito) — o ESM
  // real de @startap/core/phone não resolve no Vitest sem build (ver nota acima).
  canonicalE164: (raw: string): string | null => {
    if (!raw) return null;
    const base = raw.split('@')[0]?.split(':')[0] ?? '';
    let digits = base.replace(/\D/g, '').replace(/^0+/, '');
    if (digits.length < 10 || digits.length > 15) return null;
    if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
    if (digits.startsWith('55')) {
      if (digits.length === 13 && digits[4] === '9') return digits.slice(0, 4) + digits.slice(5);
      if (digits.length === 12 || digits.length === 13) return digits;
      return null;
    }
    return digits;
  },
  // SCRUM-117: máscara de LOG (degrada p/ só a máscara sem LOG_PHONE_PEPPER).
  phoneLogTag: (raw?: string | null): string => {
    if (!raw) return '[no-phone]';
    const d = String(raw).replace(/\D/g, '');
    if (d.length < 4) return '[no-phone]';
    const last2 = d.slice(-2);
    return d.startsWith('55') && d.length >= 12
      ? `+55 ${d.slice(2, 4)} •••••-••${last2}`
      : `+${d.slice(0, 2)} •••••-••${last2}`;
  },
}));

vi.mock('./lib/idempotency.js', () => ({
  checkAndMarkDuplicate: mocks.checkAndMarkDuplicate,
}));

// Modo atendente (SCRUM-59): mocka o helper pra não tocar Redis (isBotEcho/registerBotReplyEcho)
// no teste do router. HUMAN_REPLY_PAUSE_TTL_MS é a constante real (60 min).
vi.mock('./lib/human-reply-pause.js', () => ({
  isBotEcho: mocks.isBotEcho,
  isSelfChat: mocks.isSelfChat,
  HUMAN_REPLY_PAUSE_TTL_MS: 60 * 60 * 1000,
}));

// SCRUM-63: resolução @lid→telefone. Default = passthrough (não-lid): devolve o telefone
// que o extractPhone deu, wasLid=false — mantém TODO teste pré-existente byte-idêntico.
vi.mock('./lib/lid-resolver.js', () => ({
  resolveFromMeIdentity: mocks.resolveFromMeIdentity,
}));

const { handleWebhook } = await import('./router.js');

// Default global do resolver = passthrough (clearAllMocks NÃO reseta implementação).
mocks.resolveFromMeIdentity.mockImplementation((_session: string, _body: unknown, phone: string) =>
  Promise.resolve({ phone, wasLid: false, via: 'not-lid' }),
);

// Flag de dedup (ADR 0019) lida via process.env no router. Acesso por chave
// computada (mesmo padrao do bloco BILLING_OVERDUE_SILENCE) — delete em membro
// estatico dispara lint/performance/noDelete; em membro computado nao.
const DEDUP_ENV_KEY = 'IDEMPOTENCY_DEDUP';
// Gate por-clone do modo atendente (SCRUM-59), lido via process.env no router.
const MODO_ENV_KEY = 'MODO_ATENDENTE_SLOTS';

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
    // Dedup desligado por padrao (flag OFF) e, se chamado, default = nao duplicata.
    delete process.env[DEDUP_ENV_KEY];
    mocks.checkAndMarkDuplicate.mockResolvedValue({ duplicate: false, degraded: false });
    // Modo atendente OFF por padrão (nenhum clone no gate) -> ramo novo nunca entra.
    delete process.env[MODO_ENV_KEY];
    mocks.isBotEcho.mockResolvedValue('human');
    mocks.isSelfChat.mockReturnValue(false);
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

  it('SCRUM-144: INBOUND grava o pushName no store durável (session + telefone), fail-safe', async () => {
    // makeBody() traz _data.pushName='Teste'; a mensagem é do cliente (fromMe=false).
    await handleWebhook(makeBody('TESTE_STARTAP'), { executionId: 'e-inbound', startedAt: 0 });
    expect(mocks.upsertContactName).toHaveBeenCalledWith({
      session: 'TESTE_STARTAP',
      telefone: '553598877248',
      pushName: 'Teste',
    });
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

  // --- Testes: blocklist global de números internos (Missão 023) ---

  it('ignora mensagem do remetente da ALERTAS (553598373138) — não responde, não roteia', async () => {
    // O remetente atual da sessão ALERTAS é o número interno padrão da blocklist.
    mocks.extractPhone.mockReturnValue('553598373138');

    const result = await handleWebhook(makeBody('STARTAP_AI_PROD'), {
      executionId: 'exec-blocklist',
      startedAt: 0,
    });

    expect(result).toEqual({ status: 'ignored:blocklist' });
    // Não chega em antibot, routing nem bot.
    expect(mocks.logMessage).not.toHaveBeenCalled();
    expect(mocks.findRouting).not.toHaveBeenCalled();
    expect(mocks.sendSeen).not.toHaveBeenCalled();
    expect(mocks.logFlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'router.ignored',
        metadata: expect.objectContaining({ reason: 'blocklist' }),
      }),
    );
  });

  it('processa normalmente número do time/teste (553598877248) — NÃO bloqueado', async () => {
    // Número do Bruno/teste: não pode cair na blocklist.
    mocks.extractPhone.mockReturnValue('553598877248');
    stubBot.handle.mockResolvedValue(undefined);

    const result = await handleWebhook(makeBody('startap'), {
      executionId: 'exec-not-blocked',
      startedAt: 0,
    });

    expect(result).toEqual({ status: 'ok' });
    expect(mocks.logMessage).toHaveBeenCalled();
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

describe('handleWebhook — dedup de evento de mensagem (ADR 0019)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[DEDUP_ENV_KEY];
    mocks.logFlowEvent.mockResolvedValue(null);
    mocks.logMessage.mockResolvedValue(undefined);
    mocks.isPaused.mockResolvedValue(false);
    mocks.isFlowPaused.mockResolvedValue(false);
    mocks.isFlowActive.mockResolvedValue(true);
    mocks.findRouting.mockResolvedValue(null);
    mocks.sendSeen.mockResolvedValue(undefined);
    mocks.extractPhone.mockReturnValue('553598877248');
    mocks.isGroupChat.mockReturnValue(false);
    mocks.getCloneBySession.mockResolvedValue(null);
    mocks.getCloneBySlot.mockResolvedValue(null);
    mocks.checkAndMarkDuplicate.mockResolvedValue({ duplicate: false, degraded: false });
    stubBot.handle.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env[DEDUP_ENV_KEY];
  });

  it('flag OFF → NUNCA chama dedup, processa normal (comportamento atual)', async () => {
    const result = await handleWebhook(makeBody('startap'), {
      executionId: 'exec-dedup-off',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.checkAndMarkDuplicate).not.toHaveBeenCalled();
    expect(stubBot.handle).toHaveBeenCalledTimes(1);
  });

  it('flag ON + mensagem nova → processa e marca a chave (sessao, messageId)', async () => {
    process.env[DEDUP_ENV_KEY] = 'true';
    mocks.checkAndMarkDuplicate.mockResolvedValue({ duplicate: false, degraded: false });
    const result = await handleWebhook(makeBody('startap'), {
      executionId: 'exec-dedup-new',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ok' });
    expect(mocks.checkAndMarkDuplicate).toHaveBeenCalledWith('startap', 'msg-1');
    expect(stubBot.handle).toHaveBeenCalledTimes(1);
  });

  it('flag ON + duplicata → PULA (ignored:dedup), nao chama o bot', async () => {
    process.env[DEDUP_ENV_KEY] = 'true';
    mocks.checkAndMarkDuplicate.mockResolvedValue({ duplicate: true, degraded: false });
    const result = await handleWebhook(makeBody('startap'), {
      executionId: 'exec-dedup-dup',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:dedup' });
    expect(stubBot.handle).not.toHaveBeenCalled();
    expect(mocks.logFlowEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'router.ignored' }),
    );
  });

  it('flag ON + Redis down (fail-open: degraded, nao duplicata) → processa mesmo assim', async () => {
    process.env[DEDUP_ENV_KEY] = 'true';
    mocks.checkAndMarkDuplicate.mockResolvedValue({ duplicate: false, degraded: true });
    const result = await handleWebhook(makeBody('startap'), {
      executionId: 'exec-dedup-failopen',
      startedAt: 0,
    });
    // FAIL-OPEN: mensagem real do cliente NUNCA dropada por hiccup de Redis.
    expect(result).toEqual({ status: 'ok' });
    expect(stubBot.handle).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// SCRUM-59 — ramo fromMe do MODO ATENDENTE ("mesmo número IA + atendente").
// Pausa automática por resposta humana (TTL) + anti-eco + self-chat. GATED por-clone.
// ---------------------------------------------------------------------------
describe('handleWebhook — fromMe modo atendente (SCRUM-59)', () => {
  const MEDUZZA = 'clone_meduzza_barbearia_q23psc';

  function fromMeBody(text: string): WahaWebhookBody {
    const body = makeBody('TESTE_STARTAP');
    body.payload!.fromMe = true;
    body.payload!.body = text;
    return body;
  }

  function meduzzaRoute() {
    return {
      id: 42,
      telefone: '553598877248',
      workflow_id: MEDUZZA,
      workflow_name: 'meduzza',
      webhook_url: 'http://api/webhooks/waha',
      nome_cliente: 'Cliente',
      ativo: true,
      criado_em: new Date(),
      atualizado_em: new Date(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logFlowEvent.mockResolvedValue(null);
    mocks.logMessage.mockResolvedValue(undefined);
    mocks.addFlowPause.mockResolvedValue(undefined);
    mocks.addHumanReplyPause.mockResolvedValue(undefined);
    mocks.removeFlowPause.mockResolvedValue(undefined);
    mocks.addPause.mockResolvedValue(undefined);
    mocks.removePause.mockResolvedValue(undefined);
    // SCRUM-144: por padrão o store não tem nome (snapshot=null); upsert é no-op resolvido.
    mocks.getContactName.mockResolvedValue(null);
    mocks.upsertContactName.mockResolvedValue(undefined);
    mocks.extractPhone.mockReturnValue('553598877248');
    mocks.isGroupChat.mockReturnValue(false);
    mocks.getCloneBySession.mockResolvedValue(null);
    mocks.getCloneBySlot.mockResolvedValue({ cliente_telefone: '5511977776666' });
    mocks.findRouting.mockResolvedValue(meduzzaRoute());
    // Nenhuma frase casa por padrão (frase que não aparece na mensagem de teste).
    mocks.listFlowPauseKeywords.mockResolvedValue([
      {
        flow_id: MEDUZZA,
        command: 'pause',
        keyword: 'atendente aqui!!',
        keyword_norm: 'atendenteaqui!!',
        enabled: true,
        updated_at: new Date(),
      },
    ]);
    mocks.isBotEcho.mockResolvedValue('human');
    mocks.isSelfChat.mockReturnValue(false);
    // SCRUM-63: default = passthrough não-lid (identity.phone === telefone do extractPhone).
    mocks.resolveFromMeIdentity.mockImplementation(
      (_session: string, _body: unknown, phone: string) =>
        Promise.resolve({ phone, wasLid: false, via: 'not-lid' }),
    );
    delete process.env[DEDUP_ENV_KEY];
    process.env[MODO_ENV_KEY] = MEDUZZA;
  });

  afterEach(() => {
    delete process.env[MODO_ENV_KEY];
  });

  it('resposta HUMANA à mão (não-keyword, não-eco) → pausa human_reply com TTL', async () => {
    const result = await handleWebhook(fromMeBody('ja te respondo, so um instante'), {
      executionId: 'exec-human-reply',
      startedAt: 0,
    });

    expect(result).toEqual({ status: 'ok:human-reply-pause' });
    // human_reply usa addHumanReplyPause (guarda N1: nunca rebaixa permanente) — NÃO addFlowPause.
    expect(mocks.addHumanReplyPause).toHaveBeenCalledTimes(1);
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
    const arg = mocks.addHumanReplyPause.mock.calls[0]![0] as {
      flowId: string;
      telefone: string;
      expiresAt: Date;
    };
    expect(arg.flowId).toBe(MEDUZZA);
    expect(arg.telefone).toBe('553598877248');
    // TTL ~ agora + 60 min (tolerância larga pra não flakar).
    expect(arg.expiresAt).toBeInstanceOf(Date);
    const deltaMs = arg.expiresAt.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(59 * 60 * 1000);
    expect(deltaMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
  });

  it('SCRUM-144: snapshota contact_name do STORE (não do pushName fromMe) pelo telefone do contato', async () => {
    // O store durável (populado pelo INBOUND) tem o nome do CONTATO — não o do dono do fromMe.
    mocks.getContactName.mockResolvedValue('Dona Meduzza');
    await handleWebhook(fromMeBody('ja te respondo'), { executionId: 'e-name', startedAt: 0 });

    // Lookup escopado pela SESSION (body.session) + telefone DO CONTATO (atendenteTelefone),
    // nunca pelo pushName do evento fromMe (que seria o nome do dono).
    expect(mocks.getContactName).toHaveBeenCalledWith({
      session: 'TESTE_STARTAP',
      telefone: '553598877248',
    });
    const arg = mocks.addHumanReplyPause.mock.calls[0]![0] as { contactName?: string | null };
    expect(arg.contactName).toBe('Dona Meduzza');
  });

  it('cada resposta humana RENOVA (novo upsert com expiresAt adiante)', async () => {
    await handleWebhook(fromMeBody('primeiro toque'), { executionId: 'e1', startedAt: 0 });
    await handleWebhook(fromMeBody('segundo toque'), { executionId: 'e2', startedAt: 0 });
    // Dois upserts human_reply (renovação = novo addHumanReplyPause com expires_at novo).
    expect(mocks.addHumanReplyPause).toHaveBeenCalledTimes(2);
    for (const call of mocks.addHumanReplyPause.mock.calls) {
      expect((call[0] as { expiresAt: Date }).expiresAt).toBeInstanceOf(Date);
    }
  });

  it('ECO do próprio bot (fromMe) → NÃO pausa (ignored:fromMe)', async () => {
    mocks.isBotEcho.mockResolvedValue('echo');
    const result = await handleWebhook(fromMeBody('mensagem que o bot mesmo enviou'), {
      executionId: 'exec-echo',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
  });

  it('ECO cujo texto CONTÉM keyword → keyword é PULADA (não comanda/pausa)', async () => {
    mocks.isBotEcho.mockResolvedValue('echo');
    const result = await handleWebhook(fromMeBody('atendente aqui!! (frase dentro do eco)'), {
      executionId: 'exec-echo-keyword',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
  });

  it('SELF-CHAT (msg pro próprio número) → ignored:fromMe:self-chat, não pausa', async () => {
    mocks.isSelfChat.mockReturnValue(true);
    const result = await handleWebhook(fromMeBody('eco do alerta de lead'), {
      executionId: 'exec-self-chat',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe:self-chat' });
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    // Nem chega a consultar as frases (retorna antes do keyword match).
    expect(mocks.listFlowPauseKeywords).not.toHaveBeenCalled();
  });

  it('KEYWORD humana continua funcionando (pausa manual source=fromMe, sem TTL)', async () => {
    const result = await handleWebhook(fromMeBody('atendente aqui!!'), {
      executionId: 'exec-keyword',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ok:manual-pause' });
    // Keyword usa applyFlowManualCommand -> addFlowPause (permanente); NUNCA human_reply.
    expect(mocks.addFlowPause).toHaveBeenCalledTimes(1);
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    const arg = mocks.addFlowPause.mock.calls[0]![0] as { source: string; expiresAt?: Date };
    // Pausa manual/keyword é PERMANENTE (source fromMe, sem expiresAt) — não é human_reply.
    expect(arg.source).toBe('fromMe');
    expect(arg.expiresAt ?? null).toBeNull();
  });

  it('Redis DEGRADED → fail-safe: NÃO auto-pausa (keyword ainda roda, mas sem match aqui)', async () => {
    mocks.isBotEcho.mockResolvedValue('degraded');
    const result = await handleWebhook(fromMeBody('resposta qualquer nao-keyword'), {
      executionId: 'exec-degraded',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
  });

  it('clone FORA do gate → byte-idêntico: fromMe não-keyword vira ignored:fromMe, SEM pausa', async () => {
    delete process.env[MODO_ENV_KEY]; // nenhum clone no gate
    const result = await handleWebhook(fromMeBody('resposta humana num clone normal'), {
      executionId: 'exec-nao-gated',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    // Caminho legado: nunca cria pausa; isBotEcho/isSelfChat/addHumanReplyPause nem são chamados.
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.isBotEcho).not.toHaveBeenCalled();
    expect(mocks.isSelfChat).not.toHaveBeenCalled();
  });

  // ── SCRUM-63 — contato migrado (@lid): identidade resolvida ANTES das decisões ──
  // Pseudo-número do lid que o extractPhone devolveria pra um contato migrado.
  const LID_PSEUDO = '100206033039600';
  // Telefone REAL (E.164) pro qual o lid resolve — o que a marca de eco/pausa usa.
  const REAL_PN = '5519981018908';

  it('SCRUM-63: ECO do bot por @lid (marca sob o PN) → echo, NÃO pausa + usa o PN resolvido', async () => {
    mocks.extractPhone.mockReturnValue(LID_PSEUDO); // extractPhone cai no pseudo-lid
    mocks.resolveFromMeIdentity.mockResolvedValue({ phone: REAL_PN, wasLid: true, via: 'payload' });
    mocks.isBotEcho.mockResolvedValue('echo');
    const result = await handleWebhook(fromMeBody('resposta que o bot mesmo enviou'), {
      executionId: 'exec-lid-echo',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    // A decisão de eco roda sob o PN RESOLVIDO (não o pseudo-lid) — é o que casa a marca.
    expect(mocks.isBotEcho).toHaveBeenCalledWith('TESTE_STARTAP', REAL_PN, expect.any(String));
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
  });

  it('SCRUM-63: resposta MANUAL real por @lid → pausa criada sob o PN E.164 (feature restaurada)', async () => {
    mocks.extractPhone.mockReturnValue(LID_PSEUDO);
    mocks.resolveFromMeIdentity.mockResolvedValue({ phone: REAL_PN, wasLid: true, via: 'rest' });
    mocks.isBotEcho.mockResolvedValue('human');
    const result = await handleWebhook(fromMeBody('ja te respondo, so um instante'), {
      executionId: 'exec-lid-human',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ok:human-reply-pause' });
    expect(mocks.addHumanReplyPause).toHaveBeenCalledTimes(1);
    const arg = mocks.addHumanReplyPause.mock.calls[0]![0] as { telefone: string };
    // A pausa NASCE sob o telefone REAL, nunca sob o pseudo-número do lid.
    expect(arg.telefone).toBe(REAL_PN);
    expect(arg.telefone).not.toBe(LID_PSEUDO);
  });

  it('SCRUM-63: @lid NÃO resolvido (API erro + cache vazio) → NENHUMA pausa + fail-safe', async () => {
    mocks.extractPhone.mockReturnValue(LID_PSEUDO);
    mocks.resolveFromMeIdentity.mockResolvedValue({ phone: null, wasLid: true, via: 'none' });
    const result = await handleWebhook(fromMeBody('resposta manual num contato migrado'), {
      executionId: 'exec-lid-unresolved',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe:lid-unresolved' });
    // Fail-safe: retorna ANTES de self-chat/eco/keyword; NUNCA cria linha em flow_pauses.
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
    expect(mocks.isSelfChat).not.toHaveBeenCalled();
    expect(mocks.isBotEcho).not.toHaveBeenCalled();
    expect(mocks.listFlowPauseKeywords).not.toHaveBeenCalled();
  });

  it('SCRUM-63: SELF-SEND eco por @lid (resolve pro próprio número) → self-chat ignora, não pausa', async () => {
    mocks.extractPhone.mockReturnValue(LID_PSEUDO);
    mocks.resolveFromMeIdentity.mockResolvedValue({
      phone: '5511977776666',
      wasLid: true,
      via: 'payload',
    });
    mocks.isSelfChat.mockReturnValue(true); // 5511977776666 == cliente_telefone do clone
    const result = await handleWebhook(fromMeBody('eco do alerta de lead'), {
      executionId: 'exec-lid-self',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe:self-chat' });
    // self-chat avaliado com o número RESOLVIDO, não o pseudo-lid.
    expect(mocks.isSelfChat).toHaveBeenCalledWith('5511977776666', '5511977776666');
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SCRUM-68 Onda 4 — pausa por RESPOSTA HUMANA à mão nos formatos de AGENDA (dragon/
// Cirilo/Samuel), gated por HUMAN_REPLY_AGENDA_SLOTS. Clone FORA do modo atendente
// (MODO_ATENDENTE_SLOTS não o cobre) → cai no ramo AGENDA byte-idêntico; só o novo gate
// adiciona a human_reply de 60min.
// ─────────────────────────────────────────────────────────────────────────────
describe('handleWebhook — fromMe ramo AGENDA / human-reply (SCRUM-68 Onda 4)', () => {
  const DRAGON = 'clone_barber_dragon_caly8b';
  const HR_ENV_KEY = 'HUMAN_REPLY_AGENDA_SLOTS';

  function fromMeBody(text: string): WahaWebhookBody {
    const body = makeBody('TESTE_STARTAP');
    body.payload!.fromMe = true;
    body.payload!.body = text;
    return body;
  }

  function dragonRoute() {
    return {
      id: 7,
      telefone: '553598877248',
      workflow_id: DRAGON,
      workflow_name: 'dragon',
      webhook_url: 'http://api/webhooks/waha',
      nome_cliente: 'Cliente',
      ativo: true,
      criado_em: new Date(),
      atualizado_em: new Date(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logFlowEvent.mockResolvedValue(null);
    mocks.logMessage.mockResolvedValue(undefined);
    mocks.addFlowPause.mockResolvedValue(undefined);
    mocks.addHumanReplyPause.mockResolvedValue(undefined);
    mocks.removeFlowPause.mockResolvedValue(undefined);
    mocks.extractPhone.mockReturnValue('553598877248');
    mocks.isGroupChat.mockReturnValue(false);
    mocks.getCloneBySession.mockResolvedValue(null);
    mocks.getCloneBySlot.mockResolvedValue({ cliente_telefone: '5511977776666' });
    mocks.findRouting.mockResolvedValue(dragonRoute());
    // Nenhuma frase casa por padrão (frase que não aparece na mensagem de teste).
    mocks.listFlowPauseKeywords.mockResolvedValue([
      {
        flow_id: DRAGON,
        command: 'pause',
        keyword: 'atendente aqui!!',
        keyword_norm: 'atendenteaqui!!',
        enabled: true,
        updated_at: new Date(),
      },
    ]);
    mocks.isBotEcho.mockResolvedValue('human');
    mocks.isSelfChat.mockReturnValue(false);
    mocks.resolveFromMeIdentity.mockImplementation(
      (_session: string, _body: unknown, phone: string) =>
        Promise.resolve({ phone, wasLid: false, via: 'not-lid' }),
    );
    delete process.env[DEDUP_ENV_KEY];
    // MODO atendente OFF (dragon não está no gate de modo) -> entra no ramo AGENDA.
    delete process.env[MODO_ENV_KEY];
    // Gate da Onda 4 ON pro dragon (piloto).
    process.env[HR_ENV_KEY] = DRAGON;
  });

  afterEach(() => {
    delete process.env[HR_ENV_KEY];
  });

  it('gate OFF → BYTE-IDÊNTICO: fromMe não-keyword vira ignored:fromMe, sem pausa nem eco', async () => {
    delete process.env[HR_ENV_KEY]; // gate vazio/não-setado
    const result = await handleWebhook(fromMeBody('ja te respondo, so um instante'), {
      executionId: 'exec-agenda-off',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    // Caminho legado intacto: NENHUMA leitura de identidade/eco/self-chat, NENHUMA pausa.
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
    expect(mocks.resolveFromMeIdentity).not.toHaveBeenCalled();
    expect(mocks.isBotEcho).not.toHaveBeenCalled();
    expect(mocks.isSelfChat).not.toHaveBeenCalled();
  });

  it('gate OFF (env vazia "") → BYTE-IDÊNTICO igual ao não-setado', async () => {
    process.env[HR_ENV_KEY] = '';
    const result = await handleWebhook(fromMeBody('resposta humana num clone normal'), {
      executionId: 'exec-agenda-empty',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.isBotEcho).not.toHaveBeenCalled();
    expect(mocks.isSelfChat).not.toHaveBeenCalled();
  });

  it('gate ON → resposta HUMANA à mão (não-keyword, não-eco) cria human_reply de 60min', async () => {
    const result = await handleWebhook(fromMeBody('ja te respondo, so um instante'), {
      executionId: 'exec-agenda-human',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ok:human-reply-pause' });
    // human_reply usa addHumanReplyPause (guarda: nunca rebaixa permanente) — NÃO addFlowPause.
    expect(mocks.addHumanReplyPause).toHaveBeenCalledTimes(1);
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
    const arg = mocks.addHumanReplyPause.mock.calls[0]![0] as {
      flowId: string;
      telefone: string;
      expiresAt: Date;
    };
    expect(arg.flowId).toBe(DRAGON);
    expect(arg.telefone).toBe('553598877248');
    expect(arg.expiresAt).toBeInstanceOf(Date);
    const deltaMs = arg.expiresAt.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(59 * 60 * 1000);
    expect(deltaMs).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
  });

  it('gate ON → KEYWORD segue criando pausa INDETERMINADA (source=fromMe, sem TTL) — não muda', async () => {
    const result = await handleWebhook(fromMeBody('atendente aqui!!'), {
      executionId: 'exec-agenda-keyword',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ok:manual-pause' });
    // Keyword usa applyFlowManualCommand -> addFlowPause (permanente); NUNCA human_reply.
    expect(mocks.addFlowPause).toHaveBeenCalledTimes(1);
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    const arg = mocks.addFlowPause.mock.calls[0]![0] as { source: string; expiresAt?: Date };
    expect(arg.source).toBe('fromMe');
    expect(arg.expiresAt ?? null).toBeNull();
    // Keyword casou ANTES de qualquer decisão de eco (byte-idêntico ao ramo agenda de hoje).
    expect(mocks.isBotEcho).not.toHaveBeenCalled();
  });

  it('gate ON → ECO do próprio bot (isBotEcho=echo) NÃO pausa (ignored:fromMe)', async () => {
    mocks.isBotEcho.mockResolvedValue('echo');
    const result = await handleWebhook(fromMeBody('mensagem que o bot mesmo enviou'), {
      executionId: 'exec-agenda-echo',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
  });

  it('gate ON → Redis DEGRADED → fail-safe: NÃO auto-pausa (ignored:fromMe)', async () => {
    mocks.isBotEcho.mockResolvedValue('degraded');
    const result = await handleWebhook(fromMeBody('resposta qualquer nao-keyword'), {
      executionId: 'exec-agenda-degraded',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
  });

  it('gate ON → SELF-CHAT (msg pro próprio número) → ignored:fromMe:self-chat, não pausa', async () => {
    mocks.isSelfChat.mockReturnValue(true);
    const result = await handleWebhook(fromMeBody('eco do alerta de lead'), {
      executionId: 'exec-agenda-self',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe:self-chat' });
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.addFlowPause).not.toHaveBeenCalled();
    // Self-chat avaliado ANTES do eco (não chega a consultar isBotEcho).
    expect(mocks.isBotEcho).not.toHaveBeenCalled();
  });

  it('gate ON → @lid NÃO resolvido → ignored:fromMe:lid-unresolved, fail-safe sem pausa', async () => {
    mocks.extractPhone.mockReturnValue('100206033039600'); // pseudo-lid
    mocks.resolveFromMeIdentity.mockResolvedValue({ phone: null, wasLid: true, via: 'none' });
    const result = await handleWebhook(fromMeBody('resposta manual num contato migrado'), {
      executionId: 'exec-agenda-lid-unresolved',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe:lid-unresolved' });
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    // Fail-safe: retorna ANTES de self-chat/eco.
    expect(mocks.isSelfChat).not.toHaveBeenCalled();
    expect(mocks.isBotEcho).not.toHaveBeenCalled();
  });

  it('gate ON → resposta MANUAL por @lid resolvido → pausa sob o PN E.164 (não o pseudo-lid)', async () => {
    const REAL_PN = '5519981018908';
    mocks.extractPhone.mockReturnValue('100206033039600'); // pseudo-lid
    mocks.resolveFromMeIdentity.mockResolvedValue({ phone: REAL_PN, wasLid: true, via: 'rest' });
    mocks.isBotEcho.mockResolvedValue('human');
    const result = await handleWebhook(fromMeBody('ja te respondo, so um instante'), {
      executionId: 'exec-agenda-lid-human',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ok:human-reply-pause' });
    expect(mocks.addHumanReplyPause).toHaveBeenCalledTimes(1);
    const arg = mocks.addHumanReplyPause.mock.calls[0]![0] as { telefone: string };
    expect(arg.telefone).toBe(REAL_PN);
    // A decisão de eco roda sob o PN resolvido, não o pseudo-lid.
    expect(mocks.isBotEcho).toHaveBeenCalledWith('TESTE_STARTAP', REAL_PN, expect.any(String));
  });

  it('gate ON pra OUTRO slot → dragon fora do gate = byte-idêntico (ignored:fromMe, sem pausa)', async () => {
    process.env[HR_ENV_KEY] = 'clone_outro_qualquer'; // dragon NÃO está no gate
    const result = await handleWebhook(fromMeBody('resposta humana fora do gate'), {
      executionId: 'exec-agenda-other-slot',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:fromMe' });
    expect(mocks.addHumanReplyPause).not.toHaveBeenCalled();
    expect(mocks.isBotEcho).not.toHaveBeenCalled();
    expect(mocks.resolveFromMeIdentity).not.toHaveBeenCalled();
  });
});

// SCRUM-58 — ramo message.ack (rastreio de ENTREGA), gated por MESSAGE_ACK_TRACKING_ENABLED.
describe('handleWebhook — message.ack (SCRUM-58)', () => {
  const ACK_ENV_KEY = 'MESSAGE_ACK_TRACKING_ENABLED';

  function ackBody(over: Record<string, unknown> = {}): WahaWebhookBody {
    return {
      event: 'message.ack',
      session: 'cirilo',
      payload: {
        id: 'true_5511999998888@c.us_WAMID1',
        from: '5511999998888@c.us',
        fromMe: true,
        ack: 2,
        ackName: 'DEVICE',
        ...over,
      },
    } as unknown as WahaWebhookBody;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.logFlowEvent.mockResolvedValue(null);
    delete process.env[ACK_ENV_KEY];
    mocks.applyAck.mockResolvedValue({
      message_id: 'true_5511999998888@c.us_WAMID1',
      session: 'cirilo',
      slot: 'clone_cirilo',
      ack_status: 'DEVICE',
      ack_code: 2,
    });
  });

  it('flag OFF → byte-idêntico: ack cai no filtro NON_INCOMING (ignored:event), sem applyAck', async () => {
    const result = await handleWebhook(ackBody(), { executionId: 'e', startedAt: 0 });
    expect(result).toEqual({ status: 'ignored:event' });
    expect(mocks.applyAck).not.toHaveBeenCalled();
  });

  it('flag ON + DEVICE (entregue) → atualiza status, ok:ack-device', async () => {
    process.env[ACK_ENV_KEY] = 'true';
    const result = await handleWebhook(ackBody({ ack: 2, ackName: 'DEVICE' }), {
      executionId: 'e',
      startedAt: 0,
    });
    expect(mocks.applyAck).toHaveBeenCalledWith({
      messageId: 'true_5511999998888@c.us_WAMID1',
      ackCode: 2,
      ackName: 'DEVICE',
    });
    expect(result).toEqual({ status: 'ok:ack-device' });
  });

  it('flag ON + nack/463 (ack -1) → status terminal', async () => {
    process.env[ACK_ENV_KEY] = 'true';
    mocks.applyAck.mockResolvedValue({
      message_id: 'x',
      session: 'cirilo',
      slot: 'clone_cirilo',
      ack_status: 'ERROR',
      ack_code: -1,
    });
    const result = await handleWebhook(ackBody({ ack: -1, ackName: 'ERROR' }), {
      executionId: 'e',
      startedAt: 0,
    });
    expect(mocks.applyAck).toHaveBeenCalledWith({
      messageId: expect.any(String),
      ackCode: -1,
      ackName: 'ERROR',
    });
    expect(result).toEqual({ status: 'ok:ack-error' });
  });

  it('flag ON + read (ack 3) NÃO dispara nada de negativo — só marca READ', async () => {
    process.env[ACK_ENV_KEY] = 'true';
    mocks.applyAck.mockResolvedValue({
      message_id: 'x',
      session: 'cirilo',
      slot: 'clone_cirilo',
      ack_status: 'READ',
      ack_code: 3,
    });
    const result = await handleWebhook(ackBody({ ack: 3, ackName: 'READ' }), {
      executionId: 'e',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ok:ack-read' });
  });

  it('flag ON + mensagem desconhecida (applyAck null) → ignored:ack-unknown', async () => {
    process.env[ACK_ENV_KEY] = 'true';
    mocks.applyAck.mockResolvedValue(null);
    const result = await handleWebhook(ackBody(), { executionId: 'e', startedAt: 0 });
    expect(result).toEqual({ status: 'ignored:ack-unknown' });
  });

  it('flag ON + fromMe=false (ack de mensagem recebida) → ignora, sem applyAck', async () => {
    process.env[ACK_ENV_KEY] = 'true';
    const result = await handleWebhook(ackBody({ fromMe: false }), {
      executionId: 'e',
      startedAt: 0,
    });
    expect(result).toEqual({ status: 'ignored:ack-not-outbound' });
    expect(mocks.applyAck).not.toHaveBeenCalled();
  });

  it('flag ON + payload sem id → ignored:ack-unparseable, sem applyAck', async () => {
    process.env[ACK_ENV_KEY] = 'true';
    const body = {
      event: 'message.ack',
      session: 'cirilo',
      payload: { ack: 2 },
    } as unknown as WahaWebhookBody;
    const result = await handleWebhook(body, { executionId: 'e', startedAt: 0 });
    expect(result).toEqual({ status: 'ignored:ack-unparseable' });
    expect(mocks.applyAck).not.toHaveBeenCalled();
  });

  it('flag ON + erro no applyAck → fail-safe ignored:ack-error (não quebra o webhook)', async () => {
    process.env[ACK_ENV_KEY] = 'true';
    mocks.applyAck.mockRejectedValue(new Error('pg down'));
    const result = await handleWebhook(ackBody(), { executionId: 'e', startedAt: 0 });
    expect(result).toEqual({ status: 'ignored:ack-error' });
  });
});
