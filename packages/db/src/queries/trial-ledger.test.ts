/**
 * Testes do trial-ledger — foco nas queries do cron de trials órfãos (Missão 020
 * F1, condição 2 do PORTAL_SIGNUP) e no try-lock por slot.
 *
 * `../client.js` é MOCKADO (sem banco). A seleção de candidatos é validada pelo
 * SQL gerado: cada predicado é uma GUARDA de segurança — remover qualquer um
 * (ex.: trial_status='awaiting') quebraria a proteção de Cirilo/clones manuais,
 * e este teste é o tripwire de regressão.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockConnect = vi.fn();

vi.mock('../client.js', () => ({
  pool: { connect: (...args: unknown[]) => mockConnect(...args) },
  query: (...args: unknown[]) => mockQuery(...args),
}));

const {
  countActiveTrials,
  findOrphanTrialClone,
  listOrphanTrialCandidates,
  TRIAL_DAYS,
  withTrialSlotLock,
} = await import('./trial-ledger.js');

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  mockConnect.mockReset();
});

describe('listOrphanTrialCandidates — seleção de candidatos (guardas no SQL)', () => {
  it('SQL filtra SÓ órfão de trial: awaiting + clone_ + rascunho/aguardando_qr + sem due date + idade', async () => {
    await listOrphanTrialCandidates(72, 20);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];

    // Guarda 1: SÓ trial_status='awaiting' — 'none' (Cirilo/manuais) e 'exempt'
    // JAMAIS entram. É filtro de IGUALDADE, não lista.
    expect(sql).toContain(`fc.trial_status = 'awaiting'`);
    expect(sql).not.toContain(`'none'`);
    expect(sql).not.toContain(`'exempt'`);
    // Guarda 2: prefixo clone_ (LIKE com underscore escapado).
    expect(sql).toContain(`fc.slot LIKE 'clone\\_%'`);
    // Guarda 3: nunca progrediu (mesma guarda do teardown).
    expect(sql).toContain(`fc.status IN ('rascunho', 'aguardando_qr')`);
    // Guarda 4: trial nunca iniciou (startTrial sempre seta a data).
    expect(sql).toContain('cb.next_due_date IS NULL');
    // Guarda 5: idade limite parametrizada (nunca interpolada).
    expect(sql).toContain('make_interval(hours => $1)');
    expect(params).toEqual([72, 20]);
    // LGPD: o cron nunca seleciona telefone.
    expect(sql).not.toContain('cliente_telefone');
  });

  it('normaliza age_hours numérico (pg devolve string em EXTRACT)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          slot: 'clone_x_ab12cd',
          waha_sessao: 'clone_x_ab12cd',
          status: 'aguardando_qr',
          trial_status: 'awaiting',
          age_hours: '80.51',
        },
      ],
    });

    const rows = await listOrphanTrialCandidates(72, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.age_hours).toBeCloseTo(80.51);
  });
});

describe('TRIAL_DAYS — janela de teste grátis', () => {
  // Decisão Bruno 2026-07-14: 7 dias (era 10). Trava a constante contra regressão
  // e mantém a copy do portal (7 dias grátis) alinhada ao backend.
  it('é 7 dias', () => {
    expect(TRIAL_DAYS).toBe(7);
  });
});

describe('countActiveTrials — teto anti-DoS (guardas no SQL)', () => {
  // `../client.js` é mockado: o SQL É o contrato. Cada predicado abaixo é uma
  // guarda de negócio; removê-lo quebra o teto ou volta o bug do pagante contado.
  it('exclui PAGANTE convertido, conta awaiting e conta active dentro da janela', async () => {
    await countActiveTrials();

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];

    // Pagante NÃO conta: last_payment_at preenchido = pagante (critério canônico
    // do negócio), fora do teto — vale pra qualquer trial_status. É a 1ª guarda,
    // ANDada com o resto (não pode virar OR — senão pagante voltaria a contar).
    expect(sql).toContain('cb.last_payment_at IS NULL');
    // ESTRUTURAL (não só substring): a guarda do pagante precisa estar ANDada
    // com o grupo de trial_status, nunca ORada. Um `... IS NULL OR (...)`
    // reintroduziria EXATAMENTE o bug P1 (pagante voltando a contar) e passaria
    // nos toContain acima — este toMatch ancora o `AND (` logo após a guarda.
    expect(sql).toMatch(/cb\.last_payment_at IS NULL\s+AND\s*\(/);
    // awaiting (e blocked) CONTAM: sessão viva sem pagamento.
    expect(sql).toContain(`fc.trial_status IN ('awaiting', 'blocked')`);
    // active CONTA só dentro da janela (next_due_date NULL ou >= hoje UTC):
    // active vencido já saiu do trial pendente.
    expect(sql).toContain(`fc.trial_status = 'active'`);
    expect(sql).toContain('cb.next_due_date IS NULL');
    expect(sql).toContain(`cb.next_due_date >= (NOW() AT TIME ZONE 'utc')::date`);
  });

  it('normaliza o COUNT (pg devolve string) para número', async () => {
    mockQuery.mockResolvedValue({ rows: [{ count: '3' }] });
    expect(await countActiveTrials()).toBe(3);
  });

  it('sem linhas => 0 (defensivo)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await countActiveTrials()).toBe(0);
  });
});

describe('findOrphanTrialClone — recheck fresh dentro do lock', () => {
  it('usa as MESMAS guardas da listagem + filtro de slot parametrizado', async () => {
    await findOrphanTrialClone('clone_x_ab12cd', 72);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`fc.trial_status = 'awaiting'`);
    expect(sql).toContain(`fc.slot LIKE 'clone\\_%'`);
    expect(sql).toContain(`fc.status IN ('rascunho', 'aguardando_qr')`);
    expect(sql).toContain('cb.next_due_date IS NULL');
    expect(sql).toContain('fc.slot = $2');
    expect(params).toEqual([72, 'clone_x_ab12cd']);
  });

  it('retorna null quando o slot deixou de ser órfão (pareou no meio)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await findOrphanTrialClone('clone_x_ab12cd', 72)).toBeNull();
  });
});

describe('withTrialSlotLock — try-lock por slot (mesmo lock do trial-pairing)', () => {
  function fakeLockClient(locked: boolean) {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes('pg_try_advisory_xact_lock')) {
          return { rows: [{ locked }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mockConnect.mockResolvedValue(client);
    return { client, queries };
  }

  it('lock livre: executa o fn dentro da transação e COMMITa', async () => {
    const { queries } = fakeLockClient(true);
    const fn = vi.fn(async () => 'feito');

    const r = await withTrialSlotLock('clone_x_ab12cd', fn);

    expect(r).toEqual({ acquired: true, result: 'feito' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(queries).toContain('COMMIT');
  });

  it('lock OCUPADO (pareamento em curso): NÃO executa o fn e faz ROLLBACK', async () => {
    const { queries, client } = fakeLockClient(false);
    const fn = vi.fn();

    const r = await withTrialSlotLock('clone_x_ab12cd', fn);

    expect(r).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
    expect(queries).toContain('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});
