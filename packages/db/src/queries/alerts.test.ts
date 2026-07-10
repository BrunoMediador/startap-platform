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
  resolveMonitorExtraSessions,
  restoreStateIfUnchanged,
  DEFAULT_MONITOR_EXTRA_SESSIONS,
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

    // env {} = sem override -> vale o default do código (STARTAP_AI_PROD/Lola entra na vigia).
    const sessions = await listMonitoredSessions('alertas', {});

    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    // FIX do bug (Seven 7): vigia clones que JÁ conectaram alguma vez (first_connected_at não
    // nulo) e que estão em 'conectado' OU 'desconectado'. Antes era `status = 'conectado'` só —
    // a sessão saía da lista no instante em que caía e o monitor nunca via a queda.
    expect(sql).toContain('fc.first_connected_at IS NOT NULL');
    expect(sql).toContain(`fc.status IN ('conectado', 'desconectado')`);
    // ANTI-PRÉ-SETUP preservado: o filtro NÃO usa mais `status = 'conectado'` sozinho.
    expect(sql).not.toContain(`fc.status = 'conectado'`);
    // SCRUM-64: sessão PARADA de propósito (status 'parado') NUNCA entra na vigia -> sem
    // alerta de queda falso. Guarda contra alguém adicionar 'parado' ao filtro por engano.
    expect(sql).not.toContain('parado');
    // Trials aguardando QR (FAILED esperado) jamais entram.
    expect(sql).toContain(`fc.trial_status <> 'awaiting'`);
    // Nunca seleciona sessão vazia/nula.
    expect(sql).toContain('fc.waha_sessao IS NOT NULL');

    // Resultado: clone do Cirilo (com slot p/ resolver o dono) + a sessão remetente (slot=null)
    // + a sessão crítica não-clone do default (Lola/STARTAP_AI_PROD, slot=null — SCRUM-56).
    expect(sessions).toEqual([
      { sessao: 'cirilo_barbaershop', label: 'Barbearia do Cirilo', slot: 'clone_cirilo' },
      { sessao: 'ALERTAS', label: 'Sessão de alertas (remetente)', slot: null },
      { sessao: 'STARTAP_AI_PROD', label: 'STARTAP_AI_PROD (sessão crítica)', slot: null },
    ]);
  });

  it('não duplica a sessão remetente se ela já for um clone monitorado', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ slot: 'clone_alertas', waha_sessao: 'ALERTAS', display_name: 'Alertas' }],
      })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'ALERTAS' }] });

    // Env soma ALERTAS às extras (união): ALERTAS já é clone (query 1), o remetente E a
    // sessão extra colidem no dedup -> aparece UMA vez só, com o slot do clone preservado.
    const sessions = await listMonitoredSessions('alertas', {
      MONITOR_EXTRA_SESSIONS: 'ALERTAS',
    });
    const alertasEntries = sessions.filter((s) => s.sessao === 'ALERTAS');
    expect(alertasEntries).toHaveLength(1);
    // Quando o remetente/extra JÁ é um clone monitorado, mantém o slot do clone (não vira null).
    expect(alertasEntries[0]?.slot).toBe('clone_alertas');
  });
});

