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
  teardownProvisionedClone,
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

  it('injeta display_name do clone em {{nome_negocio}} quando não há personalização', () => {
    const out = renderClonePrompt(
      'Bem vindo a {{nome_negocio}} 💈',
      {},
      null,
      null,
      'Barbearia do Samuel',
    );
    expect(out).toBe('Bem vindo a Barbearia do Samuel 💈');
    expect(out).not.toContain('{{nome_negocio}}');
  });

  it('precedência: personalizacao.nome_negocio vence o display_name do clone', () => {
    const out = renderClonePrompt(
      '{{nome_negocio}}',
      { nome_negocio: 'Salão Premium' },
      null,
      null,
      'Barbearia do Samuel',
    );
    expect(out).toBe('Salão Premium');
  });

  it('fallback "a barbearia" quando personalizacao e display_name estão vazios', () => {
    // sem display_name e sem nome_negocio na personalização => nunca literal nem vazio
    expect(renderClonePrompt('{{nome_negocio}}', {}, null, null)).toBe('a barbearia');
    expect(renderClonePrompt('{{nome_negocio}}', { nome_negocio: '  ' }, null, null, '  ')).toBe(
      'a barbearia',
    );
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

  it('cria sessão com webhook escutando SÓ message.any e session.status (sem message)', async () => {
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
    // 'message' NÃO pode entrar: message.any é superset — os dois juntos
    // entregam a mesma mensagem 2x e o bot responde em dobro (smoke 2026-06-12).
    expect(body.config.webhooks[0]?.events).toEqual(['message.any', 'session.status']);
  });

  // Padrão-ouro de sessão nova (diretriz Bruno 12/06): config EXPLÍCITA igual
  // às sessões prod comprovadas (GET real de cirilobarbearia, WAHA 2026.3.2).
  // Default implícito da instância é frágil — o trial nasceu com
  // retries.delaySeconds=2 enquanto Cirilo tem 3. Se este teste quebrar porque
  // alguém removeu ignore/retries/noweb "por serem default do WAHA", NÃO
  // remova o teste: restaure os campos.
  it('payload explicita padrão Cirilo: ignore (só chat privado) + retries + noweb', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'STARTING' }) });
    await createWahaSession(WAHA, 'clone_x');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      config: {
        webhooks: Array<{ retries?: Record<string, unknown> }>;
        ignore?: Record<string, unknown>;
        noweb?: Record<string, unknown>;
      };
    };
    // Bot SÓ responde chat privado: nada de status/grupos/canais/broadcast.
    expect(body.config.ignore).toEqual({
      status: true,
      groups: true,
      channels: true,
      broadcast: true,
    });
    // Retry de entrega do webhook igual Cirilo (attempts 15, constant 3s).
    expect(body.config.webhooks[0]?.retries).toEqual({
      attempts: 15,
      delaySeconds: 3,
      policy: 'constant',
    });
    // Engine NOWEB igual Cirilo: markOnline on, store de chats/contatos off.
    expect(body.config.noweb).toEqual({
      markOnline: true,
      store: { enabled: false, fullSync: false },
    });
  });

  it('falha de WAHA NÃO lança — retorna { ok:false } pro caller decidir (retry-waha)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await createWahaSession(WAHA, 'clone_x');
    expect(r.ok).toBe(false);
    expect(r.status).toBe('failed');
    expect(r.error).toContain('ECONNREFUSED');
  });

  // Auth do webhook (P0 #268 + spike 2026-06-11): sessão nova nasce autenticada.
  it('sem envs de auth -> webhook SEM hmac e SEM customHeaders (comportamento atual)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'STARTING' }) });
    await createWahaSession(WAHA, 'clone_x');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      config: { webhooks: Array<Record<string, unknown>> };
    };
    expect(body.config.webhooks[0]).not.toHaveProperty('hmac');
    expect(body.config.webhooks[0]).not.toHaveProperty('customHeaders');
  });

  it('webhookHmacKey configurada -> webhook nasce com hmac.key (plano A), preservando events', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'STARTING' }) });
    await createWahaSession({ ...WAHA, webhookHmacKey: 'hmac-key-test' }, 'clone_x');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      config: {
        webhooks: Array<{ events: string[]; hmac?: { key: string }; customHeaders?: unknown }>;
      };
    };
    expect(body.config.webhooks[0]?.hmac).toEqual({ key: 'hmac-key-test' });
    expect(body.config.webhooks[0]?.customHeaders).toBeUndefined();
    // events intactos — sem message.any o bot fica surdo; com 'message' junto
    // a entrega duplica e o bot responde 2x (smoke 2026-06-12).
    expect(body.config.webhooks[0]?.events).toEqual(['message.any', 'session.status']);
  });

  it('webhookSecret configurado -> webhook nasce com customHeaders X-Webhook-Secret (plano B)', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: 'STARTING' }) });
    await createWahaSession(
      { ...WAHA, webhookHmacKey: 'hmac-key-test', webhookSecret: 'static-secret' },
      'clone_x',
    );
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
      config: {
        webhooks: Array<{
          hmac?: { key: string };
          customHeaders?: Array<{ name: string; value: string }>;
        }>;
      };
    };
    // Os dois coexistem na sessão; a precedência de validação é do apps/api.
    expect(body.config.webhooks[0]?.hmac).toEqual({ key: 'hmac-key-test' });
    expect(body.config.webhooks[0]?.customHeaders).toEqual([
      { name: 'X-Webhook-Secret', value: 'static-secret' },
    ]);
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

