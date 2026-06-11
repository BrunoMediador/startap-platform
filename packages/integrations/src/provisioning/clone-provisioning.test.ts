import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CloneSlotConflictError,
  type SqlClient,
  type SqlPool,
  type SqlResult,
  createCloneRecords,
  createWahaSession,
  generateCloneSlot,
  renderClonePrompt,
  wahaSessionName,
} from './clone-provisioning.js';

describe('generateCloneSlot', () => {
  it('gera slot prefixado clone_ (exigido pelo gate de billing e per-clone GCal)', () => {
    const slot = generateCloneSlot('Barbearia do João');
    expect(slot).toMatch(/^clone_barbearia_do_joao_[a-z0-9]{6}$/);
  });

  it('slots são únicos entre chamadas (sufixo aleatório)', () => {
    expect(generateCloneSlot('X Salão')).not.toBe(generateCloneSlot('X Salão'));
  });

  it('nome vazio/só símbolos não quebra', () => {
    expect(generateCloneSlot('!!!')).toMatch(/^clone_negocio_[a-z0-9]{6}$/);
  });
});

describe('wahaSessionName', () => {
  it('prefixa clone_ e troca hífens por underscores (regra original do gestão)', () => {
    expect(wahaSessionName('barbearia-x')).toBe('clone_barbearia_x');
  });
});

describe('renderClonePrompt', () => {
  it('substitui placeholders de personalização, horários e serviços', () => {
    const out = renderClonePrompt(
      'Oi, sou da {{nome_negocio}}.\n{{horarios_funcionamento_render}}\n{{servicos_precos_render}}',
      { nome_negocio: 'Barbearia X' },
      { segunda: { abre: '09:00', fecha: '18:00', fechado: false } },
      [{ nome: 'Corte', preco_cents: 5000, duracao_min: 30 }],
    );
    expect(out).toContain('Barbearia X');
    expect(out).toContain('Segunda: 09:00 as 18:00');
    expect(out).toContain('Corte: R$50,00 (30 min)');
  });

  it('preserva placeholders não resolvidos (não perde dado)', () => {
    const out = renderClonePrompt('{{desconhecido}}', {}, null, null);
    expect(out).toBe('{{desconhecido}}');
  });
});

describe('createWahaSession', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const WAHA = {
    url: 'http://waha:3000',
    apiKey: 'k',
    webhookUrl: 'http://api:3040/webhooks/waha',
  };

  it('cria sessão com webhook incluindo message.any e session.status', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'STARTING' }),
    });

    const r = await createWahaSession(WAHA, 'clone_x');

    expect(r).toEqual({ ok: true, status: 'STARTING' });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      config: { webhooks: Array<{ events: string[] }> };
    };
    // message.any: sem ele o bot fica surdo pra áudio e o pause do dono quebra.
    // session.status: alimenta o hook de trial (Missão 020 F1).
    expect(body.config.webhooks[0]?.events).toEqual(['message', 'message.any', 'session.status']);
  });

  it('falha de WAHA NÃO lança — retorna { ok:false } pro caller decidir (retry-waha)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await createWahaSession(WAHA, 'clone_x');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('ECONNREFUSED');
  });
});

describe('createCloneRecords — idempotência/unicidade', () => {
  function fakePool(existingSlots: string[]): { pool: SqlPool; queries: string[] } {
    const queries: string[] = [];
    const client: SqlClient = {
      query: async (text: string): Promise<SqlResult> => {
        queries.push(text);
        return { rows: [] };
      },
      release: () => {},
    };
    const pool: SqlPool = {
      query: async (text: string, values?: unknown[]): Promise<SqlResult> => {
        queries.push(text);
        if (text.includes('SELECT 1 FROM') && existingSlots.includes(String(values?.[0]))) {
          return { rows: [{ ok: 1 }] };
        }
        return { rows: [] };
      },
      connect: async () => client,
    };
    return { pool, queries };
  }

  it('slot já existente => CloneSlotConflictError SEM abrir transação', async () => {
    const { pool, queries } = fakePool(['clone_ja_existe']);
    await expect(
      createCloneRecords(pool, {
        matrizSlot: 'teste_barbearia',
        novoSlot: 'clone_ja_existe',
        displayName: 'X',
      }),
    ).rejects.toThrow(CloneSlotConflictError);
    expect(queries.some((q) => q.includes('BEGIN'))).toBe(false);
  });

  it('matriz inexistente => MatrizNotFoundError com ROLLBACK', async () => {
    const { pool, queries } = fakePool([]);
    await expect(
      createCloneRecords(pool, {
        matrizSlot: 'matriz_fantasma',
        novoSlot: 'clone_novo',
        displayName: 'X',
      }),
    ).rejects.toThrow('matriz_fantasma');
    expect(queries.some((q) => q.includes('ROLLBACK'))).toBe(true);
    expect(queries.some((q) => q.includes('COMMIT'))).toBe(false);
  });
});