describe('resolveMonitorExtraSessions — sessões críticas não-clone (SCRUM-56)', () => {
  it('env ausente -> default do código (STARTAP_AI_PROD/Lola)', () => {
    expect(resolveMonitorExtraSessions({})).toEqual(['STARTAP_AI_PROD']);
    expect(DEFAULT_MONITOR_EXTRA_SESSIONS).toContain('STARTAP_AI_PROD');
  });

  it('env vazia/whitespace -> cai no default (não zera a vigia)', () => {
    expect(resolveMonitorExtraSessions({ MONITOR_EXTRA_SESSIONS: '' })).toEqual([
      'STARTAP_AI_PROD',
    ]);
    expect(resolveMonitorExtraSessions({ MONITOR_EXTRA_SESSIONS: '   ' })).toEqual([
      'STARTAP_AI_PROD',
    ]);
  });

  it('env ADICIONA ao default (união) — nunca tira a Lola da vigia', () => {
    // O default vem SEMPRE primeiro; a env soma por cima.
    expect(
      resolveMonitorExtraSessions({ MONITOR_EXTRA_SESSIONS: 'WHATSAPP_ROUTER_TESTE' }),
    ).toEqual(['STARTAP_AI_PROD', 'WHATSAPP_ROUTER_TESTE']);
    // Fail-safe: setar a env com OUTRA sessão NÃO remove a Lola (contraste com override).
    expect(resolveMonitorExtraSessions({ MONITOR_EXTRA_SESSIONS: 'OUTRA_SESSAO' })).toContain(
      'STARTAP_AI_PROD',
    );
  });

  it('dedupe entre default e env (env repetindo a Lola não duplica)', () => {
    expect(
      resolveMonitorExtraSessions({ MONITOR_EXTRA_SESSIONS: 'STARTAP_AI_PROD, EXTRA' }),
    ).toEqual(['STARTAP_AI_PROD', 'EXTRA']);
  });

  it('trim + dedupe + ignora itens vazios (default sempre incluso)', () => {
    expect(resolveMonitorExtraSessions({ MONITOR_EXTRA_SESSIONS: ' A , A ,, B ,' })).toEqual([
      'STARTAP_AI_PROD',
      'A',
      'B',
    ]);
  });
});

describe('listMonitoredSessions — vigia sessões críticas não-clone (SCRUM-56, Lola)', () => {
  it('inclui STARTAP_AI_PROD (default) na lista mesmo sem clone/env, slot=null', async () => {
    // Sem clones (query 1 vazia) e remetente ALERTAS (query 2). O default deve trazer a Lola.
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'ALERTAS' }] });

    const sessions = await listMonitoredSessions('alertas', {});

    // A Lola vira um item que o monitor consome como check `waha:STARTAP_AI_PROD` (slot=null:
    // dispara só o alerta INTERNO ao Bruno, nunca aviso ao "dono" — não é clone de cliente).
    const lola = sessions.find((s) => s.sessao === 'STARTAP_AI_PROD');
    expect(lola).toEqual({
      sessao: 'STARTAP_AI_PROD',
      label: 'STARTAP_AI_PROD (sessão crítica)',
      slot: null,
    });
  });

  it('env ADICIONA sessão extra e mantém o default (união — Lola nunca sai)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'ALERTAS' }] });

    const sessions = await listMonitoredSessions('alertas', {
      MONITOR_EXTRA_SESSIONS: 'LOLA_V2',
    });

    // União: a Lola (default) CONTINUA vigiada mesmo com a env somando outra sessão.
    expect(sessions.some((s) => s.sessao === 'STARTAP_AI_PROD')).toBe(true);
    expect(sessions.some((s) => s.sessao === 'LOLA_V2')).toBe(true);
  });

  it('não rebaixa a slot=null se a sessão extra JÁ for um clone (mantém o dono)', async () => {
    // A sessão extra colide com um clone real (slot preenchido) -> o clone tem precedência.
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ slot: 'clone_x', waha_sessao: 'STARTAP_AI_PROD', display_name: 'Clone X' }],
      })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'ALERTAS' }] });

    const sessions = await listMonitoredSessions('alertas', {});
    const entry = sessions.filter((s) => s.sessao === 'STARTAP_AI_PROD');
    expect(entry).toHaveLength(1);
    expect(entry[0]?.slot).toBe('clone_x'); // não virou null
  });

  it('clones do #390 continuam vigiados junto das sessões críticas (não regride)', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { slot: 'clone_cirilo', waha_sessao: 'cirilo_barbaershop', display_name: 'Cirilo' },
          { slot: 'clone_samuel', waha_sessao: 'samuel_barber', display_name: 'Samuel' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ waha_sessao: 'ALERTAS' }] });

    const sessions = await listMonitoredSessions('alertas', {});
    const names = sessions.map((s) => s.sessao);
    expect(names).toContain('cirilo_barbaershop');
    expect(names).toContain('samuel_barber');
    expect(names).toContain('ALERTAS');
    expect(names).toContain('STARTAP_AI_PROD');
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
  it('recordCycleHeartbeat: UPSERT da __heartbeat__ (dedicada) só avança last_cycle_at (não toca cap)', async () => {
    await recordCycleHeartbeat();

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // UPSERT (não UPDATE seco): seed a linha na 1ª vez, avança o timestamp nas seguintes.
    expect(sql).toContain('INSERT INTO alert_states');
    expect(sql).toContain('ON CONFLICT (check_key) DO UPDATE');
    expect(sql).toContain('last_cycle_at = NOW()');
    // Isolamento do hard cap: NÃO mexe em down_since (window_start) nem alert_count (contador).
    expect(sql).not.toContain('down_since');
    expect(sql).not.toContain('alert_count');
    // Carimba a linha sintética DEDICADA ao heartbeat (separada da __global__ do hard cap).
    expect(params).toEqual(['__heartbeat__']);
  });

  it('getMonitorHeartbeat: lê last_cycle_at da __heartbeat__ (null quando nunca ticou)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getMonitorHeartbeat()).toBeNull();

    const ts = new Date('2026-07-02T12:00:00.000Z');
    mockQuery.mockResolvedValueOnce({ rows: [{ last_cycle_at: ts }] });
    expect(await getMonitorHeartbeat()).toBe(ts);

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('SELECT last_cycle_at FROM alert_states WHERE check_key = $1');
    expect(params).toEqual(['__heartbeat__']);
  });
});

