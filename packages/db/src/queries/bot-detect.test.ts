/**
 * Testes do módulo de queries bot-detect (SCRUM-4 PR-C).
 *
 * `../client.js` é MOCKADO (sem banco). Foco:
 *  - getHumanMessages REJEITA nome de chat_table inválido (defesa SQL injection — o nome de
 *    tabela não pode ser parametrizado, então é validado antes de interpolar);
 *  - parametrização correta (slot/sessão/telefone) nas leituras escopadas por clone;
 *  - markAlerted é idempotente (guarda alerted_at IS NULL) e devolve true só quando carimba.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const {
  getCloneInfo,
  listUnclassifiedCandidates,
  getHumanMessages,
  markAlerted,
  upsertClassification,
} = await import('./bot-detect.js');

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('getHumanMessages — guarda contra SQL injection no nome da tabela', () => {
  it('rejeita chat_table fora do padrão chat_histories[_suffix]', async () => {
    await expect(
      getHumanMessages('chat_histories; DROP TABLE flow_clones', '5511999990000', 20),
    ).rejects.toThrow(/chat_table inválida/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('aceita chat_table válida e filtra por sufixo de telefone + type=human', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ content: 'oi' }, { content: null }, { content: 'promo' }],
      rowCount: 3,
    });
    const out = await getHumanMessages('chat_histories_dragon', '5511999990000', 20);
    expect(out).toEqual(['oi', 'promo']); // descarta content null
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('chat_histories_dragon');
    expect(sql).toContain("message->>'type' = 'human'");
    expect(params).toEqual(['5511999990000', 20]);
  });
});

describe('getCloneInfo — escopo por slot + exige sessão', () => {
  it('retorna null quando o clone não tem waha_sessao (nada a varrer)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ slot: 'clone_x', waha_sessao: '', chat_table: 'chat_histories' }],
      rowCount: 1,
    });
    expect(await getCloneInfo('clone_x')).toBeNull();
  });

  it('parametriza o slot', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ slot: 'clone_x', waha_sessao: 'SESS', chat_table: 'chat_histories' }],
      rowCount: 1,
    });
    const info = await getCloneInfo('clone_x');
    expect(info).toEqual({ slot: 'clone_x', waha_sessao: 'SESS', chat_table: 'chat_histories' });
    expect(mockQuery.mock.calls[0][1]).toEqual(['clone_x']);
  });
});

describe('listUnclassifiedCandidates — cache via NOT EXISTS, escopado por sessão+slot', () => {
  it('passa sessão, slot e limite e exclui já-classificados (NOT EXISTS)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ phone: '5511999990000', total: '7' }],
      rowCount: 1,
    });
    const out = await listUnclassifiedCandidates('clone_x', 'SESS', 50);
    expect(out).toEqual([{ telefone: '5511999990000', total: 7 }]);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('contact_classification');
    expect(params).toEqual(['SESS', 'clone_x', 50]);
  });
});

describe('markAlerted — idempotente (1× por número)', () => {
  it('devolve true quando carimba (rowCount > 0) e guarda alerted_at IS NULL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const at = new Date('2026-06-27T12:00:00Z');
    expect(await markAlerted('clone_x', '5511999990000', at)).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('alerted_at IS NULL');
    expect(params).toEqual(['clone_x', '5511999990000', at]);
  });

  it('devolve false quando já estava alertado (rowCount 0)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await markAlerted('clone_x', '5511999990000')).toBe(false);
  });
});

describe('upsertClassification — idempotente (ON CONFLICT) e serializa signals', () => {
  it('faz ON CONFLICT DO UPDATE e envia signals como JSON string', async () => {
    await upsertClassification({
      flowId: 'clone_x',
      telefone: '5511999990000',
      verdict: 'bot',
      confidence: 0.7,
      signals: { timing: { fired: true } },
      source: 'heuristic',
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (flow_id, telefone) DO UPDATE');
    expect(params[0]).toBe('clone_x');
    expect(params[2]).toBe('bot');
    expect(params[4]).toBe(JSON.stringify({ timing: { fired: true } }));
    expect(params[5]).toBe('heuristic');
  });
});
