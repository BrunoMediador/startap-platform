/**
 * Testes do resolvedor GCal por slot (per-clone.ts).
 *
 * Cobre:
 *  1. Caminho INDIVIDUAL byte-a-byte inalterado:
 *     - clone_ individual lê de flow_clones;
 *     - matriz (sem clone_) lê de bot_config.
 *  2. ESTABELECIMENTO: getGcalsForSlot resolve N colaboradores (gated por flag +
 *     product_type='estabelecimento').
 *  3. ISOLAMENTO (ADR 0024 §4): entry de cache de outro tenant/slot é MISS — sem
 *     vazamento cross-tenant. Cenário de homônimo/slot trocado coberto.
 *
 * Não conecta no banco — mocka @startap/db (query) e @startap/core (decryptSecret).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks declarados antes do import do módulo testado.
vi.mock('@startap/db', () => ({
  query: vi.fn(),
}));

// decryptSecret roda de verdade no projeto (não é mockado em lugar nenhum).
// Aqui mockamos para devolver o JSON de uma SA fake válida sem precisar de cripto real.
vi.mock('@startap/core', () => ({
  decryptSecret: vi.fn((stored: string) => stored),
}));

import { query } from '@startap/db';
import {
  getGcalForSlot,
  getGcalsForSlot,
  invalidateGcalCache,
  invalidateGcalsForSlot,
} from './per-clone.js';

const mockQuery = vi.mocked(query);

// JSON mínimo aceito pelo GoogleCalendarClient (type=service_account).
const SA_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'sa@fake.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n',
});

function qResult<T>(rows: T[]) {
  return {
    rows,
    rowCount: rows.length,
    command: 'SELECT',
    oid: 0,
    fields: [],
  } as unknown as Awaited<ReturnType<typeof query>>;
}

beforeEach(() => {
  mockQuery.mockReset();
  // Limpa caches entre testes (evita TTL de 5min vazar entre casos).
  invalidateGcalCache('clone_indiv_a');
  invalidateGcalCache('teste_barbearia');
  invalidateGcalsForSlot('clone_estab_x');
  invalidateGcalsForSlot('clone_estab_y');
  // Reset da flag para OFF (string vazia != 'true' → caminho novo inalcançável).
  process.env.ESTABELECIMENTO_ENABLED = '';
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// 1) Caminho INDIVIDUAL inalterado
// ─────────────────────────────────────────────────────────────────────────────

describe('getGcalForSlot — individual (inalterado)', () => {
  it('clone_ individual: lê de flow_clones e devolve client', async () => {
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          gcal_credentials_json: SA_JSON,
          gcal_calendar_id: 'cal-indiv@group.calendar.google.com',
          gcal_status: 'active',
        },
      ]),
    );

    const client = await getGcalForSlot('clone_indiv_a');

    expect(client).not.toBeNull();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('FROM flow_clones');
    expect(sql).not.toContain('clone_colaboradores');
    expect(mockQuery.mock.calls[0][1]).toEqual(['clone_indiv_a']);
  });

  it('matriz (sem clone_): lê de bot_config', async () => {
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          gcal_credentials_json: SA_JSON,
          gcal_calendar_id: 'cal-matriz@group.calendar.google.com',
          gcal_status: 'active',
        },
      ]),
    );

    const client = await getGcalForSlot('teste_barbearia');

    expect(client).not.toBeNull();
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('FROM bot_config');
    expect(mockQuery.mock.calls[0][1]).toEqual(['teste_barbearia']);
  });

  it('status != active → null (caminho individual)', async () => {
    mockQuery.mockResolvedValueOnce(
      qResult([{ gcal_credentials_json: SA_JSON, gcal_calendar_id: 'x', gcal_status: 'pending' }]),
    );

    expect(await getGcalForSlot('clone_indiv_a')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2) Gating: flag OFF e product_type
// ─────────────────────────────────────────────────────────────────────────────

describe('getGcalsForSlot — gating', () => {
  it('flag OFF → [] e NENHUMA query (caminho novo inalcançável)', async () => {
    // ESTABELECIMENTO_ENABLED ausente (default OFF)
    const out = await getGcalsForSlot('clone_estab_x');
    expect(out).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('flag ON mas slot sem clone_ → [] e NENHUMA query', async () => {
    process.env.ESTABELECIMENTO_ENABLED = 'true';
    const out = await getGcalsForSlot('teste_barbearia');
    expect(out).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('flag ON, clone_ mas product_type=individual → [] (individual nunca entra)', async () => {
    process.env.ESTABELECIMENTO_ENABLED = 'true';
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'individual',
          tenant_id: '11111111-1111-1111-1111-111111111111',
          clone_credentials_json: SA_JSON,
          colaborador_id: '1',
          nome: 'João',
          gcal_calendar_id: 'cal-1',
          gcal_status: 'active',
        },
      ]),
    );

    const out = await getGcalsForSlot('clone_indiv_a');
    expect(out).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3) Estabelecimento: resolve colaboradores
// ─────────────────────────────────────────────────────────────────────────────

describe('getGcalsForSlot — estabelecimento', () => {
  beforeEach(() => {
    process.env.ESTABELECIMENTO_ENABLED = 'true';
  });

  it('resolve colaboradores ativos com agenda active', async () => {
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: '22222222-2222-2222-2222-222222222222',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'João S.',
          gcal_calendar_id: 'cal-joao-s@group.calendar.google.com',
          gcal_status: 'active',
        },
        {
          product_type: 'estabelecimento',
          tenant_id: '22222222-2222-2222-2222-222222222222',
          clone_credentials_json: SA_JSON,
          colaborador_id: '11',
          nome: 'Maria',
          gcal_calendar_id: 'cal-maria@group.calendar.google.com',
          gcal_status: 'active',
        },
      ]),
    );

    const out = await getGcalsForSlot('clone_estab_x');

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      colaboradorId: 10,
      nome: 'João S.',
      calendarId: 'cal-joao-s@group.calendar.google.com',
    });
    expect(out[1]).toMatchObject({
      colaboradorId: 11,
      nome: 'Maria',
      calendarId: 'cal-maria@group.calendar.google.com',
    });
    // SELECT projeta tenant_id e junta clone_colaboradores (ADR 0024 §4).
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('clone_colaboradores');
    expect(sql).toContain('tenant_id');
    expect(mockQuery.mock.calls[0][1]).toEqual(['clone_estab_x']);
  });

  it('pula colaborador com gcal_status pending/invalid', async () => {
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: '22222222-2222-2222-2222-222222222222',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'João S.',
          gcal_calendar_id: 'cal-joao-s',
          gcal_status: 'active',
        },
        {
          product_type: 'estabelecimento',
          tenant_id: '22222222-2222-2222-2222-222222222222',
          clone_credentials_json: SA_JSON,
          colaborador_id: '11',
          nome: 'Pedro',
          gcal_calendar_id: null,
          gcal_status: 'pending',
        },
      ]),
    );

    const out = await getGcalsForSlot('clone_estab_x');
    expect(out).toHaveLength(1);
    expect(out[0].colaboradorId).toBe(10);
  });

  it('sem colaboradores (0 linhas) → []', async () => {
    mockQuery.mockResolvedValueOnce(qResult([]));
    expect(await getGcalsForSlot('clone_estab_x')).toEqual([]);
  });

  // Bug 2 (a): projeta clone_colaboradores.servicos (migration 057) e devolve por colaborador.
  it('projeta servicos do colaborador e devolve (jsonb array → string[])', async () => {
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: '22222222-2222-2222-2222-222222222222',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'Bruno',
          gcal_calendar_id: 'cal-bruno',
          gcal_status: 'active',
          servicos: ['Corte', 'Barba'], // o driver pg desserializa jsonb → array JS
        },
        {
          product_type: 'estabelecimento',
          tenant_id: '22222222-2222-2222-2222-222222222222',
          clone_credentials_json: SA_JSON,
          colaborador_id: '11',
          nome: 'Maria',
          gcal_calendar_id: 'cal-maria',
          gcal_status: 'active',
          servicos: [], // não especificado → caller aplica fallback global
        },
      ]),
    );

    const out = await getGcalsForSlot('clone_estab_x');
    expect(out[0].servicos).toEqual(['Corte', 'Barba']);
    expect(out[1].servicos).toEqual([]);
    // a SELECT projeta a coluna servicos.
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('cc.servicos');
  });

  it('servicos ausente/null no banco (pré-057) → [] (não quebra)', async () => {
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: '22222222-2222-2222-2222-222222222222',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'Bruno',
          gcal_calendar_id: 'cal-bruno',
          gcal_status: 'active',
          servicos: null,
        },
      ]),
    );
    const out = await getGcalsForSlot('clone_estab_x');
    expect(out[0].servicos).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4) ISOLAMENTO adversarial — entry de outro tenant/slot é MISS (sem vazamento)
// ─────────────────────────────────────────────────────────────────────────────

describe('getGcalsForSlot — isolamento cross-tenant', () => {
  beforeEach(() => {
    process.env.ESTABELECIMENTO_ENABLED = 'true';
  });

  it('mesmo colaboradorId em tenant/slot diferentes NÃO compartilha cache (homônimo)', async () => {
    // 1ª chamada: slot X, tenant A, colaborador id 10 ("João S.")
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'João S.',
          gcal_calendar_id: 'cal-X-joao@group.calendar.google.com',
          gcal_status: 'active',
        },
      ]),
    );
    const outX = await getGcalsForSlot('clone_estab_x');
    expect(outX).toHaveLength(1);
    expect(outX[0].calendarId).toBe('cal-X-joao@group.calendar.google.com');

    // 2ª chamada: slot Y, tenant B, MESMO colaborador id 10 (homônimo "João S.")
    // mas calendarId DIFERENTE. Entry de cache do slot X jamais pode vazar pro Y.
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'João S.',
          gcal_calendar_id: 'cal-Y-joao@group.calendar.google.com',
          gcal_status: 'active',
        },
      ]),
    );
    const outY = await getGcalsForSlot('clone_estab_y');

    // Não vazou: Y devolve a agenda DELE, não a do X (chave de cache inclui slot).
    expect(outY).toHaveLength(1);
    expect(outY[0].calendarId).toBe('cal-Y-joao@group.calendar.google.com');
    expect(outY[0].calendarId).not.toBe(outX[0].calendarId);
    // Duas queries de verdade (não houve hit cross-slot).
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('mesmo slot+colaborador com tenant_id divergente entre chamadas → MISS (re-lê)', async () => {
    // 1ª: cache aquece para (clone_estab_x, colab 10) sob tenant A.
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'João S.',
          gcal_calendar_id: 'cal-tenantA@group.calendar.google.com',
          gcal_status: 'active',
        },
      ]),
    );
    await getGcalsForSlot('clone_estab_x');

    // 2ª: MESMO slot+colaborador mas tenant_id mudou (cenário adversarial de slot
    // reatribuído / dado divergente). A entry quente (tenant A) NÃO pode ser
    // devolvida — confere tenantId e trata como MISS, re-resolvendo do banco.
    mockQuery.mockResolvedValueOnce(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'João S.',
          gcal_calendar_id: 'cal-tenantC@group.calendar.google.com',
          gcal_status: 'active',
        },
      ]),
    );
    const out2 = await getGcalsForSlot('clone_estab_x');

    expect(out2).toHaveLength(1);
    expect(out2[0].calendarId).toBe('cal-tenantC@group.calendar.google.com');
    // Houve re-leitura (MISS), não devolveu a entry do tenant A.
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('cache HIT legítimo: 2ª chamada do mesmo (slot,tenant,colab) não re-consulta o client', async () => {
    mockQuery.mockResolvedValue(
      qResult([
        {
          product_type: 'estabelecimento',
          tenant_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          clone_credentials_json: SA_JSON,
          colaborador_id: '10',
          nome: 'João S.',
          gcal_calendar_id: 'cal-joao@group.calendar.google.com',
          gcal_status: 'active',
        },
      ]),
    );

    const first = await getGcalsForSlot('clone_estab_x');
    const second = await getGcalsForSlot('clone_estab_x');

    // O client é a MESMA instância no hit legítimo (veio do cache, não reconstruído).
    expect(second[0].client).toBe(first[0].client);
  });
});
