import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Config mutável por teste (flag ON/OFF) — mockada ANTES dos imports.
const cfg = vi.hoisted(() => ({
  NODE_ENV: 'test',
  PORTAL_SIGNUP: true,
  PORTAL_SIGNUP_MATRIZ_SLOT: 'teste_barbearia',
  PORTAL_SIGNUP_AMOUNT_CENTS: 9999,
  PORTAL_SIGNUP_RATE_MAX: 3,
  TRIAL_MAX_ATIVOS: 10,
  TS_WEBHOOK_URL: 'http://startap-api:3040/webhooks/waha',
  WAHA_URL: 'http://waha:3000',
  WAHA_API_KEY: 'k',
  PORTAL_BCRYPT_COST: 12,
  PORTAL_SESSION_TTL_SECONDS: 3600,
  PORTAL_COOKIE_SECURE: false,
}));

const mocks = vi.hoisted(() => ({
  findByPhoneHmac: vi.fn(),
  setTrialAwaiting: vi.fn(),
  countActiveTrials: vi.fn(),
  listPortalUsernames: vi.fn(),
  createPortalUser: vi.fn(),
  findPortalUserForAuth: vi.fn(),
  recordSuccessfulLogin: vi.fn(),
  upsertBilling: vi.fn(),
  generateCloneSlot: vi.fn(),
  provisionCloneWithWaha: vi.fn(),
  teardownProvisionedClone: vi.fn(),
  createSession: vi.fn(),
  hash: vi.fn(),
  sendInternalAlert: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: cfg }));
vi.mock('@startap/db', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  trialLedger: {
    findByPhoneHmac: mocks.findByPhoneHmac,
    setTrialAwaiting: mocks.setTrialAwaiting,
    countActiveTrials: mocks.countActiveTrials,
  },
  portalUsers: {
    listPortalUsernames: mocks.listPortalUsernames,
    createPortalUser: mocks.createPortalUser,
    findPortalUserForAuth: mocks.findPortalUserForAuth,
    recordSuccessfulLogin: mocks.recordSuccessfulLogin,
  },
  clientBilling: { upsertBilling: mocks.upsertBilling },
}));
vi.mock('@startap/integrations', () => ({
  provisioning: {
    generateCloneSlot: mocks.generateCloneSlot,
    provisionCloneWithWaha: mocks.provisionCloneWithWaha,
    teardownProvisionedClone: mocks.teardownProvisionedClone,
  },
  internalAlert: {
    sendInternalAlert: mocks.sendInternalAlert,
    // Helpers de mensagem são puros — usa os reais, mas mockados aqui pra não
    // depender do dist. Retornam string previsível.
    msgNovoCadastro: (i: { nomeNegocio: string; slot: string }) =>
      `cadastro ${i.nomeNegocio} ${i.slot}`,
  },
}));
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash, compare: vi.fn() } }));
vi.mock('../lib/session.js', () => ({
  createSession: mocks.createSession,
  destroySession: vi.fn(),
  invalidateOtherUserSessions: vi.fn(),
  getSession: vi.fn(),
  getRedis: vi.fn(),
  closeRedis: vi.fn(),
}));

import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { portalSignupRoutes } from './portal-signup.js';

const SLOT = 'clone_barbearia_do_joao_ab12cd';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'segredo-de-teste-com-32-caracteres!!' });
  await app.register(portalSignupRoutes);
  await app.ready();
  return app;
}

const PAYLOAD = {
  nome_negocio: 'Barbearia do João',
  whatsapp: '(31) 99999-8842',
  senha: 'senhaForte99',
};

