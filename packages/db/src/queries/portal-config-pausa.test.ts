/**
 * Unit das pausas do portal (portal-config.ts) — foco no SCRUM-86: pausa via portal é
 * INDETERMINADA (expires_at NULL). Mocka `query` do client (sem DB real), mesmo padrão de
 * portal-perfil.test.ts / pausa.test.ts: teste de string/params — a garantia é o SQL gerado
 * + os parâmetros, não o comportamento de runtime do PG (isso é o .integration.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { addPausaBySlot, removePausaBySlot, listPausasBySlot } = await import('./portal-config.js');

const SLOT = 'clone_meduzza_barbearia_q23psc';
const TEL = '5535999998888';

describe('addPausaBySlot — pausa via portal é INDETERMINADA (SCRUM-86)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('ON CONFLICT DO UPDATE ZERA o expires_at (promove human_reply/TTL vencido a permanente)', async () => {
    // 1ª call = SELECT meta do clone; 2ª call = INSERT ... ON CONFLICT (upsert da pausa).
    mockQuery
      .mockResolvedValueOnce({ rows: [{ display_name: 'Meduzza', waha_sessao: 'SESS' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            telefone: TEL,
            source: 'portal',
            reason: 'Pausado via portal',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

    const row = await addPausaBySlot({ slot: SLOT, telefone: TEL });

    const [sql] = mockQuery.mock.calls[1] as [string, unknown[]];
    // A garantia do fix: o conflito FORÇA expires_at = NULL. Sem isso, a linha herdaria o TTL
    // vencido de uma pausa human_reply anterior e sumiria do painel/soltaria o bot em <1h.
    expect(sql).toMatch(/ON CONFLICT \(flow_id, telefone\) DO UPDATE/i);
    expect(sql).toMatch(/expires_at\s*=\s*NULL/i);
    // Regressão: continua marcando source='portal' e active=TRUE.
    expect(sql).toMatch(/source\s*=\s*'portal'/i);
    expect(sql).toMatch(/active\s*=\s*TRUE/i);
    // A linha resultante é portal/ativa (o painel a mostra: expires_at NULL passa no filtro).
    expect(row?.source).toBe('portal');
  });

  it('INSERT não injeta TTL (default NULL) — pausa nova via portal nasce permanente', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ display_name: null, waha_sessao: null }] })
      .mockResolvedValueOnce({
        rows: [
          {
            telefone: TEL,
            source: 'portal',
            reason: 'Pausado via portal',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

    await addPausaBySlot({ slot: SLOT, telefone: TEL });

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    // A LISTA DE COLUNAS do INSERT não cita expires_at (herda o default NULL da coluna) — o
    // caminho de INSERT nunca grava validade. (O 'expires_at = NULL' vive só no DO UPDATE.)
    const colList = sql.match(/INSERT INTO flow_pauses\s*\(([^)]*)\)/i)?.[1] ?? '';
    expect(colList).not.toMatch(/expires_at/i);
    // Escopo por slot ($1) e telefone ($3) — anti-IDOR na camada da rota.
    expect(params[0]).toBe(SLOT);
    expect(params[2]).toBe(TEL);
  });

  it('SCRUM-144: nome → contact_name ($5), COALESCE/NULLIF no conflito, RETURNING contact_name', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ display_name: 'Meduzza', waha_sessao: 'SESS' }] })
      .mockResolvedValueOnce({
        rows: [
          {
            telefone: TEL,
            source: 'portal',
            reason: 'Pausado via portal',
            contact_name: 'Wal Delfim',
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
      });

    const row = await addPausaBySlot({ slot: SLOT, telefone: TEL, nome: '  Wal Delfim  ' });

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    // contact_name entra no INSERT e no RETURNING; no conflito só sobrescreve se veio nome novo.
    expect(sql).toMatch(/INSERT INTO flow_pauses[\s\S]*contact_name/i);
    expect(sql).toMatch(/contact_name = COALESCE\(NULLIF\(EXCLUDED\.contact_name, ''\)/i);
    expect(sql).toMatch(/RETURNING[\s\S]*contact_name/i);
    // $5 = nome JÁ TRIMADO (o front pode mandar com espaços).
    expect(params[4]).toBe('Wal Delfim');
    expect(row?.contact_name).toBe('Wal Delfim');
  });

  it('SCRUM-144: sem nome → $5 = null (não grava nem apaga contact_name)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ display_name: null, waha_sessao: null }] })
      .mockResolvedValueOnce({ rows: [{ telefone: TEL, contact_name: null }] });

    await addPausaBySlot({ slot: SLOT, telefone: TEL });

    const [, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(params[4]).toBeNull();
  });
});

describe('removePausaBySlot — despausa linha ativa MESMO com expires_at vencido', () => {
  beforeEach(() => mockQuery.mockReset());

  it('UPDATE filtra só por active=TRUE (sem cláusula de expires_at) → não dá 404 em ativa-mas-expirada', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const ok = await removePausaBySlot({ slot: SLOT, telefone: TEL });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE flow_pauses[\s\S]*SET active = FALSE/i);
    expect(sql).toMatch(/WHERE flow_id = \$1 AND telefone = \$2 AND active = TRUE/i);
    // NÃO deve filtrar por expires_at: uma linha active=TRUE com TTL vencido (estado que existe
    // em prod hoje) tem de ser desativável pelo dono — senão o despausar retornaria false/404.
    expect(sql).not.toMatch(/expires_at/i);
    expect(params).toEqual([SLOT, TEL]);
    expect(ok).toBe(true);
  });

  it('rowCount 0 → false (não havia pausa ativa para o número)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    expect(await removePausaBySlot({ slot: SLOT, telefone: TEL })).toBe(false);
  });
});

describe('listPausasBySlot — pausa permanente (expires_at NULL) aparece no painel', () => {
  beforeEach(() => mockQuery.mockReset());

  it('filtro admite expires_at NULL (a pausa re-promovida via portal segue visível)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          telefone: TEL,
          source: 'portal',
          reason: 'Pausado via portal',
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });

    const rows = await listPausasBySlot(SLOT);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // O filtro que some com a human_reply vencida (correto) ADMITE expires_at NULL → a pausa
    // portal (agora permanente) continua listada. Fecha o loop do fix com o addPausaBySlot.
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/i);
    expect(sql).toMatch(/active = TRUE/i);
    expect(params).toEqual([SLOT]);
    expect(rows[0]?.telefone).toBe(TEL);
  });
});