describe('restoreStateIfUnchanged — compensação condicional do carimbo (SCRUM-53)', () => {
  const stampedAt = new Date('2026-07-02T12:00:00.000Z');
  const prevAt = new Date('2026-07-02T06:00:00.000Z');

  it('restaura quando a linha AINDA contém o carimbo deste ciclo (rowCount 1 -> true)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const restored = await restoreStateIfUnchanged({
      checkKey: 'clientdown:clone_x',
      expect: { state: 'down', lastAlertAt: stampedAt, alertCount: 3 },
      restore: {
        state: 'down',
        downSince: prevAt,
        lastAlertAt: prevAt,
        alertCount: 2,
        pendingDownCount: 0,
      },
    });

    expect(restored).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // Predicado de lock otimista: só bate se state/alert_count/last_alert_at forem os que gravamos.
    expect(sql).toContain('UPDATE alert_states');
    expect(sql).toContain('AND state       = $7');
    expect(sql).toContain('AND alert_count = $8');
    // NULL-safe: compara last_alert_at com IS NOT DISTINCT FROM (não `=`, que falha com NULL).
    expect(sql).toContain('last_alert_at IS NOT DISTINCT FROM $9');
    // $7/$8/$9 = o valor esperado (o que ESTE ciclo carimbou).
    expect(params[6]).toBe('down');
    expect(params[7]).toBe(3);
    expect(params[8]).toBe(stampedAt);
  });

  it('NÃO restaura quando outro ciclo já regravou a linha (rowCount 0 -> false)', async () => {
    // rowCount 0 = o predicado do WHERE não bateu -> reserva de OUTRO ciclo preservada (anti-dup).
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const restored = await restoreStateIfUnchanged({
      checkKey: 'clientdown:clone_x',
      expect: { state: 'down', lastAlertAt: stampedAt, alertCount: 3 },
      restore: {
        state: 'up',
        downSince: null,
        lastAlertAt: null,
        alertCount: 0,
        pendingDownCount: 0,
      },
    });

    expect(restored).toBe(false);
  });

  it('lida com expect.lastAlertAt null (primeiro episódio, sem carimbo anterior)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    await restoreStateIfUnchanged({
      checkKey: 'waha:pg:main',
      expect: { state: 'down', lastAlertAt: null, alertCount: 1 },
      restore: {
        state: 'up',
        downSince: null,
        lastAlertAt: null,
        alertCount: 0,
        pendingDownCount: 0,
      },
    });

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params[8]).toBeNull(); // expect.lastAlertAt null vira $9 = null (IS NOT DISTINCT FROM NULL)
  });
});
