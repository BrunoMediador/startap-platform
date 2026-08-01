/**
 * Unit de pausa.ts — foco no TTL (SCRUM-59) e no replace-set das frases de pausa.
 * Mocka `query` e `pool.connect` do client (sem DB real), mesmo padrão dos outros
 * testes de query (flow-clones-alert-owner.test.ts). É teste de string/params: a
 * garantia aqui é o SQL gerado + os parâmetros, não o comportamento de runtime do PG.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockClientQuery = vi.fn();
const mockRelease = vi.fn();
const mockConnect = vi.fn(async () => ({ query: mockClientQuery, release: mockRelease }));

vi.mock('../client.js', () => ({
  pool: { connect: () => mockConnect() },
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { isFlowPaused, addFlowPause, addHumanReplyPause, replaceFlowPauseKeywords } = await import(
  './pausa.js'
);

describe('isFlowPaused — respeita expires_at (TTL, SCRUM-59)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('predicado inclui active=TRUE E (expires_at NULL OU no futuro)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '0' }] });
    await isFlowPaused({ flowId: 'clone_x', telefone: '5535999998888' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('active = TRUE');
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > NOW\(\)/i);
    expect(params).toEqual(['clone_x', '5535999998888']);
  });

  it('count>0 → pausado (dentro da validade)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '1' }] });
    expect(await isFlowPaused({ flowId: 'f', telefone: 't' })).toBe(true);
  });

  it('count=0 → NÃO pausado (expirada/inexistente = bot volta)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '0' }] });
    expect(await isFlowPaused({ flowId: 'f', telefone: 't' })).toBe(false);
  });
});

describe('addFlowPause — pausa permanente/keyword (promove: zera TTL prévio)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('sem expiresAt (keyword/portal/escalated) → grava NULL e SQL usa expires_at = EXCLUDED.expires_at', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await addFlowPause({ flowId: 'clone_cirilo', telefone: '5511999990000', source: 'fromMe' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // expires_at = EXCLUDED.expires_at + expiresAt ausente => NULL: promove qualquer TTL
    // prévio (ex.: human_reply expirada) pra permanente, sem herdar validade vencida.
    expect(sql).toMatch(/expires_at = EXCLUDED\.expires_at/i);
    // $7 = expires_at (ordem: flowId, flowName, telefone, session, source, reason, expires_at)
    expect(params[6]).toBeNull();
  });

  it('NÃO tem WHERE-guard: a permanente sempre atualiza no conflito (permanente SOBE)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await addFlowPause({ flowId: 'f', telefone: 't', source: 'fromMe' });
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    // O guard "não rebaixar permanente" é EXCLUSIVO do addHumanReplyPause.
    expect(sql).not.toMatch(/DO UPDATE[\s\S]*WHERE/i);
  });

  it('SCRUM-144: com contactName → coluna contact_name entra no INSERT e no DO UPDATE com COALESCE/NULLIF', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await addFlowPause({
      flowId: 'clone_x',
      telefone: '5511999990000',
      source: 'fromMe',
      contactName: 'Wal Delfim',
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO flow_pauses[\s\S]*contact_name/i);
    expect(sql).toMatch(/contact_name = COALESCE\(NULLIF\(EXCLUDED\.contact_name, ''\)/i);
    // $8 = contact_name (ordem: flowId, flowName, telefone, session, source, reason,
    // expires_at, contact_name).
    expect(params[7]).toBe('Wal Delfim');
    expect(params).toHaveLength(8);
  });

  it('SCRUM-144: SEM contactName → $8 = null; caller sem nome NUNCA apaga um nome já capturado (COALESCE/NULLIF no upsert)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await addFlowPause({ flowId: 'clone_x', telefone: '5511999990000', source: 'antibot' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[7]).toBeNull();
    // A garantia de não-apagar é o COALESCE/NULLIF no SQL (não o valor do param): mesmo com
    // $8=NULL, o DO UPDATE preserva flow_pauses.contact_name quando EXCLUDED.contact_name é
    // NULL/''. Reafirma a mesma expressão coberta no teste acima.
    expect(sql).toMatch(/contact_name = COALESCE\(NULLIF\(EXCLUDED\.contact_name, ''\), flow_pauses\.contact_name\)/i);
  });
});

describe('addHumanReplyPause — NÃO rebaixa pausa permanente ativa (N1, SCRUM-60)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('INSERT source human_reply + ON CONFLICT DO UPDATE com WHERE-guard das 3 condições', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const exp = new Date(Date.now() + 3_600_000);
    await addHumanReplyPause({
      flowId: 'clone_meduzza',
      telefone: '5535999998888',
      session: 'SESS',
      reason: 'à mão',
      expiresAt: exp,
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/VALUES \(\$1,\$2,\$3,\$4,TRUE,'human_reply'/i);
    expect(sql).toMatch(/source = 'human_reply'/i);
    expect(sql).toMatch(/expires_at = EXCLUDED\.expires_at/i);
    // O guard: só atualiza se inativa OU já human_reply OU expirada (=> nunca rebaixa
    // permanente ativa de outro source: aí WHERE=false, UPDATE suprimido, INSERT no conflito).
    expect(sql).toMatch(/DO UPDATE SET[\s\S]*WHERE/i);
    expect(sql).toMatch(/flow_pauses\.active = FALSE/i);
    expect(sql).toMatch(/flow_pauses\.source = 'human_reply'/i);
    expect(sql).toMatch(
      /flow_pauses\.expires_at IS NOT NULL AND flow_pauses\.expires_at <= NOW\(\)/i,
    );
    // $6 = expiresAt, $7 = contact_name (ordem: flowId, flowName, telefone, session, reason,
    // expires_at, contact_name) — sem source no param.
    expect(params[5]).toBe(exp);
    expect(params).toHaveLength(7);
  });

  it('expiresAt obrigatório é repassado; telefone/flow escopados por param ($1/$3)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const exp = new Date(Date.now() + 3_600_000);
    await addHumanReplyPause({ flowId: 'clone_x', telefone: '5511999990000', expiresAt: exp });
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[0]).toBe('clone_x');
    expect(params[2]).toBe('5511999990000');
    expect(params[5]).toBe(exp);
  });

  it('SCRUM-144: snapshota contact_name via $7 e preserva o antigo no conflito (COALESCE/NULLIF)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const exp = new Date(Date.now() + 3_600_000);
    await addHumanReplyPause({
      flowId: 'clone_x',
      telefone: '5511999990000',
      expiresAt: exp,
      contactName: 'Wal Delfim',
    });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Coluna contact_name entra no INSERT e o DO UPDATE só sobrescreve se veio nome novo
    // (nome ausente numa renovação não apaga o já capturado).
    expect(sql).toMatch(/INSERT INTO flow_pauses[\s\S]*contact_name/i);
    expect(sql).toMatch(/contact_name = COALESCE\(NULLIF\(EXCLUDED\.contact_name, ''\)/i);
    expect(params[6]).toBe('Wal Delfim');
    expect(params).toHaveLength(7);
  });

  it('SCRUM-144: sem contactName → $7 = null (não grava nem apaga nome)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const exp = new Date(Date.now() + 3_600_000);
    await addHumanReplyPause({ flowId: 'clone_x', telefone: '5511999990000', expiresAt: exp });
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[6]).toBeNull();
  });
});

describe('replaceFlowPauseKeywords — replace-set atômico', () => {
  beforeEach(() => {
    mockClientQuery.mockReset().mockResolvedValue({ rows: [] });
    mockRelease.mockReset();
    mockConnect.mockClear();
  });

  it('BEGIN → DELETE do flow → INSERT de cada linha → COMMIT; libera o client', async () => {
    await replaceFlowPauseKeywords('clone_meduzza', [
      {
        command: 'pause',
        keyword: 'atendente aqui!!',
        keyword_norm: 'atendenteaqui!!',
        enabled: true,
      },
      {
        command: 'resume',
        keyword: 'assistente voltar!!',
        keyword_norm: 'assistentevoltar!!',
        enabled: true,
      },
    ]);
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('DELETE FROM flow_pause_keywords WHERE flow_id = $1');
    expect(calls[2]).toContain('INSERT INTO flow_pause_keywords');
    expect(calls[3]).toContain('INSERT INTO flow_pause_keywords');
    expect(calls[calls.length - 1]).toBe('COMMIT');
    // DELETE escopado ao flow_id (slot do tenant) — anti-IDOR na camada da rota.
    expect(mockClientQuery.mock.calls[1]![1]).toEqual(['clone_meduzza']);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('lista vazia → só BEGIN + DELETE + COMMIT (zera as frases do fluxo)', async () => {
    await replaceFlowPauseKeywords('clone_meduzza', []);
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls).toEqual([
      'BEGIN',
      expect.stringContaining('DELETE FROM flow_pause_keywords'),
      'COMMIT',
    ]);
  });

  it('erro no INSERT → ROLLBACK e re-lança; libera o client', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (sql.startsWith('INSERT')) throw new Error('boom');
      return { rows: [] };
    });
    await expect(
      replaceFlowPauseKeywords('clone_x', [
        {
          command: 'pause',
          keyword: 'atendente aqui!!',
          keyword_norm: 'atendenteaqui!!',
          enabled: true,
        },
      ]),
    ).rejects.toThrow('boom');
    const calls = mockClientQuery.mock.calls.map((c) => String(c[0]));
    expect(calls).toContain('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });
});
