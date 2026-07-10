import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks ANTES de importar o modulo sob teste.
vi.mock('@startap/db', () => ({
  query: vi.fn(),
}));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { query } from '@startap/db';
import { getRecentContacts } from './waha-contacts.js';

const queryMock = vi.mocked(query);

/** Roteia o mock pelo SQL: numero do bot (flow_clones) vs contatos (message_log). */
function routeQuery(opts: {
  botPhone?: string | null;
  botThrows?: boolean;
  contacts?: Array<{ phone: string; last_at: Date }>;
}) {
  // Cast via `unknown` (nao `any`): o consumidor so le `.rows`; o resto do
  // pg.QueryResult e irrelevante pro teste.
  queryMock.mockImplementation((async (sql: string) => {
    if (sql.includes('flow_clones')) {
      if (opts.botThrows) throw new Error('coluna sumiu / db down');
      return { rows: opts.botPhone ? [{ alert_owner_phone: opts.botPhone }] : [] };
    }
    if (sql.includes('message_log')) {
      return { rows: opts.contacts ?? [] };
    }
    throw new Error(`query inesperada no teste: ${sql}`);
  }) as unknown as typeof query);
}

describe('getRecentContacts — fallback DB (SCRUM-43)', () => {
  beforeEach(() => {
    queryMock.mockReset();
    // WAHA /chats indisponivel -> forca o caminho de fallback via DB.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('waha down')));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('busca o numero do bot em flow_clones.alert_owner_phone (fonte correta, nao bot_config.waha_number) e exclui da lista', async () => {
    const last = new Date('2026-07-01T12:00:00.000Z');
    routeQuery({
      botPhone: '5511999990000',
      contacts: [{ phone: '5535988887777', last_at: last }],
    });

    const out = await getRecentContacts('SESSAO_X', 7);

    expect(out.source).toBe('db');
    expect(out.contacts).toEqual([
      { phone: '5535988887777', name: null, last_interaction: last.toISOString() },
    ]);

    // 1a query: numero do bot vem de flow_clones/alert_owner_phone — nunca do drift antigo.
    const botCall = queryMock.mock.calls.find(([sql]) => (sql as string).includes('flow_clones'));
    expect(botCall).toBeDefined();
    const botSql = botCall?.[0] as string;
    expect(botSql).toContain('alert_owner_phone');
    expect(botSql).not.toContain('bot_config');
    expect(botSql).not.toContain('waha_number');

    // 2a query: o numero do bot entra como parametro de exclusao ($3).
    const contactsCall = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('message_log'),
    );
    expect(contactsCall?.[1]).toContain('5511999990000');
  });

  it('degrada com seguranca quando a busca do numero do bot falha (botPhone null, sem lancar)', async () => {
    const last = new Date('2026-07-02T09:30:00.000Z');
    routeQuery({
      botThrows: true,
      contacts: [{ phone: '5535911112222', last_at: last }],
    });

    const out = await getRecentContacts('SESSAO_Y', 7);

    expect(out.source).toBe('db');
    expect(out.contacts).toHaveLength(1);

    // Sem numero do bot, o parametro de exclusao vai null (filtro ignorado, nao quebra).
    const contactsCall = queryMock.mock.calls.find(([sql]) =>
      (sql as string).includes('message_log'),
    );
    expect(contactsCall?.[1]).toContain(null);
  });
});