describe('teardownProvisionedClone — clone órfão de falha parcial do signup (security #268)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const WAHA = {
    url: 'http://waha:3000',
    apiKey: 'k',
    webhookUrl: 'http://api:3040/webhooks/waha',
  };

  function fakeTeardownPool(cloneStatus: string | null, failOnDelete = false) {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const client: SqlClient = {
      query: async (text: string, values?: unknown[]): Promise<SqlResult> => {
        queries.push({ text, values });
        if (text.includes('SELECT status FROM flow_clones')) {
          return { rows: cloneStatus === null ? [] : [{ status: cloneStatus }] };
        }
        if (failOnDelete && text.startsWith('DELETE')) {
          throw new Error('pg down');
        }
        return { rows: [] };
      },
      release: () => {},
    };
    const pool: SqlPool = {
      query: async (text: string, values?: unknown[]): Promise<SqlResult> => {
        queries.push({ text, values });
        return { rows: [] };
      },
      connect: async () => client,
    };
    return { pool, queries };
  }

  it('caminho feliz: DELETE da sessão WAHA + remoção das rows do clone em transação', async () => {
    const { pool, queries } = fakeTeardownPool('rascunho');
    const r = await teardownProvisionedClone(
      { db: pool, waha: WAHA },
      { slot: 'clone_orfao_ab12cd', sessionName: 'clone_orfao_ab12cd' },
    );

    expect(r).toEqual({ wahaDeleted: true, dbDeleted: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://waha:3000/api/sessions/clone_orfao_ab12cd',
      expect.objectContaining({ method: 'DELETE' }),
    );
    const texts = queries.map((q) => q.text);
    // Tudo keyed pelo slot fresco; portal_users por SLOT (nunca username — o
    // 23505 deixa a conta pré-existente intacta). trial_ledger JAMAIS é tocado.
    for (const t of [
      'DELETE FROM portal_user_clones WHERE slot = $1',
      'DELETE FROM portal_users WHERE slot = $1',
      'DELETE FROM client_billing WHERE slot = $1',
      'DELETE FROM flow_clones WHERE slot = $1',
    ]) {
      expect(texts).toContain(t);
    }
    expect(texts.some((t) => t.includes('trial_ledger'))).toBe(false);
    expect(texts).toContain('COMMIT');
    for (const q of queries.filter((q) => q.text.startsWith('DELETE'))) {
      expect(q.values).toEqual(['clone_orfao_ab12cd']);
    }
  });

  it('GUARDA: slot sem prefixo clone_ => recusa total (nem WAHA nem DB)', async () => {
    const { pool, queries } = fakeTeardownPool('rascunho');
    const r = await teardownProvisionedClone(
      { db: pool, waha: WAHA },
      { slot: 'cirilobarbearia', sessionName: 'cirilobarbearia' },
    );
    expect(r).toEqual({ wahaDeleted: false, dbDeleted: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queries.length).toBe(0);
  });

  it('GUARDA: clone que já progrediu de estado (conectado) => ROLLBACK sem deletar', async () => {
    const { pool, queries } = fakeTeardownPool('conectado');
    const r = await teardownProvisionedClone(
      { db: pool, waha: WAHA },
      { slot: 'clone_orfao_ab12cd', sessionName: 'clone_orfao_ab12cd' },
    );
    expect(r.dbDeleted).toBe(false);
    const texts = queries.map((q) => q.text);
    expect(texts.some((t) => t.startsWith('DELETE'))).toBe(false);
    expect(texts).toContain('ROLLBACK');
  });

  it('best-effort: falha de DB no meio NÃO lança (faz ROLLBACK e reporta false)', async () => {
    const { pool, queries } = fakeTeardownPool('rascunho', true);
    const r = await teardownProvisionedClone(
      { db: pool, waha: WAHA },
      { slot: 'clone_orfao_ab12cd', sessionName: 'clone_orfao_ab12cd' },
    );
    expect(r.dbDeleted).toBe(false);
    expect(queries.map((q) => q.text)).toContain('ROLLBACK');
  });

  it('best-effort: WAHA fora NÃO lança e o DB ainda é limpo', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { pool } = fakeTeardownPool('rascunho');
    const r = await teardownProvisionedClone(
      { db: pool, waha: WAHA },
      { slot: 'clone_orfao_ab12cd', sessionName: 'clone_orfao_ab12cd' },
    );
    expect(r).toEqual({ wahaDeleted: false, dbDeleted: true });
  });
});
