/**
 * Testes de GET/PUT /portal/cartao-config (SCRUM-92 inc.2 / ADR 0032 — "UI para todos", 23/07).
 *
 * Invariantes provados:
 *  - gate GLOBAL: CARTAO_RUNTIME_ENABLED OFF → 404 (feature dormente, nem lê o banco);
 *  - GET seed pra BAKED elegível: extrai o cartão atual (bloco) → editable + preview verbatim +
 *    emojis do cartão no picker;
 *  - GET LOCKED pra prompt_custom (Ingrid): editable:false + locked_reason='prompt_custom';
 *  - GET requer_revisao pra extração NÃO-limpa (sem cartão / template): editable:false;
 *  - PUT flipa BAKED→runtime elegível via migrateCloneToCartaoRuntime (snapshot revertível pelo
 *    MESMO --revert), mantém byte-a-byte quando o dono não muda nada (grava verbatim), e grava
 *    { template, emojis } quando muda (dropa o legado);
 *  - PUT bloqueia prompt_custom (409) e não-limpo (422 requer_revisao) — NÃO flipa;
 *  - allowlist FECHADA de emoji server-side intacta; anti-IDOR (slot da SESSÃO, nunca do body).
 *
 * @startap/integrations é REAL (funções puras — fidelidade do preview/allowlist/extração);
 * db/config/tenant mockados (padrão de portal-frases-pausa.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  configMock,
  getCartaoMock,
  getProductTypeMock,
  setConfigMock,
  getPromptMock,
  migrateMock,
  getServicosMock,
  listColabsMock,
} = vi.hoisted(() => ({
  configMock: { CARTAO_RUNTIME_ENABLED: true } as { CARTAO_RUNTIME_ENABLED: boolean },
  getCartaoMock: vi.fn(),
  getProductTypeMock: vi.fn(),
  setConfigMock: vi.fn(),
  getPromptMock: vi.fn(),
  migrateMock: vi.fn(),
  getServicosMock: vi.fn(),
  listColabsMock: vi.fn(),
}));

vi.mock('../config.js', () => ({ config: configMock }));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('@startap/db', () => ({
  cloneColaboradores: {
    getAreaPromptCustomCartao: (...a: unknown[]) => getCartaoMock(...a),
    getProductType: (...a: unknown[]) => getProductTypeMock(...a),
    setCartaoConfigBySlot: (...a: unknown[]) => setConfigMock(...a),
    listBySlot: (...a: unknown[]) => listColabsMock(...a),
  },
  botPrompt: {
    getPrompt: (...a: unknown[]) => getPromptMock(...a),
    migrateCloneToCartaoRuntime: (...a: unknown[]) => migrateMock(...a),
  },
  portalConfig: {
    getServicosBySlot: (...a: unknown[]) => getServicosMock(...a),
  },
}));

const injectedSlot = 'clone_cirilobarbearia_c8w2f0';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 1, username: 'cirilo', sid: 'sid-1' };
    }),
  };
});

import * as promptBuilder from '@startap/integrations/prompt-builder';
import Fastify, { type FastifyInstance } from 'fastify';
import { portalCartaoConfigRoutes } from './portal-cartao-config.js';

// Módulo REAL de @startap/db (não o vi.mock acima — importActual pra pegar a constante do
// sentinela e travar a PARIDADE com @startap/integrations, já que os dois lados duplicam o
// valor de propósito por causa da direção da dependência — ver clone-colaboradores.ts).
const realDb = await vi.importActual<typeof import('@startap/db')>('@startap/db');

// Cartão BAKED "limpo" (bloco estrutural do builder): fronteira clara + trailing → extraível.
const CARTAO_BLOCO = promptBuilder.buildBlocoEstrutural({ modo: 'agenda', area: 'barbearia' });
const PERSONA = 'Você é o Cirilo, atendente da Barbearia do Cirilo. Seja simpático e objetivo.';
const BAKED_PROMPT = `${PERSONA}\n\n${CARTAO_BLOCO}`;

// Formato REAL LEGADO de Cirilo/Samuel/mvs (dump SSH read-only 23/07): seção [CARTAO DE
// CONFIRMACAO] SEM o marcador novo ===== REGRAS. Antes travava em requer_revisao; o fix 23/07
// ("editável pra todos") extrai persona↔cartão byte-a-byte e libera o flip. Emojis do cartão =
// defaults barbearia → seed do picker == defaults → "salvar sem mexer" grava verbatim byte-a-byte.
const PERSONA_TPL = [
  'Voce e o assistente virtual da Barbearia Samuel.',
  'Atenda pelo WhatsApp com simpatia e objetividade. Maximo 3 linhas por resposta.',
  '',
  '[FLUXO OBRIGATORIO]',
  '4. Se estiver -> apresente o CARTAO DE CONFIRMACAO e peca SIM.',
].join('\n');
const CARTAO_TPL = [
  '[CARTAO DE CONFIRMACAO]',
  '💈CARTAO DE CONFIRMACAO💈',
  '──────────────────────',
  '📅 DIA:',
  '⏰ HORARIO:',
  '✂️ SERVICO:',
  '💰 VALOR:',
  '──────────────────────',
  '✅ Responda SIM para confirmar.',
].join('\n');
const BAKED_TEMPLATE_PROMPT = `${PERSONA_TPL}\n\n${CARTAO_TPL}`;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalCartaoConfigRoutes);
  await app.ready();
  return app;
}

function mockClone(over: Record<string, unknown> = {}): void {
  getCartaoMock.mockResolvedValue({
    area: 'barbearia',
    promptCustom: false,
    cartaoMode: 'runtime',
    cartaoConfig: null,
    nomeNegocio: 'Barbearia do Cirilo',
    ...over,
  });
}

describe('GET /portal/cartao-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.CARTAO_RUNTIME_ENABLED = true;
    getProductTypeMock.mockResolvedValue('individual');
    getServicosMock.mockResolvedValue([{ nome: 'Corte', preco_cents: 6500, duracao_min: 30 }]);
    listColabsMock.mockResolvedValue([]);
  });

  it('flag GLOBAL OFF → 404 (feature dormente, nem lê o banco)', async () => {
    configMock.CARTAO_RUNTIME_ENABLED = false;
    mockClone({ cartaoMode: 'runtime' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    expect(res.statusCode).toBe(404);
    expect(getCartaoMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('runtime (cartao_mode runtime) → mode=runtime, editable, defaults + preview', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('runtime');
    expect(body.editable).toBe(true);
    expect(body.locked_reason).toBeNull();
    expect(body.canDisable).toBe(false);
    expect(body.config).toBeNull();
    expect(body.defaults.template).toBe('padrao');
    expect(body.defaults.emojis.marca).toBe('💈');
    expect(body.preview).toContain('inserir_agendamento');
    expect(getCartaoMock).toHaveBeenCalledWith(injectedSlot); // anti-IDOR
    await app.close();
  });

  it('SCRUM-99: previews = EXEMPLO fiel do cartão (layout bonito + "Responda SIM") com nome/serviço reais', async () => {
    mockClone(); // individual, nomeNegocio='Barbearia do Cirilo'
    getServicosMock.mockResolvedValue([{ nome: 'Barba', preco_cents: 5500, duracao_min: 20 }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    const body = res.json();
    // 3 templates renderizados (mesmo convergindo pro mesmo layout — API preservada).
    expect(Object.keys(body.previews).sort()).toEqual(['compacto', 'detalhado', 'padrao']);
    const padrao = body.previews.padrao as string;
    // É o cartão que o cliente RECEBE: nome real em negrito + campo por linha + fechamento.
    expect(padrao).toContain('💈 *Barbearia do Cirilo*');
    expect(padrao).toContain('Dia:');
    expect(padrao).toContain('Serviço: Barba');
    expect(padrao).toContain('Valor: R$ 55,00');
    expect(padrao).toContain('✅ Responda SIM para confirmar.');
    // NÃO é a prévia "elegante" antiga (que usava "Posso confirmar?").
    expect(padrao).not.toContain('Posso confirmar');
    // Individual: sem profissional (bônus SCRUM-100).
    expect(padrao).not.toContain('Profissional');
    // sample carrega os dados reais que semearam o exemplo.
    expect(body.sample.nomeNegocio).toBe('Barbearia do Cirilo');
    expect(body.sample.servico).toBe('Barba');
    expect(body.sample.valor).toBe('R$ 55,00');
    await app.close();
  });

  it('SCRUM-99: estabelecimento inclui a linha do profissional (nome de colaborador real, por último)', async () => {
    mockClone({ cartaoMode: 'runtime' });
    getProductTypeMock.mockResolvedValue('estabelecimento');
    listColabsMock.mockResolvedValue([{ nome: 'Léo', ativo: true }]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    const body = res.json();
    expect(body.previews.padrao).toContain('👤 Profissional: Léo');
    expect(body.previews.padrao).toContain('🕐 Horário:'); // estabelecimento usa 🕐
    expect(body.sample.profissional).toBe('Léo');
    await app.close();
  });

  it('runtime MIGRADO (verbatim): SEED do picker + preview = cartão legado literal', async () => {
    const legado = [
      '[CARTAO DE CONFIRMACAO]',
      '💈 Barbearia do Cirilo',
      '📅 DIA: <dia> / ⏰ HORARIO: <horario> / ✂️ SERVICO: <servico> / 💰 VALOR: <valor>',
      'Responda SIM ✅',
    ].join('\n');
    mockClone({ cartaoConfig: { verbatim: legado } });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    const body = res.json();
    expect(body.preview).toBe(legado);
    expect(body.config.emojis.marca).toBe('💈');
    expect(body.config.emojis.servico).toBe('✂️');
    await app.close();
  });

  it('BAKED elegível (bloco, prompt_custom=false): editable + seed do cartão atual + preview verbatim', async () => {
    mockClone({ cartaoMode: 'baked', cartaoConfig: null });
    getPromptMock.mockResolvedValue(BAKED_PROMPT);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    const body = res.json();
    expect(body.mode).toBe('baked');
    expect(body.editable).toBe(true);
    expect(body.locked_reason).toBeNull();
    // preview = o cartão baked atual (verbatim), byte-a-byte.
    expect(body.preview).toBe(CARTAO_BLOCO);
    // picker semeado com os emojis do cartão atual.
    expect(body.config.emojis.marca).toBe('💈');
    expect(body.config.emojis.servico).toBe('✂️');
    expect(getPromptMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('BAKED template LEGADO (Cirilo/Samuel/mvs): editable + seed + preview verbatim (fim do fale-com-suporte)', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: false });
    getPromptMock.mockResolvedValue(BAKED_TEMPLATE_PROMPT);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    const body = res.json();
    expect(body.mode).toBe('baked');
    expect(body.editable).toBe(true); // ANTES: requer_revisao. AGORA editável.
    expect(body.locked_reason).toBeNull();
    // preview = o cartão legado atual (verbatim), byte-a-byte.
    expect(body.preview).toBe(CARTAO_TPL);
    // picker semeado com os emojis do cartão legado (= defaults barbearia).
    expect(body.config.emojis.marca).toBe('💈');
    expect(body.config.emojis.servico).toBe('✂️');
    await app.close();
  });

  it('BAKED prompt_custom=true (Ingrid) → LOCKED: editable:false, locked_reason=prompt_custom', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: true });
    getPromptMock.mockResolvedValue(BAKED_PROMPT);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    const body = res.json();
    expect(body.mode).toBe('baked');
    expect(body.editable).toBe(false);
    expect(body.locked_reason).toBe('prompt_custom');
    expect(body.config).toBeNull(); // read-only, sem picker
    await app.close();
  });

  it('BAKED sem cartão reconhecível (estab code-injected/persona pura) → requer_revisao: editable:false, preview null', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: false });
    getPromptMock.mockResolvedValue('Só a persona, sem cartão baked reconhecível.');
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config' });
    const body = res.json();
    expect(body.mode).toBe('baked');
    expect(body.editable).toBe(false);
    expect(body.locked_reason).toBe('requer_revisao');
    expect(body.config).toBeNull();
    expect(body.preview).toBeNull();
    await app.close();
  });
});

describe('PUT /portal/cartao-config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.CARTAO_RUNTIME_ENABLED = true;
    getProductTypeMock.mockResolvedValue('individual');
    setConfigMock.mockResolvedValue(true);
    migrateMock.mockResolvedValue({ migrated: true, versionSaved: 3 });
    getServicosMock.mockResolvedValue([{ nome: 'Corte', preco_cents: 6500, duracao_min: 30 }]);
    listColabsMock.mockResolvedValue([]);
  });

  it('flag GLOBAL OFF → 404 (não grava nada)', async () => {
    configMock.CARTAO_RUNTIME_ENABLED = false;
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: {} },
    });
    expect(res.statusCode).toBe(404);
    expect(setConfigMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('runtime: só atualiza config, grava { template, emojis } SEM verbatim, no slot da sessão', async () => {
    mockClone(); // cartaoMode runtime
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'compacto', emojis: { marca: '💇', valor: '💵' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('runtime');
    expect(migrateMock).not.toHaveBeenCalled(); // já runtime → não re-flipa
    expect(setConfigMock).toHaveBeenCalledTimes(1);
    const [slotArg, cfgArg] = setConfigMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(slotArg).toBe(injectedSlot); // nunca do body
    expect(cfgArg).toEqual({ template: 'compacto', emojis: { marca: '💇', valor: '💵' } });
    expect(cfgArg).not.toHaveProperty('verbatim');
    await app.close();
  });

  it('flip-on-customize SEM mudança → grava VERBATIM (byte-a-byte), preview idêntico ao baked', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: false });
    getPromptMock.mockResolvedValue(BAKED_PROMPT);
    const app = await buildApp();
    // Dono salva os valores JÁ semeados (barbearia = defaults) → nada mudou.
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('runtime');
    expect(body.editable).toBe(true);
    // flip via migrate (snapshot revertível pelo MESMO --revert). setConfig NÃO é usado no flip.
    expect(setConfigMock).not.toHaveBeenCalled();
    expect(migrateMock).toHaveBeenCalledTimes(1);
    const arg = migrateMock.mock.calls[0][0] as {
      slot: string;
      personaOnlyPrompt: string;
      cartaoConfig: { verbatim?: string; template?: string };
      editedBy: string;
    };
    expect(arg.slot).toBe(injectedSlot);
    expect(arg.personaOnlyPrompt).toBe(PERSONA);
    expect(arg.editedBy).toBe('portal:cartao-config'); // snapshot achável pelo --revert
    expect(arg.cartaoConfig.verbatim).toBe(CARTAO_BLOCO); // byte-a-byte
    expect(arg.cartaoConfig.template).toBeUndefined();
    // preview do runtime = o cartão legado literal.
    expect(body.preview).toBe(CARTAO_BLOCO);
    await app.close();
  });

  it('flip-on-customize COM mudança → grava { template, emojis } (dropa o legado), flipa', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: false });
    getPromptMock.mockResolvedValue(BAKED_PROMPT);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { marca: '💇' } }, // trocou 💈→💇
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('runtime');
    expect(migrateMock).toHaveBeenCalledTimes(1);
    const arg = migrateMock.mock.calls[0][0] as {
      cartaoConfig: { verbatim?: string; emojis?: Record<string, string> };
    };
    expect(arg.cartaoConfig.verbatim).toBeUndefined(); // legado dropado
    expect(arg.cartaoConfig.emojis).toEqual({ marca: '💇' });
    await app.close();
  });

  it('flip template LEGADO SEM mudança → persona-only correta + VERBATIM byte-a-byte + runtime', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: false });
    getPromptMock.mockResolvedValue(BAKED_TEMPLATE_PROMPT);
    const app = await buildApp();
    // Dono salva os valores JÁ semeados (barbearia = defaults) → nada mudou → grava verbatim.
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('runtime');
    expect(body.editable).toBe(true);
    expect(migrateMock).toHaveBeenCalledTimes(1);
    const arg = migrateMock.mock.calls[0][0] as {
      personaOnlyPrompt: string;
      cartaoConfig: { verbatim?: string; template?: string };
      editedBy: string;
    };
    // persona-only = o prompt SEM o cartão legado (a ref textual do [FLUXO] permanece).
    expect(arg.personaOnlyPrompt).toBe(PERSONA_TPL);
    expect(arg.personaOnlyPrompt).not.toContain('💈CARTAO DE CONFIRMACAO💈');
    // cartão preservado LITERAL → em runtime o cliente vê o MESMO cartão de sempre.
    expect(arg.cartaoConfig.verbatim).toBe(CARTAO_TPL);
    expect(arg.cartaoConfig.template).toBeUndefined();
    expect(arg.editedBy).toBe('portal:cartao-config'); // revertível pelo mesmo --revert
    expect(body.preview).toBe(CARTAO_TPL);
    await app.close();
  });

  it('flip template LEGADO COM mudança → grava { template, emojis } (dropa o legado)', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: false });
    getPromptMock.mockResolvedValue(BAKED_TEMPLATE_PROMPT);
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'compacto', emojis: { valor: '💵' } }, // trocou template + 💰→💵
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe('runtime');
    const arg = migrateMock.mock.calls[0][0] as {
      cartaoConfig: { verbatim?: string; template?: string; emojis?: Record<string, string> };
    };
    expect(arg.cartaoConfig.verbatim).toBeUndefined(); // legado dropado
    expect(arg.cartaoConfig.template).toBe('compacto');
    expect(arg.cartaoConfig.emojis).toEqual({ valor: '💵' });
    await app.close();
  });

  it('flip bloqueado por prompt_custom=true → 409 cartao_bloqueado (não flipa)', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: true });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { marca: '💈' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('cartao_bloqueado');
    expect(res.json().reason).toBe('prompt_custom');
    expect(migrateMock).not.toHaveBeenCalled();
    expect(getPromptMock).not.toHaveBeenCalled(); // nem lê o prompt
    await app.close();
  });

  it('SCRUM-143 fail-closed: reader falha (erro transitório de DB) → 503, NÃO flipa nada', async () => {
    // O reader é chamado com failClosed:true no PUT → RELANÇA no erro → handler devolve 503.
    // Antes (fail-open) devolvia {promptCustom:false} e o guard deixava flipar às cegas.
    getCartaoMock.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { marca: '💈' } },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('estado_indeterminado');
    expect(migrateMock).not.toHaveBeenCalled();
    expect(setConfigMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('flip com extração NÃO-limpa (sem cartão) → 422 requer_revisao (não flipa silencioso)', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: false });
    getPromptMock.mockResolvedValue('Persona sem cartão baked reconhecível.');
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: {} },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('requer_revisao');
    expect(migrateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('corrida: migrate reporta prompt_custom → 409 cartao_bloqueado', async () => {
    mockClone({ cartaoMode: 'baked', promptCustom: false });
    getPromptMock.mockResolvedValue(BAKED_PROMPT);
    migrateMock.mockResolvedValue({ migrated: false, skipped: 'prompt_custom' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: {} },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('prompt_custom');
    await app.close();
  });

  it('tag chars coladas num emoji válido → 400 emoji_invalido (NÃO grava)', async () => {
    mockClone();
    const tagged = `💈${String.fromCodePoint(0xe0067)}`;
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { marca: tagged } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('emoji_invalido');
    expect(res.json().campo).toBe('marca');
    expect(setConfigMock).not.toHaveBeenCalled();
    expect(migrateMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('emoji livre (fora do antigo catálogo curado) é ACEITO — decisão do Bruno, emoji livre', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { valor: '🎩' } },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('texto/letra/dígito não é emoji → 400 emoji_invalido', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { valor: 'DROP TABLE' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().campo).toBe('valor');
    await app.close();
  });

  it('sentinela de DESABILITADO é aceito e persistido tal qual', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { valor: '__off__' } },
    });
    expect(res.statusCode).toBe(200);
    const [, cfgArg] = setConfigMock.mock.calls[0] as [string, Record<string, unknown>];
    expect((cfgArg.emojis as Record<string, string>).valor).toBe('__off__');
    await app.close();
  });

  it('chave de emoji desconhecida → 400', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: { hack: '💈' } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('template inválido → 400 dados_invalidos', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'livre', emojis: {} },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('dados_invalidos');
    await app.close();
  });

  it('campo extra no body (strict) → 400', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/cartao-config',
      payload: { template: 'padrao', emojis: {}, slot: 'outro' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /portal/cartao-config/preview (SCRUM-99 — prévia ao vivo, read-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configMock.CARTAO_RUNTIME_ENABLED = true;
    getProductTypeMock.mockResolvedValue('individual');
    getServicosMock.mockResolvedValue([{ nome: 'Corte', preco_cents: 6500, duracao_min: 30 }]);
    listColabsMock.mockResolvedValue([]);
  });

  it('flag GLOBAL OFF → 404 (feature dormente)', async () => {
    configMock.CARTAO_RUNTIME_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config/preview' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('renderiza os 3 templates com o emoji escolhido (override da query) + serviço real', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/cartao-config/preview?marca=${encodeURIComponent('🌻')}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.previews).sort()).toEqual(['compacto', 'detalhado', 'padrao']);
    // O emoji escolhido pelo dono aparece na prévia (o que ele vê = o que o cliente recebe).
    expect(body.previews.padrao).toContain('🌻 *Barbearia do Cirilo*');
    expect(body.previews.padrao).not.toContain('💈');
    expect(body.previews.padrao).toContain('Serviço: Corte');
    expect(body.previews.padrao).toContain('✅ Responda SIM para confirmar.');
    await app.close();
  });

  it('emoji livre válido na query (fora do antigo catálogo curado) é RENDERIZADO na prévia', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/cartao-config/preview?marca=${encodeURIComponent('🎩')}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().previews.padrao).toContain('🎩');
    expect(res.json().previews.padrao).not.toContain('💈');
    await app.close();
  });

  it('texto malicioso na query → IGNORADO (default da área, prévia nunca quebra/injeta)', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: `/portal/cartao-config/preview?marca=${encodeURIComponent('DROP TABLE')}`,
    });
    expect(res.statusCode).toBe(200);
    // texto arbitrário não é 1 emoji → IGNORADO, cai no default da área (💈).
    expect(res.json().previews.padrao).toContain('💈');
    expect(res.json().previews.padrao).not.toContain('DROP TABLE');
    await app.close();
  });

  it('sentinela de desabilitado na query → prévia mostra a linha SEM o ícone', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/portal/cartao-config/preview?marca=__off__',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().previews.padrao.split('\n')[0]).toBe('*Barbearia do Cirilo*');
  });

  it('previewsSegmentados vem junto (fonte única com previews, os 3 templates)', async () => {
    mockClone();
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/portal/cartao-config/preview' });
    const body = res.json();
    expect(Object.keys(body.previewsSegmentados).sort()).toEqual([
      'compacto',
      'detalhado',
      'padrao',
    ]);
    const juntos = (body.previewsSegmentados.padrao as { valor: string }[])
      .map((s) => s.valor)
      .join('');
    expect(juntos).toBe(body.previews.padrao);
  });

  it('slot vem SEMPRE da sessão (anti-IDOR): a query não nomeia outro clone', async () => {
    mockClone();
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/portal/cartao-config/preview?slot=clone_alheio' });
    // Todo reader foi chamado com o slot da SESSÃO, nunca com o da query.
    expect(getCartaoMock).toHaveBeenCalledWith(injectedSlot);
    expect(getServicosMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });
});

// Este arquivo é o ÚNICO módulo do monorepo que já importa @startap/db E
// @startap/integrations/prompt-builder juntos (os pacotes não podem depender um do outro —
// ciclo). O sentinela de "emoji desabilitado" é duplicado entre os dois de propósito
// (CARTAO_EMOJI_DISABLED_SENTINEL no db, CARTAO_EMOJI_DISABLED em integrations); este teste
// trava a PARIDADE — se alguém mudar um sem o outro, quebra aqui, não silenciosamente em prod.
describe('paridade do sentinela de emoji desabilitado entre @startap/db e @startap/integrations', () => {
  it('CARTAO_EMOJI_DISABLED_SENTINEL (db) === CARTAO_EMOJI_DISABLED (integrations)', () => {
    expect(realDb.cloneColaboradores.CARTAO_EMOJI_DISABLED_SENTINEL).toBe(
      promptBuilder.CARTAO_EMOJI_DISABLED,
    );
  });
});
