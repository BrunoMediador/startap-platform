/**
 * Testes do módulo alerts (Missão 021, Fase 1).
 *
 * `../client.js` é MOCKADO (sem banco). Foco:
 *  - listMonitoredSessions: as GUARDAS no SQL que evitam alertar sobre pré-setup
 *    (rascunho/aguardando_qr) e trials 'awaiting' (Cirilo/Samuel sim, FAILED
 *    esperado não) — tripwire de regressão;
 *  - addRecipient: caminho feliz + o teto de 5 (erro tipado);
 *  - reserveGlobalSend: hard cap global (permite até o teto, suprime depois).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
const mockConnect = vi.fn();

vi.mock('../client.js', () => ({
  pool: { connect: (...args: unknown[]) => mockConnect(...args) },
  query: (...args: unknown[]) => mockQuery(...args),
}));

const {
  addRecipient,
  getSenderSession,
  getMonitorHeartbeat,
  listMonitoredSessions,
  recordCycleHeartbeat,
  reserveGlobalSend,
  TooManyRecipientsError,
  MAX_RECIPIENTS,
} = await import('./alerts.js');

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockConnect.mockReset();
});

describe('getSenderSession — repoint do remetente (Missão 023 W3)', () => {
  it('com sender_slot="alertas" resolve pra waha_sessao="ALERTAS"', async () => {
    // Pós-repoint (migration 049): bot_config slot 'alertas' → sessão dedicada 'ALERTAS'.
    mockQuery.mockResolvedValueOnce({ rows: [{ waha_sessao: 'ALERTAS' }] });

    const sessao = await getSenderSession('alertas');

    // Lê bot_config.waha_sessao parametrizado pelo slot (sem hardcode de sessão).
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('SELECT waha_sessao FROM bot_config WHERE slot = $1');
    expect(params).toEqual(['alertas']);
    expect(sessao).toBe('ALERTAS');
  });

  it('degrada gracioso (null) se o slot remetente não tiver waha_sessao mapeado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getSenderSession('alertas')).toBeNull();
  });
});

describe('listMonitoredSessions — guardas no SQL (não alertar pré-setup; vigia queda real)', () => {
  it('vigia clones JÁ pareados (conectado/desconectado), NÃO awaiting, e adiciona o remetente', async () => {
    // 1ª query: clones monitorados (agora retornam slot). 2ª query (getSenderSession): remetente.
    // Pós-repoint o remetente é a sessão dedicada 'ALERTAS' (sender_slot='alertas').
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          {
            slot: 'clone_cirilo',
            waha_sessao: 'cirilo_barbaershop',
            display_name: 'Barbearia do Cirilo',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'ALERTAS' }] });

    const sessions = await listMonitoredSessions('alertas');

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    // FIX do bug (Seven 7): vigia clones que JÁ conectaram alguma vez (first_connected_at não
    // nulo) e que estão em 'conectado' OU 'desconectado'. Antes era `status = 'conectado'` só —
    // a sessão saía da lista no instante em que caía e o monitor nunca via a queda.
    expect(sql).toContain('fc.first_connected_at IS NOT NULL');
    expect(sql).toContain(`fc.status IN ('conectado', 'desconectado')`);
    // ANTI-PRÉ-SETUP preservado: o filtro NÃO usa mais `status = 'conectado'` sozinho.
    expect(sql).not.toContain(`fc.status = 'conectado'`);
    // Trials aguardando QR (FAILED esperado) jamais entram.
    expect(sql).toContain(`fc.trial_status <> 'awaiting'`);
    // Nunca seleciona sessão vazia/nula.
    expect(sql).toContain('fc.waha_sessao IS NOT NULL');

    // Resultado: clone do Cirilo (com slot p/ resolver o dono) + a sessão remetente (slot=null).
    expect(sessions).toEqual([
      { sessao: 'cirilo_barbaershop', label: 'Barbearia do Cirilo', slot: 'clone_cirilo' },
      { sessao: 'ALERTAS', label: 'Sessão de alertas (remetente)', slot: null },
    ]);
  });

  it('não duplica a sessão remetente se ela já for um clone monitorado', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ slot: 'clone_alertas', waha_sessao: 'ALERTAS', display_name: 'Alertas' }],
      })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'ALERTAS' }] });

    const sessions = await listMonitoredSessions('alertas');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessao).toBe('ALERTAS');
    // Quando o remetente JÁ é um clone monitorado, mantém o slot do clone (não vira null).
    expect(sessions[0]?.slot).toBe('clone_alertas');
  });
});

describe('addRecipient — caminho feliz + teto de destinatários', () => {
  function fakeClient(handler: (text: string, params?: unknown[]) => unknown) {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        queries.push(text);
        return handler(text, params);
      }),
      release: vi.fn(),
    };
    mockConnect.mockResolvedValue(client);
    return { client, queries };
  }

  it('insere quando abaixo do teto e sem duplicata (COMMIT)', async () => {
    const { queries } = fakeClient((text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ count: '2' }] };
      if (text.startsWith('SELECT 1')) return { rows: [], rowCount: 0 };
      if (text.includes('INSERT INTO alert_recipients')) {
        return {
          rows: [
            {
              id: '7',
              phone: '5531999998888',
              label: 'Bruno',
              enabled: true,
              created_at: new Date(),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const row = await addRecipient({ phone: '5531999998888', label: 'Bruno' });

    expect(row.id).toBe(7); // normalizado de string -> number
    expect(row.phone).toBe('5531999998888');
    expect(queries).toContain('COMMIT');
  });

  it('rejeita o 6º destinatário com TooManyRecipientsError (ROLLBACK, sem INSERT)', async () => {
    const { queries } = fakeClient((text) => {
      if (text.includes('COUNT(*)')) return { rows: [{ count: String(MAX_RECIPIENTS) }] };
      return { rows: [] };
    });

    await expect(addRecipient({ phone: '5531911112222' })).rejects.toBeInstanceOf(
      TooManyRecipientsError,
    );
    expect(queries).toContain('ROLLBACK');
    expect(queries.some((q) => q.includes('INSERT INTO alert_recipients'))).toBe(false);
  });
});

describe('reserveGlobalSend — hard cap global anti-flood', () => {
  function fakeCapClient(currentCount: number, windowStart: Date | null) {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        if (text.includes('FOR UPDATE')) {
          return { rows: [{ alert_count: String(currentCount), down_since: windowStart }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    mockConnect.mockResolvedValue(client);
    return { client, queries };
  }

  it('permite envio abaixo do teto e incrementa o contador', async () => {
    const { queries } = fakeCapClient(3, new Date());
    const r = await reserveGlobalSend({ maxPerWindow: 10, windowMin: 30 });
    expect(r.allowed).toBe(true);
    expect(r.sentInWindow).toBe(4);
    expect(queries.some((q) => q.includes('alert_count + 1'))).toBe(true);
    expect(queries).toContain('COMMIT');
  });

  it('suprime quando o teto da janela foi atingido (não incrementa)', async () => {
    const { queries } = fakeCapClient(10, new Date());
    const r = await reserveGlobalSend({ maxPerWindow: 10, windowMin: 30 });
    expect(r.allowed).toBe(false);
    expect(r.sentInWindow).toBe(10);
    expect(queries.some((q) => q.includes('alert_count + 1'))).toBe(false);
  });

  it('reseta a janela e libera quando window_start expirou', async () => {
    const old = new Date(Date.now() - 31 * 60_000); // 31 min atrás, janela de 30
    const { queries } = fakeCapClient(10, old);
    const r = await reserveGlobalSend({ maxPerWindow: 10, windowMin: 30 });
    expect(r.allowed).toBe(true);
    expect(r.sentInWindow).toBe(1);
    expect(queries.some((q) => q.includes('alert_count = 1, down_since = NOW()'))).toBe(true);
  });
});

describe('heartbeat de liveness do monitor (SCRUM-54)', () => {
  it('recordCycleHeartbeat: upsert da __global__ só avança last_cycle_at (não toca cap)', async () => {
    await recordCycleHeartbeat();

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alert_states');
    expect(sql).toContain('last_cycle_at = NOW()');
    // Isolamento do hard cap: NÃO mexe em down_since (window_start) nem alert_count (contador).
    expect(sql).not.toContain('down_since');
    expect(sql).not.toContain('alert_count');
    // Carimba a linha sintética global.
    expect(params).toEqual(['__global__']);
  });

  it('getMonitorHeartbeat: lê last_cycle_at da __global__ (null quando nunca ticou)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getMonitorHeartbeat()).toBeNull();

    const ts = new Date('2026-07-02T12:00:00.000Z');
    mockQuery.mockResolvedValueOnce({ rows: [{ last_cycle_at: ts }] });
    expect(await getMonitorHeartbeat()).toBe(ts);

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('SELECT last_cycle_at FROM alert_states WHERE check_key = $1');
    expect(params).toEqual(['__global__']);
  });
});
