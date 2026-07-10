/**
 * Testes da data layer de rastreio de entrega (SCRUM-58).
 *
 * `../client.js` é MOCKADO (`query`) — não toca banco. Validamos SQL parametrizado ($1..$n),
 * a semântica monotônica do applyAck (usa mapWahaAck real do core), e normalização de tipos.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../client.js', () => ({ query: (...a: unknown[]) => mockQuery(...a) }));

const {
  recordOutbound,
  applyAck,
  listAlertable,
  markAlerted,
  markAlertedForSession,
  pruneOldOutbound,
} = await import('./outbound-messages.js');

function lastCall(): [string, unknown[]] {
  const calls = mockQuery.mock.calls;
  return calls[calls.length - 1] as [string, unknown[]];
}

beforeEach(() => mockQuery.mockReset());

describe('recordOutbound', () => {
  it('INSERT idempotente (ON CONFLICT DO NOTHING) com params na ordem certa', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    const inserted = await recordOutbound({
      messageId: 'true_55@c.us_X',
      session: 'cirilo',
      slot: 'clone_cirilo',
      phoneHint: '+55 11 •••••-••88',
    });
    expect(inserted).toBe(true);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/INSERT INTO outbound_messages/);
    expect(sql).toMatch(/ON CONFLICT \(message_id\) DO NOTHING/);
    expect(sql).toMatch(/'PENDING'/);
    expect(params).toEqual(['true_55@c.us_X', 'cirilo', 'clone_cirilo', '+55 11 •••••-••88']);
  });

  it('conflito (linha já existe) → false', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });
    expect(await recordOutbound({ messageId: 'x', session: 's', slot: null, phoneHint: 'h' })).toBe(
      false,
    );
  });
});

describe('applyAck — monotônico + terminal', () => {
  it('ack 2 (DEVICE) → UPDATE "só sobe" (terminal=false, rank 2)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ message_id: 'x', session: 's', slot: 'clone_x', ack_status: 'DEVICE', ack_code: 2 }],
    });
    const out = await applyAck({ messageId: 'x', ackCode: 2, ackName: 'DEVICE' });
    expect(out).toEqual({
      message_id: 'x',
      session: 's',
      slot: 'clone_x',
      ack_status: 'DEVICE',
      ack_code: 2,
    });
    const [sql, params] = lastCall();
    expect(sql).toMatch(/UPDATE outbound_messages/);
    expect(sql).toMatch(/ack_status <> 'ERROR'/);
    // params: [id, status, rank, code, terminal]
    expect(params).toEqual(['x', 'DEVICE', 2, 2, false]);
  });

  it('ack -1 (ERROR/463) → terminal=true, rank -1', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ message_id: 'x', session: 's', slot: null, ack_status: 'ERROR', ack_code: -1 }],
    });
    const out = await applyAck({ messageId: 'x', ackCode: -1, ackName: 'ERROR' });
    expect(out?.ack_status).toBe('ERROR');
    const [, params] = lastCall();
    expect(params).toEqual(['x', 'ERROR', -1, -1, true]);
  });

  it('read (ack 3) → status READ, terminal=false (não dispara nada de negativo)', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ message_id: 'x', session: 's', slot: null, ack_status: 'READ', ack_code: 3 }],
    });
    await applyAck({ messageId: 'x', ackCode: 3, ackName: 'READ' });
    const [, params] = lastCall();
    expect(params).toEqual(['x', 'READ', 3, 3, false]);
  });

  it('mensagem desconhecida / update sem efeito → null', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await applyAck({ messageId: 'nope', ackCode: 2 })).toBeNull();
  });
});

describe('listAlertable', () => {
  it('SQL cobre ERROR e (PENDING|SERVER preso) não-alertado, prioriza antigos, normaliza tipos', async () => {
    const stuckBefore = new Date('2026-07-08T00:00:00Z');
    mockQuery.mockResolvedValue({
      rows: [
        {
          message_id: 'e1',
          session: 's',
          slot: 'clone_x',
          phone_hint: 'h',
          ack_status: 'ERROR',
          ack_rank: '-1',
          ack_code: '-1',
          alerted_at: null,
          created_at: new Date('2026-07-07T00:00:00Z'),
          updated_at: new Date('2026-07-07T00:00:00Z'),
        },
      ],
    });
    const rows = await listAlertable({ stuckBefore, limit: 25 });
    expect(rows[0].ack_rank).toBe(-1);
    expect(rows[0].ack_code).toBe(-1);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/alerted_at IS NULL/);
    expect(sql).toMatch(/ack_status = 'ERROR'/);
    expect(sql).toMatch(/ack_status IN \('PENDING', 'SERVER'\)/);
    expect(sql).toMatch(/ORDER BY created_at ASC/);
    expect(params).toEqual([stuckBefore, 25]);
  });
});

describe('markAlerted', () => {
  it('carimba alerted_at só se ainda NULL (idempotente)', async () => {
    mockQuery.mockResolvedValue({ rowCount: 1 });
    const at = new Date('2026-07-08T10:00:00Z');
    expect(await markAlerted('x', at)).toBe(true);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/alerted_at IS NULL/);
    expect(params).toEqual(['x', at]);
  });

  it('já alertado → false', async () => {
    mockQuery.mockResolvedValue({ rowCount: 0 });
    expect(await markAlerted('x')).toBe(false);
  });
});

describe('markAlertedForSession', () => {
  it('marca todos os alertáveis não-avisados da sessão (ERROR ou preso) numa tacada', async () => {
    mockQuery.mockResolvedValue({ rowCount: 5 });
    const stuckBefore = new Date('2026-07-08T00:00:00Z');
    const at = new Date('2026-07-08T10:00:00Z');
    const n = await markAlertedForSession({ session: 'lola', stuckBefore, at });
    expect(n).toBe(5);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/UPDATE outbound_messages/);
    expect(sql).toMatch(/alerted_at IS NULL/);
    expect(sql).toMatch(/ack_status = 'ERROR'/);
    expect(params).toEqual(['lola', stuckBefore, at]);
  });
});

describe('pruneOldOutbound', () => {
  it('DELETE parametrizado por idade, retorna contagem', async () => {
    mockQuery.mockResolvedValue({ rowCount: 42 });
    expect(await pruneOldOutbound(7)).toBe(42);
    const [sql, params] = lastCall();
    expect(sql).toMatch(/DELETE FROM outbound_messages/);
    expect(params).toEqual(['7']);
  });
});
