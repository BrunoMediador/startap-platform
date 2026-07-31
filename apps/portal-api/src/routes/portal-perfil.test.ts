/**
 * Testes do GET/PUT /portal/perfil (Missao 023 W13 — perfil do negocio).
 *
 * DB mockado (@startap/db). Invariante anti-IDOR: o slot SEMPRE vem da sessao
 * (withTenant), NUNCA do body — mesmo que o cliente mande `slot`/`tenant` no
 * payload, a data layer e chamada com o slot injetado. Validacao Zod real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.js valida process.env no import (cadeia tenant.js -> session.js) — mockamos.
// MUTÁVEL (vi.hoisted) pra testar o gate POR-CLONE de features.modo_atendente (SCRUM-59).
const cfgMock = vi.hoisted(() => ({
  NODE_ENV: 'test',
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  REDIS_PASSWORD: '',
  MODO_ATENDENTE_SLOTS: '',
  FAQ_PERSONALIZADO_SLOTS: '',
  // Globais (não por-slot) — gate das ABAS prompt_builder/sandbox (SCRUM-157). Mutável por teste.
  PROMPT_BUILDER_ENABLED: false,
  SANDBOX_ENABLED: false,
}));
vi.mock('../config.js', () => ({ config: cfgMock }));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const {
  getPerfilBySlotMock,
  updatePerfilBySlotMock,
  getTimezoneBySlotMock,
  updateTimezoneBySlotMock,
  getAlertOwnerPhoneBySlotMock,
  updateAlertOwnerPhoneBySlotMock,
  clearAlertOwnerPhoneBySlotMock,
  isAwaitingAgendaConnectionMock,
  isAgendaConfiguradaBySlotMock,
  csvGateMock,
} = vi.hoisted(() => ({
  getPerfilBySlotMock: vi.fn(),
  updatePerfilBySlotMock: vi.fn(),
  getTimezoneBySlotMock: vi.fn(),
  updateTimezoneBySlotMock: vi.fn(),
  getAlertOwnerPhoneBySlotMock: vi.fn(),
  updateAlertOwnerPhoneBySlotMock: vi.fn(),
  clearAlertOwnerPhoneBySlotMock: vi.fn(),
  isAwaitingAgendaConnectionMock: vi.fn(),
  isAgendaConfiguradaBySlotMock: vi.fn(),
  // Resolver env→coluna (ADR 0030 D1) mockado como env-only — os testes exercitam o gate por
  // env (cfgMock.MODO_ATENDENTE_SLOTS / FAQ_PERSONALIZADO_SLOTS); byte-idêntico ao gate de antes.
  csvGateMock: (slot: string, csv?: string | null): boolean => {
    if (!csv) return false;
    const e = csv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return e.includes('*') || e.includes(slot);
  },
}));
vi.mock('@startap/db', () => ({
  portalConfig: {
    getPerfilBySlot: (...a: unknown[]) => getPerfilBySlotMock(...a),
    updatePerfilBySlot: (...a: unknown[]) => updatePerfilBySlotMock(...a),
  },
  flowClones: {
    getTimezoneBySlot: (...a: unknown[]) => getTimezoneBySlotMock(...a),
    updateTimezoneBySlot: (...a: unknown[]) => updateTimezoneBySlotMock(...a),
    getAlertOwnerPhoneBySlot: (...a: unknown[]) => getAlertOwnerPhoneBySlotMock(...a),
    updateAlertOwnerPhoneBySlot: (...a: unknown[]) => updateAlertOwnerPhoneBySlotMock(...a),
    clearAlertOwnerPhoneBySlot: (...a: unknown[]) => clearAlertOwnerPhoneBySlotMock(...a),
    resolveModoAtendenteEnabledForSlot: (slot: string, csv?: string | null) =>
      csvGateMock(slot, csv),
    resolveFaqPersonalizadoEnabledForSlot: (slot: string, csv?: string | null) =>
      csvGateMock(slot, csv),
    isAwaitingAgendaConnection: (...a: unknown[]) => isAwaitingAgendaConnectionMock(...a),
    isAgendaConfiguradaBySlot: (...a: unknown[]) => isAgendaConfiguradaBySlotMock(...a),
  },
  portalUsers: { getSlotForActivePortalUser: vi.fn() },
}));

// withTenant stub: injeta tenant fixo (slot da sessao). Auth real em tenant.test.ts.
const injectedSlot = 'clone_edu_a1b2c3';
vi.mock('../lib/tenant.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/tenant.js')>('../lib/tenant.js');
  return {
    ...actual,
    withTenant: vi.fn(async (req: { tenant?: unknown }) => {
      req.tenant = { slot: injectedSlot, userId: 7, username: 'dono', sid: 'sid-atual' };
    }),
  };
});

import Fastify, { type FastifyInstance } from 'fastify';
import { portalPerfilRoutes } from './portal-perfil.js';

const PERFIL_OK = {
  nome_negocio: 'Barbearia do Edu',
  nome_prestador: 'Edu',
  telefone_contato: '11999990000',
  endereco: 'Rua X, 1',
  instagram: 'edubarber',
  formas_pagamento: ['Dinheiro', 'PIX'],
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(portalPerfilRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults: fuso vigente do clone (SP) e escrita OK — testes específicos sobrescrevem.
  getTimezoneBySlotMock.mockResolvedValue('America/Sao_Paulo');
  updateTimezoneBySlotMock.mockResolvedValue(true);
  // Default: modo atendente OFF pra todos (byte-a-byte). Testes específicos ligam.
  cfgMock.MODO_ATENDENTE_SLOTS = '';
  // Default: FAQ personalizado OFF pra todos (byte-a-byte). Testes específicos ligam.
  cfgMock.FAQ_PERSONALIZADO_SLOTS = '';
  // Default: prompt_builder/sandbox OFF (byte-a-byte). Testes específicos ligam.
  cfgMock.PROMPT_BUILDER_ENABLED = false;
  cfgMock.SANDBOX_ENABLED = false;
  // Defaults do destino dos avisos: nenhum setado / escrita OK.
  getAlertOwnerPhoneBySlotMock.mockResolvedValue(null);
  updateAlertOwnerPhoneBySlotMock.mockResolvedValue(true);
  clearAlertOwnerPhoneBySlotMock.mockResolvedValue(true);
  // Default: não aguardando agenda (clone conectado / atendente). Testes específicos ligam.
  isAwaitingAgendaConnectionMock.mockResolvedValue(false);
  // Default: agenda NÃO configurada (estado da maioria dos clones — SCRUM-74). Testes ligam.
  isAgendaConfiguradaBySlotMock.mockResolvedValue(false);
});

describe('GET /portal/perfil', () => {
  it('200: devolve o perfil do slot da sessao', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().perfil).toEqual(PERFIL_OK);
    // Anti-IDOR: leitura escopada pelo slot da sessao.
    expect(getPerfilBySlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('404: fluxo nao encontrado', async () => {
    getPerfilBySlotMock.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('200: devolve o timezone (COLUNA) junto do perfil, escopado pelo slot da sessao', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getTimezoneBySlotMock.mockResolvedValue('America/Cuiaba');
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().timezone).toBe('America/Cuiaba');
    expect(getTimezoneBySlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('SCRUM-59: features.modo_atendente=false por default (clientes atuais nao veem a secao)', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features).toEqual({
      modo_atendente: false,
      faq_personalizado: false,
      agenda_configurada: false,
      prompt_builder: false,
      sandbox: false,
    });
    await app.close();
  });

  it('SCRUM-157: features.prompt_builder reflete PROMPT_BUILDER_ENABLED (gate global, não por-clone)', async () => {
    cfgMock.PROMPT_BUILDER_ENABLED = true;
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features.prompt_builder).toBe(true);
    await app.close();
  });

  it('SCRUM-157: features.sandbox reflete SANDBOX_ENABLED (gate global, não por-clone)', async () => {
    cfgMock.SANDBOX_ENABLED = true;
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features.sandbox).toBe(true);
    await app.close();
  });

  it('SCRUM-74: features.agenda_configurada expõe o estado da agenda (false por default)', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    isAgendaConfiguradaBySlotMock.mockResolvedValue(false);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features.agenda_configurada).toBe(false);
    // Anti-IDOR: derivada do slot da SESSÃO, nunca do input.
    expect(isAgendaConfiguradaBySlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('SCRUM-74: features.agenda_configurada=true quando o time já conectou a agenda', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    isAgendaConfiguradaBySlotMock.mockResolvedValue(true);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features.agenda_configurada).toBe(true);
    await app.close();
  });

  it('ADR 0030 D3: aguardando_agenda no payload, escopado pelo slot da sessao (anti-IDOR)', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    isAwaitingAgendaConnectionMock.mockResolvedValue(true);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().aguardando_agenda).toBe(true);
    expect(isAwaitingAgendaConnectionMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('ADR 0030 D3: aguardando_agenda=false quando a agenda ja esta conectada (byte-a-byte)', async () => {
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    isAwaitingAgendaConnectionMock.mockResolvedValue(false);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().aguardando_agenda).toBe(false);
    await app.close();
  });

  it('SCRUM-59: features.modo_atendente=true SO quando o slot da sessao esta no gate', async () => {
    // gate POR-CLONE: liga so pro slot injetado (o do piloto).
    cfgMock.MODO_ATENDENTE_SLOTS = injectedSlot;
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features.modo_atendente).toBe(true);
    await app.close();
  });

  it('SCRUM-59: outro slot no gate NAO liga a feature pro slot da sessao (isolado por-clone)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = 'clone_de_OUTRO_cliente';
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.json().features.modo_atendente).toBe(false);
    await app.close();
  });
});

describe('PUT /portal/perfil', () => {
  it('200: grava perfil valido com o slot da sessao e devolve o canonico', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'Barbearia do Edu', nome_prestador: 'Edu' } },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().perfil).toEqual(PERFIL_OK);
    // slot da SESSAO, nunca do body.
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ nome_negocio: 'Barbearia do Edu', nome_prestador: 'Edu' }),
    );
    await app.close();
  });

  it('anti-IDOR: ignora slot/tenant no body — usa o slot da sessao', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      // `slot` no body deve ser ignorado pelo strict schema (e nunca usado de qq forma).
      payload: { slot: 'clone_de_OUTRO_cliente', perfil: { nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledTimes(1);
    expect(updatePerfilBySlotMock.mock.calls[0][0]).toBe(injectedSlot);
    await app.close();
  });

  it('400: payload invalido (campo extra dentro de perfil — strict)', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X', campo_desconhecido: 'y' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400: tipo invalido (numero em vez de string)', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 123 } },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400: forma de pagamento fora da lista permitida (selecionar, nao digitar)', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { formas_pagamento: ['Boleto'] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('404: update em fluxo inexistente', async () => {
    updatePerfilBySlotMock.mockResolvedValue(false);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('SCRUM-59: aceita agenda_automatica=false SEM link (link OPCIONAL sempre)', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    // sem link_agendamento no payload -> NAO ha 400 (decisao Bruno 03/07).
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: false } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ agenda_automatica: false }),
    );
    await app.close();
  });

  it('SCRUM-59: aceita link_agendamento URL valida; rejeita string nao-URL (400)', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const ok = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: false, link_agendamento: 'https://booksy.com/x' } },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { link_agendamento: 'nao-e-url' } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('perfil invalido');
    await app.close();
  });

  it('P1/SCRUM-75: liga o modo SEM link (link_agendamento "") -> 200 e "" chega ao data layer (limpar)', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    // Fluxo PRIMARIO do piloto (dono sem link, ex.: Raone): o front envia ''.
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: false, link_agendamento: '' } },
    });

    expect(res.statusCode).toBe(200); // antes dava 400 "perfil invalido"
    const dataArg = updatePerfilBySlotMock.mock.calls[0][1] as Record<string, unknown>;
    expect(dataArg.agenda_automatica).toBe(false);
    // SCRUM-75: '' é sentinela de LIMPAR (o data layer apaga a chave do JSONB) — antes o
    // preprocess mapeava pra undefined e "limpar" era no-op silencioso.
    expect(dataArg.link_agendamento).toBe('');
    await app.close();
  });

  it('200: timezone valido grava a COLUNA (updateTimezoneBySlot) escopado ao slot da sessao', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getTimezoneBySlotMock.mockResolvedValue('America/Cuiaba');
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' }, timezone: 'America/Cuiaba' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().timezone).toBe('America/Cuiaba');
    // COLUNA gravada por caminho separado, slot da SESSAO (nunca do body).
    expect(updateTimezoneBySlotMock).toHaveBeenCalledWith(injectedSlot, 'America/Cuiaba');
    // timezone NUNCA vai no personalizacao (perfilSchema) — perfil gravado sem ele.
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.not.objectContaining({ timezone: expect.anything() }),
    );
    await app.close();
  });

  it('400: timezone invalido => timezone_invalido, NAO grava perfil nem coluna', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' }, timezone: 'Marte/Olympus' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('timezone_invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    expect(updateTimezoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('timezone omitido => NAO toca a coluna (byte-identico: mantem o fuso atual)', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updateTimezoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('anti-IDOR: timezone gravado no slot da SESSAO mesmo com slot no body', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: {
        slot: 'clone_de_OUTRO_cliente',
        perfil: { nome_negocio: 'X' },
        timezone: 'America/Cuiaba',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateTimezoneBySlotMock).toHaveBeenCalledTimes(1);
    expect(updateTimezoneBySlotMock.mock.calls[0][0]).toBe(injectedSlot);
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SCRUM-74: religar o agendamento automático (agenda_automatica false→true) NÃO é self-service.
// Só barra a TRANSIÇÃO false→true sem agenda configurada (409). Desligar / true→true / salvar o
// resto do payload seguem intactos. Habilitar = comercial + o time conecta a agenda no gestão.
// ════════════════════════════════════════════════════════════════════════════════

describe('PUT /portal/perfil — gate agenda_automatica false→true (SCRUM-74)', () => {
  it('409: false→true SEM agenda configurada => agenda_nao_configurada, NÃO grava', async () => {
    // Estado atual: agendamento DESLIGADO (modo atendente). Agenda não conectada pelo time.
    getPerfilBySlotMock.mockResolvedValue({ ...PERFIL_OK, agenda_automatica: false });
    isAgendaConfiguradaBySlotMock.mockResolvedValue(false);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: true } },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('agenda_nao_configurada');
    // Recusa ANTES de qualquer escrita (sem write parcial).
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    // Anti-IDOR: agenda checada pelo slot da SESSÃO, nunca do body.
    expect(isAgendaConfiguradaBySlotMock).toHaveBeenCalledWith(injectedSlot);
    await app.close();
  });

  it('200: false→true COM agenda configurada (time já conectou) => grava', async () => {
    getPerfilBySlotMock.mockResolvedValue({ ...PERFIL_OK, agenda_automatica: false });
    isAgendaConfiguradaBySlotMock.mockResolvedValue(true);
    updatePerfilBySlotMock.mockResolvedValue(true);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: true } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ agenda_automatica: true }),
    );
    await app.close();
  });

  it('200: →false (desligar) NUNCA barra — nem checa agenda (salvar o resto segue igual)', async () => {
    getPerfilBySlotMock.mockResolvedValue({ ...PERFIL_OK, agenda_automatica: true });
    isAgendaConfiguradaBySlotMock.mockResolvedValue(false);
    updatePerfilBySlotMock.mockResolvedValue(true);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: false, nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(200);
    // input != true -> nem consulta a agenda.
    expect(isAgendaConfiguradaBySlotMock).not.toHaveBeenCalled();
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ agenda_automatica: false }),
    );
    await app.close();
  });

  it('200: true→true (no-op) passa mesmo SEM agenda configurada (só a transição é barrada)', async () => {
    // Já estava LIGADO: re-salvar não reexige config (ex.: aguardando conexão do time).
    getPerfilBySlotMock.mockResolvedValue({ ...PERFIL_OK, agenda_automatica: true });
    isAgendaConfiguradaBySlotMock.mockResolvedValue(false);
    updatePerfilBySlotMock.mockResolvedValue(true);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: true } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ agenda_automatica: true }),
    );
    await app.close();
  });

  it('anti-IDOR: slot no body é ignorado — a agenda é checada no slot da SESSÃO', async () => {
    getPerfilBySlotMock.mockResolvedValue({ ...PERFIL_OK, agenda_automatica: false });
    isAgendaConfiguradaBySlotMock.mockResolvedValue(false);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { slot: 'clone_de_OUTRO_cliente', perfil: { agenda_automatica: true } },
    });

    expect(res.statusCode).toBe(409);
    expect(isAgendaConfiguradaBySlotMock.mock.calls[0][0]).toBe(injectedSlot);
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Onda 1 de-gate (SCRUM-68 / ADR 0030): recepcao_telefone universal — TODO formato edita o
// destino dos avisos ao dono (= alert_owner_phone). Antes preso ao modo atendente (SCRUM-59/62);
// agora individual/agenda também recebe/salva. Validação (E.164 BR / clear) mantida INTACTA.
// ════════════════════════════════════════════════════════════════════════════════

describe('recepcao_telefone (GET/PUT — universal, todos os formatos)', () => {
  it('GET: expõe recepcao_telefone pra clone INDIVIDUAL (modo atendente OFF) — de-gate', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = ''; // individual/agenda, sem modo atendente
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getAlertOwnerPhoneBySlotMock.mockResolvedValue('5535998877248');
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().recepcao_telefone).toBe('5535998877248');
    expect(getAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot); // anti-IDOR
    await app.close();
  });

  it('GET: também expõe com o modo atendente ON (paridade — não regride)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = injectedSlot;
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getAlertOwnerPhoneBySlotMock.mockResolvedValue('5535998877248');
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().recepcao_telefone).toBe('5535998877248');
    await app.close();
  });

  it('GET: null quando não setado (fallback número da própria sessão — SCRUM-62 intacto)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = ''; // individual
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getAlertOwnerPhoneBySlotMock.mockResolvedValue(null);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().recepcao_telefone).toBeNull();
    await app.close();
  });

  it('PUT: clone INDIVIDUAL (modo OFF) SALVA número válido NORMALIZADO no slot da SESSÃO', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = ''; // de-gate: individual/agenda agora pode setar
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getAlertOwnerPhoneBySlotMock.mockResolvedValue('5535998877248');
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: {}, recepcao_telefone: '+55 (35) 99887-7248' },
    });

    expect(res.statusCode).toBe(200);
    // máscara removida -> só dígitos; slot da SESSÃO (anti-IDOR).
    expect(updateAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot, '5535998877248');
    expect(res.json().recepcao_telefone).toBe('5535998877248');
    await app.close();
  });

  it('PUT: validação SEGUE — não casa E.164 BR (não 55 / curto / longo) => 400, NÃO grava (modo OFF)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = ''; // individual: a validação continua valendo
    const app = await buildApp();

    // Todos têm dígitos mas NÃO casam 55\d{10,11} -> erro real de digitação (não é clear).
    for (const bad of ['11999998888', '5535999', '00998877248', '55119999988881234']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/portal/perfil',
        payload: { perfil: {}, recepcao_telefone: bad },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('telefone_invalido');
    }
    expect(updateAlertOwnerPhoneBySlotMock).not.toHaveBeenCalled();
    expect(clearAlertOwnerPhoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('SCRUM-62 PUT: vazio ("") LIMPA o campo (200 + clear NULL -> fallback sessão) mesmo em individual', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = ''; // individual
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: {}, recepcao_telefone: '' },
    });

    expect(res.statusCode).toBe(200);
    // Vazio = CLEAR (grava NULL, alerta cai no fallback da própria sessão) — NÃO é erro.
    expect(clearAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot);
    expect(updateAlertOwnerPhoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('SCRUM-62 PUT: null também LIMPA o campo (200 + clear)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: {}, recepcao_telefone: null },
    });

    expect(res.statusCode).toBe(200);
    expect(clearAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot);
    expect(updateAlertOwnerPhoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('anti-IDOR: slot no body é ignorado — grava no slot da SESSÃO (modo OFF)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: {
        slot: 'clone_de_OUTRO_cliente',
        perfil: {},
        recepcao_telefone: '5535998877248',
      },
    });

    expect(res.statusCode).toBe(200);
    expect(updateAlertOwnerPhoneBySlotMock.mock.calls[0][0]).toBe(injectedSlot);
    await app.close();
  });

  it('PUT: recepcao_telefone AUSENTE não toca a coluna (byte-a-byte)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updateAlertOwnerPhoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Onda 1 (SCRUM-68 / ADR 0030) — BUG DE CONTRATO front↔back: o save "recepcao-only" do portal
// (useSaveRecepcao) manda { recepcao_telefone } SEM o envelope `perfil`. Os testes acima SEMPRE
// mandavam `perfil: {}` junto (falsa confiança) e mascaravam a regressão: sem `perfil`,
// perfilSchema.safeParse(undefined) dava 400 'perfil invalido' em TODO save recepcao-only, e
// REGREDIA quem editava a recepção pela AgendamentoSection. Estes testes travam o contrato real.
// ════════════════════════════════════════════════════════════════════════════════

describe('PUT recepcao-only SEM envelope `perfil` (contrato useSaveRecepcao — SCRUM-68)', () => {
  it('200: { recepcao_telefone } SEM `perfil` grava o número (perfil tratado como {} — não 400)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = ''; // clone individual (Cirilo/Samuel): sem modo atendente
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getAlertOwnerPhoneBySlotMock.mockResolvedValue('5511999998888');
    const app = await buildApp();

    // Body EXATO do useSaveRecepcao: NENHUMA chave `perfil`.
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { recepcao_telefone: '5511999998888' },
    });

    expect(res.statusCode).toBe(200); // antes: 400 'perfil invalido'
    // Grava o telefone no slot da SESSÃO (anti-IDOR).
    expect(updateAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot, '5511999998888');
    expect(res.json().recepcao_telefone).toBe('5511999998888');
    // `perfil` ausente -> patch vazio {} (no-op no merge), NÃO 400.
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(injectedSlot, {});
    await app.close();
  });

  it('200: máscara removida (dígitos) mesmo sem `perfil` (paridade com o caminho com perfil)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getAlertOwnerPhoneBySlotMock.mockResolvedValue('5535998877248');
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { recepcao_telefone: '+55 (35) 99887-7248' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot, '5535998877248');
    await app.close();
  });

  it('200: recepcao-only SEM `perfil` também no MODO ATENDENTE ON (Meduzza/dragon — não regride)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = injectedSlot; // estabelecimento/modo atendente
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getAlertOwnerPhoneBySlotMock.mockResolvedValue('5511999998888');
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { recepcao_telefone: '5511999998888' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot, '5511999998888');
    await app.close();
  });

  it('200: clear ("") SEM `perfil` LIMPA o campo (200 + clear NULL), não 400', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { recepcao_telefone: '' },
    });

    expect(res.statusCode).toBe(200);
    expect(clearAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot);
    expect(updateAlertOwnerPhoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('400: validação E.164 SEGUE sem `perfil` — número inválido => telefone_invalido, NÃO grava', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    const app = await buildApp();

    // Tem dígitos mas NÃO casa 55\d{10,11}: erro real de digitação (o fix NÃO afrouxa a validação).
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { recepcao_telefone: '11999998888' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('telefone_invalido');
    expect(updateAlertOwnerPhoneBySlotMock).not.toHaveBeenCalled();
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('200: `timezone` SEM `perfil` também é campo top-level processável (perfil tratado como {})', async () => {
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getTimezoneBySlotMock.mockResolvedValue('America/Cuiaba');
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { timezone: 'America/Cuiaba' },
    });

    expect(res.statusCode).toBe(200);
    expect(updateTimezoneBySlotMock).toHaveBeenCalledWith(injectedSlot, 'America/Cuiaba');
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(injectedSlot, {});
    await app.close();
  });

  it('400: body TOTALMENTE vazio {} (sem `perfil`, sem top-level) segue 400 (byte-a-byte, não afrouxa)', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'PUT', url: '/portal/perfil', payload: {} });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    expect(updateAlertOwnerPhoneBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('200: `perfil` + recepcao juntos (AgendamentoSection) segue IDÊNTICO ao de hoje', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = injectedSlot;
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    getAlertOwnerPhoneBySlotMock.mockResolvedValue('5511999998888');
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { agenda_automatica: false }, recepcao_telefone: '5511999998888' },
    });

    expect(res.statusCode).toBe(200);
    // Quem MANDA `perfil` continua parseado como hoje (agenda_automatica preservado no patch).
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ agenda_automatica: false }),
    );
    expect(updateAlertOwnerPhoneBySlotMock).toHaveBeenCalledWith(injectedSlot, '5511999998888');
    await app.close();
  });

  it('400: `perfil: {}` explícito com campo extra segue 400 (semântica de quem manda perfil intocada)', async () => {
    const app = await buildApp();

    // `perfil` PRESENTE e inválido (campo desconhecido no strict) -> 400, como hoje. A tolerância
    // do fix cobre SÓ a AUSÊNCIA de `perfil`, nunca um `perfil` presente e inválido.
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { campo_desconhecido: 'y' }, recepcao_telefone: '5511999998888' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// Onda 1 de-gate (SCRUM-68 / ADR 0030): planos_beneficios universal. O backend PUT já aceitava
// a chave via perfilSchema (sem gate) e o bot já a renderiza em [NEGOCIO] pra todos (free-slots).
// Estes testes travam a regressão: individual/agenda (modo OFF) salva planos; validação segue.
// ════════════════════════════════════════════════════════════════════════════════

describe('planos_beneficios (universal, todos os formatos)', () => {
  it('PUT: clone INDIVIDUAL (modo OFF) SALVA planos_beneficios (200)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    cfgMock.FAQ_PERSONALIZADO_SLOTS = '';
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { planos_beneficios: 'Plano Ouro: R$120/mes\nInclui 4 cortes' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ planos_beneficios: 'Plano Ouro: R$120/mes\nInclui 4 cortes' }),
    );
    await app.close();
  });

  it('PUT: texto acima de 4000 chars => 400 perfil invalido, NÃO grava', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { planos_beneficios: 'x'.repeat(4001) } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('SCRUM-75: só-espaços vira "" (sentinela de LIMPAR) e chega ao data layer', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = '';
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { planos_beneficios: '   ' } },
    });

    expect(res.statusCode).toBe(200);
    const dataArg = updatePerfilBySlotMock.mock.calls[0][1] as Record<string, unknown>;
    // SCRUM-75: '' = limpar (data layer remove a chave). Antes o preprocess mapeava pra undefined.
    expect(dataArg.planos_beneficios).toBe('');
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SCRUM-75 (bug do Eduardo): "ao inserir o link, não é possível removê-lo ou alterá-lo. Salva mas
// nada muda". A raiz era o schema mapear '' -> undefined + o merge do data layer ignorar undefined:
// LIMPAR o link virava no-op silencioso. Estes testes de contrato travam a correção end-to-end
// (com o data layer MOCKADO — a prova de persistência real está no data-layer test).
// ════════════════════════════════════════════════════════════════════════════════

describe('link_agendamento — limpar / alterar (SCRUM-75)', () => {
  it('PUT link "" -> 200 e o GET canônico volta SEM link ("")', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = injectedSlot;
    updatePerfilBySlotMock.mockResolvedValue(true);
    // canônico pós-write: o data layer apagou a chave -> getPerfilBySlot devolve '' (chave ausente).
    getPerfilBySlotMock.mockResolvedValue({ ...PERFIL_OK, link_agendamento: '' });
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { link_agendamento: '' } },
    });

    expect(res.statusCode).toBe(200);
    // '' (sentinela de limpar) chega ao data layer, escopado ao slot da SESSÃO (anti-IDOR).
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ link_agendamento: '' }),
    );
    // O perfil devolvido ao front reflete a limpeza.
    expect(res.json().perfil.link_agendamento).toBe('');
    await app.close();
  });

  it('PUT alterando link existente pra OUTRA URL -> 200 e o GET canônico volta a URL NOVA', async () => {
    // Regressão do "alterar": já funcionava no código antigo (não-vazio nunca virava undefined),
    // mas travamos aqui pra garantir que a correção do "limpar" não quebrou o "alterar".
    cfgMock.MODO_ATENDENTE_SLOTS = injectedSlot;
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue({
      ...PERFIL_OK,
      link_agendamento: 'https://trinks.com/novo',
    });
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { link_agendamento: 'https://trinks.com/novo' } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ link_agendamento: 'https://trinks.com/novo' }),
    );
    expect(res.json().perfil.link_agendamento).toBe('https://trinks.com/novo');
    await app.close();
  });

  it('PUT link javascript: SEGUE 400 (limpar não afrouxou a validação de segurança)', async () => {
    cfgMock.MODO_ATENDENTE_SLOTS = injectedSlot;
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { link_agendamento: 'javascript:alert(1)' } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// SCRUM-65: FAQ personalizado (features + validação + gate por-clone)
// ════════════════════════════════════════════════════════════════════════════════

describe('faq_personalizado (GET features / PUT validação + gate)', () => {
  const FAQ_OK = [
    { pergunta: 'Vocês têm estacionamento?', resposta: 'Sim, gratuito na lateral do prédio.' },
    { pergunta: 'Aceitam pix?', resposta: 'Aceitamos.' },
  ];

  it('GET: features.faq_personalizado=false por default (clientes atuais não veem a seção)', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = '';
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features.faq_personalizado).toBe(false);
    await app.close();
  });

  it('GET: features.faq_personalizado=true SÓ quando o slot da sessão está no gate', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = injectedSlot;
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.statusCode).toBe(200);
    expect(res.json().features.faq_personalizado).toBe(true);
    await app.close();
  });

  it('GET: gate ligado em OUTRO slot NÃO liga a feature pro slot da sessão (isolado por-clone)', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = 'clone_de_OUTRO_cliente';
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/portal/perfil' });

    expect(res.json().features.faq_personalizado).toBe(false);
    await app.close();
  });

  it('PUT: com o gate ON, grava faq_personalizado válido no slot da SESSÃO', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = injectedSlot;
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { faq_personalizado: FAQ_OK } },
    });

    expect(res.statusCode).toBe(200);
    expect(updatePerfilBySlotMock).toHaveBeenCalledWith(
      injectedSlot,
      expect.objectContaining({ faq_personalizado: FAQ_OK }),
    );
    await app.close();
  });

  it('PUT: com o gate OFF, tentar setar faq_personalizado => 404 indisponivel, NÃO grava', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = '';
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { faq_personalizado: FAQ_OK } },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('faq_personalizado_indisponivel');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('PUT: gate OFF mas SEM a chave faq_personalizado -> 200 byte-a-byte (não recusa)', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = '';
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { nome_negocio: 'X' } },
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('PUT: 11 pares -> 400 perfil invalido (max 10), NÃO grava (mesmo com gate ON)', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = injectedSlot;
    const app = await buildApp();

    const onze = Array.from({ length: 11 }, (_, i) => ({
      pergunta: `P${i}`,
      resposta: `R${i}`,
    }));
    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { faq_personalizado: onze } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('PUT: par com 1 lado vazio é DESCARTADO no preprocess (não é erro); sobra o válido', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = injectedSlot;
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: {
        perfil: {
          faq_personalizado: [
            { pergunta: 'Aceitam pix?', resposta: 'Sim.' },
            { pergunta: '  ', resposta: 'orfão sem pergunta' }, // descartado
            { pergunta: 'e este?', resposta: '   ' }, // descartado
          ],
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const dataArg = updatePerfilBySlotMock.mock.calls[0][1] as Record<string, unknown>;
    expect(dataArg.faq_personalizado).toEqual([{ pergunta: 'Aceitam pix?', resposta: 'Sim.' }]);
    await app.close();
  });

  it('PUT: pergunta acima de 120 chars -> 400, NÃO grava', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = injectedSlot;
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { faq_personalizado: [{ pergunta: 'x'.repeat(121), resposta: 'ok' }] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('PUT: resposta acima de 300 chars -> 400, NÃO grava', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = injectedSlot;
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { faq_personalizado: [{ pergunta: 'ok', resposta: 'y'.repeat(301) }] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('perfil invalido');
    expect(updatePerfilBySlotMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('PUT: [] limpa o FAQ (gate ON) — grava array vazio', async () => {
    cfgMock.FAQ_PERSONALIZADO_SLOTS = injectedSlot;
    updatePerfilBySlotMock.mockResolvedValue(true);
    getPerfilBySlotMock.mockResolvedValue(PERFIL_OK);
    const app = await buildApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/portal/perfil',
      payload: { perfil: { faq_personalizado: [] } },
    });

    expect(res.statusCode).toBe(200);
    const dataArg = updatePerfilBySlotMock.mock.calls[0][1] as Record<string, unknown>;
    expect(dataArg.faq_personalizado).toEqual([]);
    await app.close();
  });
});