beforeEach(() => {
  vi.clearAllMocks();
  cfg.PORTAL_SIGNUP = true;
  cfg.TS_WEBHOOK_URL = 'http://startap-api:3040/webhooks/waha';
  vi.stubEnv('TRIAL_PHONE_PEPPER', 'pepper-de-teste-com-32-caracteres!');

  mocks.findByPhoneHmac.mockResolvedValue(null);
  // Dedup canônica: 'cirilo' não canonicaliza — nunca colide com número.
  mocks.listPortalUsernames.mockResolvedValue([{ id: 1, username: 'cirilo' }]);
  mocks.countActiveTrials.mockResolvedValue(0);
  mocks.teardownProvisionedClone.mockResolvedValue({ wahaDeleted: true, dbDeleted: true });
  mocks.generateCloneSlot.mockReturnValue(SLOT);
  mocks.provisionCloneWithWaha.mockResolvedValue({
    cloneId: 42,
    slot: SLOT,
    sessionName: SLOT,
    wahaStatus: 'STARTING',
    cloneStatus: 'rascunho',
  });
  mocks.hash.mockResolvedValue('$2a$12$hash');
  mocks.createPortalUser.mockResolvedValue({ id: 7, slot: SLOT, username: '553199998842' });
  mocks.upsertBilling.mockResolvedValue({ slot: SLOT });
  mocks.setTrialAwaiting.mockResolvedValue(undefined);
  mocks.findPortalUserForAuth.mockResolvedValue({ id: 7, username: '553199998842' });
  mocks.createSession.mockResolvedValue('sid-novo');
  mocks.sendInternalAlert.mockResolvedValue({ sent: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /auth/signup', () => {
  it('404 com a flag PORTAL_SIGNUP OFF (feature dormente)', async () => {
    cfg.PORTAL_SIGNUP = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(404);
    expect(mocks.provisionCloneWithWaha).not.toHaveBeenCalled();
    await app.close();
  });

  it('201 no caminho feliz: provisiona clone, cria user (login=número), billing R$99,99 e trial awaiting', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      ok: true,
      user: {
        username: '553199998842', // E.164 canônico — número É o login
        display_name: 'Barbearia do João',
        must_change_password: false,
      },
      trial_started: false, // trial SÓ começa no pareamento
    });

    // Provisionamento via módulo compartilhado, matriz do banco, sem override de modelo.
    expect(mocks.provisionCloneWithWaha).toHaveBeenCalledWith(
      expect.objectContaining({
        waha: expect.objectContaining({ webhookUrl: cfg.TS_WEBHOOK_URL }),
      }),
      expect.objectContaining({
        matrizSlot: 'teste_barbearia',
        novoSlot: SLOT,
        sessionName: SLOT,
        telefoneContato: '553199998842',
      }),
    );
    const provInput = mocks.provisionCloneWithWaha.mock.calls[0]?.[1] as {
      personalizacao: Record<string, unknown>;
    };
    expect(provInput.personalizacao).not.toHaveProperty('model');
    expect(provInput.personalizacao).not.toHaveProperty('provider');

    expect(mocks.createPortalUser).toHaveBeenCalledWith(
      expect.objectContaining({
        slot: SLOT,
        username: '553199998842',
        mustChangePassword: false,
      }),
    );
    // Preço default do Bruno (R$99,99); next_due_date NÃO é passado (trial não começou).
    expect(mocks.upsertBilling).toHaveBeenCalledWith(
      expect.objectContaining({ slot: SLOT, amountCents: 9999 }),
    );
    expect(mocks.upsertBilling.mock.calls[0]?.[0]).not.toHaveProperty('nextDueDate');
    expect(mocks.setTrialAwaiting).toHaveBeenCalledWith(SLOT);

    // Auto-login: cookie de sessão httpOnly setado.
    expect(mocks.createSession).toHaveBeenCalled();
    expect(res.headers['set-cookie']).toBeDefined();
    await app.close();
  });

  it('409 trial_ja_usado quando o número já consumiu o teste (soft check, nada é criado)', async () => {
    mocks.findByPhoneHmac.mockResolvedValue({ status: 'consumed', slot: 'clone_outro' });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'trial_ja_usado' });
    expect(mocks.provisionCloneWithWaha).not.toHaveBeenCalled();
    expect(mocks.createPortalUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('número exempt (whitelist interna) passa pelo soft check normalmente', async () => {
    mocks.findByPhoneHmac.mockResolvedValue({ status: 'exempt', slot: null });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(201);
    expect(mocks.provisionCloneWithWaha).toHaveBeenCalled();
    await app.close();
  });

  it('409 conta_ja_existe quando o número já tem conta (username canônico exato)', async () => {
    mocks.listPortalUsernames.mockResolvedValue([{ id: 9, username: '553199998842' }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'conta_ja_existe' });
    expect(mocks.provisionCloneWithWaha).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 conta_ja_existe na colisão CANÔNICA: username legado em forma local (security #268)', async () => {
    // Conta criada manual no gestão com o número SEM DDI e COM o 9º dígito:
    // mesma identidade humana de '(31) 99999-8842' => canônico 553199998842.
    mocks.listPortalUsernames.mockResolvedValue([{ id: 9, username: '31999998842' }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'conta_ja_existe' });
    expect(mocks.provisionCloneWithWaha).not.toHaveBeenCalled();
    expect(mocks.createPortalUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('409 conta_ja_existe na corrida check->INSERT (23505) — COM teardown do clone órfão', async () => {
    const dup = Object.assign(new Error('duplicate key'), { code: '23505' });
    mocks.createPortalUser.mockRejectedValue(dup);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'conta_ja_existe' });
    // Clone provisionado pra nada: compensating teardown (security #268, P2 #5).
    expect(mocks.teardownProvisionedClone).toHaveBeenCalledWith(expect.anything(), {
      slot: SLOT,
      sessionName: SLOT,
    });
    await app.close();
  });

  it('503 trial_lotado quando o teto TRIAL_MAX_ATIVOS é atingido (P0 #2 — DoS de RAM)', async () => {
    mocks.countActiveTrials.mockResolvedValue(10); // teto do cfg = 10
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'trial_lotado' });
    expect(mocks.provisionCloneWithWaha).not.toHaveBeenCalled();
    await app.close();
  });

  it('abaixo do teto segue normal (9 < 10)', async () => {
    mocks.countActiveTrials.mockResolvedValue(9);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it('400 telefone_invalido para número irrecuperável', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { ...PAYLOAD, whatsapp: '12345678' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'telefone_invalido' });
    await app.close();
  });

  it('400 dados_invalidos para senha curta', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { ...PAYLOAD, senha: 'curta' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'dados_invalidos' });
    await app.close();
  });

  it('400 dados_invalidos para campo desconhecido (schema .strict() — security #268)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { ...PAYLOAD, slot: 'clone_injetado' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'dados_invalidos' });
    expect(mocks.provisionCloneWithWaha).not.toHaveBeenCalled();
    await app.close();
  });

  it('503 signup_indisponivel sem TRIAL_PHONE_PEPPER (lazy — boot nunca crashou)', async () => {
    vi.stubEnv('TRIAL_PHONE_PEPPER', '');
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'signup_indisponivel' });
    expect(mocks.provisionCloneWithWaha).not.toHaveBeenCalled();
    await app.close();
  });

  it('503 signup_indisponivel sem TS_WEBHOOK_URL', async () => {
    cfg.TS_WEBHOOK_URL = undefined as unknown as string;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('500 erro_ao_criar_conta quando o provisionamento falha (sem vazar detalhes)', async () => {
    mocks.provisionCloneWithWaha.mockRejectedValue(new Error('pg down'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'erro_ao_criar_conta' });
    expect(mocks.createPortalUser).not.toHaveBeenCalled();
    // Transação do provisionamento já reverteu sozinha: NADA pra teardown aqui.
    expect(mocks.teardownProvisionedClone).not.toHaveBeenCalled();
    await app.close();
  });

  it('falha PÓS-provisionamento (billing) => 500 + teardown do clone órfão (security #268 P2 #5)', async () => {
    mocks.upsertBilling.mockRejectedValue(new Error('pg timeout'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'erro_ao_criar_conta' });
    expect(mocks.teardownProvisionedClone).toHaveBeenCalledWith(expect.anything(), {
      slot: SLOT,
      sessionName: SLOT,
    });
    // Teardown é best-effort: a resposta não muda nem se ele falhar.
    await app.close();
  });

  it('teardown que FALHA não muda a resposta (best-effort, nunca lança)', async () => {
    mocks.upsertBilling.mockRejectedValue(new Error('pg timeout'));
    mocks.teardownProvisionedClone.mockResolvedValue({ wahaDeleted: false, dbDeleted: false });
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'erro_ao_criar_conta' });
    await app.close();
  });

  it('a resposta NUNCA expõe o slot do tenant', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.body).not.toContain(SLOT);
    await app.close();
  });

  // ── Área/vertical no signup (Missão 023 W8) ────────────────────────────────
  it('aceita area válida e passa pro provisioning DENTRO de personalizacao', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { ...PAYLOAD, area: 'manicure' },
    });
    expect(res.statusCode).toBe(201);
    const provInput = mocks.provisionCloneWithWaha.mock.calls[0]?.[1] as {
      personalizacao: Record<string, unknown>;
    };
    expect(provInput.personalizacao).toMatchObject({
      nome_negocio: 'Barbearia do João',
      area: 'manicure',
    });
    await app.close();
  });

  it('sem area no payload -> default seguro "outro" (onboarding antigo não quebra)', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(201);
    const provInput = mocks.provisionCloneWithWaha.mock.calls[0]?.[1] as {
      personalizacao: Record<string, unknown>;
    };
    expect(provInput.personalizacao.area).toBe('outro');
    await app.close();
  });

  it('400 dados_invalidos para area fora da taxonomia (Zod enum recusa)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { ...PAYLOAD, area: 'petshop' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'dados_invalidos' });
    expect(mocks.provisionCloneWithWaha).not.toHaveBeenCalled();
    await app.close();
  });

  it('caminho feliz dispara o alerta interno de novo cadastro', async () => {
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(mocks.sendInternalAlert).toHaveBeenCalledWith(
      expect.stringContaining('Barbearia do João'),
    );
    await app.close();
  });

  it('alerta interno que FALHA não quebra o 201 (fire-and-forget)', async () => {
    // O alerta é a ÚLTIMA coisa, fire-and-forget (void + .catch). Mesmo se rejeitar,
    // o cadastro já está persistido e a resposta 201 tem que sair normal.
    mocks.sendInternalAlert.mockRejectedValue(new Error('Lola caiu'));
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/auth/signup', payload: PAYLOAD });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ok: true, trial_started: false });
    // O cadastro foi de fato persistido (não dependeu do alerta).
    expect(mocks.createPortalUser).toHaveBeenCalled();
    expect(mocks.upsertBilling).toHaveBeenCalled();
    await app.close();
  });
});
