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
  listMonitoredSessions,
  reserveGlobalSend,
  TooManyRecipientsError,
  MAX_RECIPIENTS,
} = await import('./alerts.js');

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  mockConnect.mockReset();
});

describe('listMonitoredSessions — guardas no SQL (não alertar pré-setup)', () => {
  it('filtra SÓ clones conectados e NÃO awaiting, e adiciona a sessão da Lola', async () => {
    // 1ª query: clones monitorados. 2ª query (getSenderSession): waha_sessao da Lola.
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ waha_sessao: 'cirilo_barbaershop', display_name: 'Barbearia do Cirilo' }],
      })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'STARTAP_AI_PROD' }] });

    const sessions = await listMonitoredSessions('startap');

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Só clones JÁ conectados (pareados) — pré-setup nunca entra.
    expect(sql).toContain(`fc.status = 'conectado'`);
    // Trials aguardando QR (FAILED esperado) jamais entram.
    expect(sql).toContain(`fc.trial_status <> 'awaiting'`);
    // Nunca seleciona sessão vazia/nula.
    expect(sql).toContain('fc.waha_sessao IS NOT NULL');

    // Resultado: clone do Cirilo + Lola (remetente), dedup por nome.
    expect(sessions).toEqual([
      { sessao: 'cirilo_barbaershop', label: 'Barbearia do Cirilo' },
      { sessao: 'STARTAP_AI_PROD', label: 'Lola (remetente de alertas)' },
    ]);
  });

  it('não duplica a Lola se ela já for um clone monitorado', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ waha_sessao: 'STARTAP_AI_PROD', display_name: 'Lola' }],
      })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'STARTAP_AI_PROD' }] });

    const sessions = await listMonitoredSessions('startap');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessao).toBe('STARTAP_AI_PROD');
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
