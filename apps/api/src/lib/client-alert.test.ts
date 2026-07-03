/**
 * Testa o módulo client-alert (Missão 023 W5 — cancelamento escalado).
 *
 * Caminhos cobertos:
 *  - clone sem dono (no_owner) e clone com toggle off (disabled) -> NÃO envia.
 *  - dono OK -> envia 1 sendText pela sessão remetente; resultado {escalado:true}.
 *  - dentro do cooldown -> suprime (anti-flood), NÃO reenvia.
 *  - sender_slot sem waha_sessao -> não envia, degrada gracioso (send_failed).
 *  - falha do sendText -> NÃO lança (fire-and-forget): resultado {ok:false,error}.
 *  - phoneHint mascara (LGPD) e NUNCA chama qualquer delete/GCal (não há import).
 *
 * Mocka @startap/db (queries) e @startap/integrations (waha) + ../config.js.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCloneAlertOwner: vi.fn(),
  getCloneBySlot: vi.fn(),
  getConfig: vi.fn(),
  getSenderSession: vi.fn(),
  getState: vi.fn(),
  upsertState: vi.fn(),
  sendText: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  flowClones: {
    getCloneAlertOwner: mocks.getCloneAlertOwner,
    getCloneBySlot: mocks.getCloneBySlot,
  },
  alerts: {
    getConfig: mocks.getConfig,
    getSenderSession: mocks.getSenderSession,
    getState: mocks.getState,
    upsertState: mocks.upsertState,
  },
}));

vi.mock('@startap/integrations', () => ({
  waha: { sendText: mocks.sendText },
}));

vi.mock('../config.js', () => ({
  config: { CANCELAMENTO_ESCALADO_COOLDOWN_MIN: 30 },
}));

const { sendClientCancellationAlert, sendOwnerAlert, phoneHint } = await import(
  './client-alert.js'
);

function happyPath() {
  mocks.getCloneAlertOwner.mockResolvedValue({
    phone: '5535999991234',
    enabled: true,
    displayName: 'Barbearia do Cirilo',
  });
  mocks.getConfig.mockResolvedValue({ id: 1, sender_slot: 'alertas' });
  mocks.getSenderSession.mockResolvedValue('ALERTAS');
  mocks.getState.mockResolvedValue(null); // nunca alertado -> fora do cooldown
  mocks.upsertState.mockResolvedValue(undefined);
  mocks.sendText.mockResolvedValue(undefined);
}

const baseInput = {
  slot: 'clone_cirilo_x',
  clienteTelefone: '5511988887777',
  motivo: 'imprevisto',
  referenciaHorario: 'amanha 15h',
};

describe('sendClientCancellationAlert', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dono OK + fora do cooldown -> envia 1 sendText e escala', async () => {
    happyPath();
    const r = await sendClientCancellationAlert(baseInput);
    expect(r).toEqual({ ok: true, escalado: true });
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    const arg = mocks.sendText.mock.calls[0][0];
    expect(arg.sessao).toBe('ALERTAS');
    expect(arg.chatId).toBe('5535999991234@c.us');
    // "Digitando" + delay humanizador antes de enviar (anti-derrubada da sessão).
    expect(arg.typing).toBe(true);
    expect(arg.delayMs).toBeGreaterThan(0);
    // Mensagem leva o nome do clone e a referência; cliente vai mascarado (LGPD).
    expect(arg.texto).toContain('Barbearia do Cirilo');
    expect(arg.texto).toContain('amanha 15h');
    expect(arg.texto).toContain(phoneHint(baseInput.clienteTelefone));
    expect(arg.texto).not.toContain(baseInput.clienteTelefone); // telefone cru NUNCA
  });

  it('clone sem dono (phone null) -> não envia, reason no_owner', async () => {
    happyPath();
    mocks.getCloneAlertOwner.mockResolvedValue({
      phone: null,
      enabled: true,
      displayName: 'Clone X',
    });
    const r = await sendClientCancellationAlert(baseInput);
    expect(r).toEqual({ ok: true, escalado: false, reason: 'no_owner' });
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('clone com toggle desligado -> não envia, reason disabled', async () => {
    happyPath();
    mocks.getCloneAlertOwner.mockResolvedValue({
      phone: '5535999991234',
      enabled: false,
      displayName: 'Clone X',
    });
    const r = await sendClientCancellationAlert(baseInput);
    expect(r).toEqual({ ok: true, escalado: false, reason: 'disabled' });
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('dentro do cooldown -> suprime (anti-flood), não reenvia', async () => {
    happyPath();
    mocks.getState.mockResolvedValue({
      check_key: 'x',
      state: 'up',
      down_since: null,
      last_alert_at: new Date(), // agora -> dentro da janela de 30min
      alert_count: 1,
      pending_down_count: 0,
      updated_at: new Date(),
    });
    const r = await sendClientCancellationAlert(baseInput);
    expect(r).toEqual({ ok: true, escalado: false, reason: 'cooldown' });
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('sender_slot sem waha_sessao -> degrada gracioso (send_failed), não envia', async () => {
    happyPath();
    mocks.getSenderSession.mockResolvedValue(null);
    const r = await sendClientCancellationAlert(baseInput);
    expect(r).toEqual({ ok: false, escalado: false, reason: 'send_failed' });
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('falha do sendText NÃO lança (fire-and-forget) -> {ok:false, error}', async () => {
    happyPath();
    mocks.sendText.mockRejectedValue(new Error('WAHA 500'));
    const r = await sendClientCancellationAlert(baseInput);
    expect(r).toEqual({ ok: false, escalado: false, reason: 'error' });
    // não propaga exceção (a chamada acima resolveu sem throw).
  });

  it('phoneHint mascara o número (LGPD)', () => {
    expect(phoneHint('5535999991234')).toBe('5535****1234');
    expect(phoneHint('123')).toBe('***');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// sendOwnerAlert generalizado (SCRUM-59 — modo atendente): kinds + transporte
// ════════════════════════════════════════════════════════════════════════════════

describe('sendOwnerAlert — kinds e transporte', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCloneAlertOwner.mockResolvedValue({
      phone: '5535999991234',
      enabled: true,
      displayName: 'Barbearia do Bene',
    });
    // transporte clone_session usa a sessão do PRÓPRIO clone (waha_sessao).
    mocks.getCloneBySlot.mockResolvedValue({ waha_sessao: 'clone_bene_session' });
    // transporte alertas usa a sessão remetente global.
    mocks.getConfig.mockResolvedValue({ id: 1, sender_slot: 'alertas' });
    mocks.getSenderSession.mockResolvedValue('ALERTAS');
    mocks.getState.mockResolvedValue(null);
    mocks.upsertState.mockResolvedValue(undefined);
    mocks.sendText.mockResolvedValue(undefined);
  });

  it('kind=escalonamento + transport=clone_session -> envia pela sessão DO CLONE', async () => {
    const r = await sendOwnerAlert({
      slot: 'clone_bene_x',
      clienteTelefone: '5511988887777',
      kind: 'escalonamento',
      transport: 'clone_session',
      payload: { motivo: 'reclamacao', resumo: 'cliente insatisfeito com atendimento' },
    });
    expect(r).toEqual({ ok: true, escalado: true });
    expect(mocks.sendText).toHaveBeenCalledTimes(1);
    const arg = mocks.sendText.mock.calls[0][0];
    // transporte = sessão do clone, NÃO a ALERTAS (SPOF 463).
    expect(arg.sessao).toBe('clone_bene_session');
    expect(mocks.getSenderSession).not.toHaveBeenCalled();
    expect(arg.texto).toContain('ESCALADO');
    expect(arg.texto).toContain('reclamacao');
    expect(arg.texto).toContain(phoneHint('5511988887777'));
    expect(arg.texto).not.toContain('5511988887777'); // telefone cru NUNCA
  });

  it('kind=lead + transport=clone_session -> envia resumo do interesse pela sessão do clone', async () => {
    const r = await sendOwnerAlert({
      slot: 'clone_bene_x',
      clienteTelefone: '5511988887777',
      kind: 'lead',
      transport: 'clone_session',
      payload: {
        nome: 'Fred',
        servico: 'Corte + Barba',
        profissional: 'Juliano',
        janela: 'sábado de manhã',
        observacao: 'cliente novo',
      },
    });
    expect(r).toEqual({ ok: true, escalado: true });
    const arg = mocks.sendText.mock.calls[0][0];
    expect(arg.sessao).toBe('clone_bene_session');
    expect(arg.texto).toContain('INTERESSE');
    expect(arg.texto).toContain('Corte + Barba');
    expect(arg.texto).toContain('Juliano');
    expect(arg.texto).toContain('sábado de manhã');
    // resumo do lead vai pro dono; telefone do cliente mascarado (LGPD).
    expect(arg.texto).toContain(phoneHint('5511988887777'));
    expect(arg.texto).not.toContain('5511988887777');
  });

  it('clone_session sem waha_sessao -> send_failed (degrada gracioso), não envia', async () => {
    mocks.getCloneBySlot.mockResolvedValue({ waha_sessao: null });
    const r = await sendOwnerAlert({
      slot: 'clone_bene_x',
      clienteTelefone: '5511988887777',
      kind: 'lead',
      transport: 'clone_session',
      payload: { servico: 'Corte', janela: 'hoje' },
    });
    expect(r).toEqual({ ok: false, escalado: false, reason: 'send_failed' });
    expect(mocks.sendText).not.toHaveBeenCalled();
  });

  it('cooldown é POR KIND: escalonamento em janela NÃO suprime um lead do mesmo cliente', async () => {
    // getState devolve "agora" -> DENTRO da janela para QUALQUER chave.
    mocks.getState.mockResolvedValue({
      check_key: 'x',
      state: 'up',
      down_since: null,
      last_alert_at: new Date(),
      alert_count: 1,
      pending_down_count: 0,
      updated_at: new Date(),
    });
    // Mesmo com estado "recente", como as chaves de kind são distintas o teste garante
    // que o check é feito com chaves diferentes por kind (namespaces isolados).
    await sendOwnerAlert({
      slot: 'clone_bene_x',
      clienteTelefone: '5511988887777',
      kind: 'escalonamento',
      transport: 'clone_session',
      payload: { motivo: 'negociacao', resumo: 'quer desconto' },
    });
    await sendOwnerAlert({
      slot: 'clone_bene_x',
      clienteTelefone: '5511988887777',
      kind: 'lead',
      transport: 'clone_session',
      payload: { servico: 'Corte', janela: 'hoje' },
    });
    const keys = mocks.getState.mock.calls.map((c) => c[0] as string);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain(':escalonamento:');
    expect(keys[1]).toContain(':lead:');
    expect(keys[0]).not.toBe(keys[1]); // chaves distintas -> não se suprimem entre si
  });

  it('cancelamento mantém a chave LEGADA de cooldown (sem segmento de kind)', async () => {
    await sendOwnerAlert({
      slot: 'clone_bene_x',
      clienteTelefone: '5511988887777',
      kind: 'cancelamento',
      transport: 'alertas',
      payload: { motivo: '', referenciaHorario: '' },
    });
    const key = mocks.getState.mock.calls[0][0] as string;
    expect(key).not.toContain(':cancelamento:'); // byte-idêntico ao formato legado
    expect(key).toMatch(/^clientalert:clone_bene_x:[0-9a-f]{12}$/);
  });

  it('sendClientCancellationAlert continua roteando pela ALERTAS (byte-idêntico)', async () => {
    await sendClientCancellationAlert({
      slot: 'clone_bene_x',
      clienteTelefone: '5511988887777',
      motivo: 'viajei',
      referenciaHorario: 'sexta 10h',
    });
    const arg = mocks.sendText.mock.calls[0][0];
    expect(arg.sessao).toBe('ALERTAS'); // transporte alertas, não clone_session
    expect(mocks.getCloneBySlot).not.toHaveBeenCalled();
    expect(arg.texto).toContain('CANCELAMENTO');
  });
});
