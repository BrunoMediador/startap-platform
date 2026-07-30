/**
 * SCRUM-148 item 2 (LGPD art. 12 §2) — o reconcile-packages NUNCA loga gcal_event_id CRU.
 *
 * O #531 fechou o caminho de ERRO do GCal, mas o card tinha um item 2: este job logava
 * `gcalEventIds: s.gcal_event_ids` — um ARRAY de ids CRUS num `log.warn` durável. Mesma classe,
 * outro sink. O cron hoje está OFF (PACOTES_RECONCILE_ENABLED ausente, SCRUM-135), mas o código
 * está lá e vaza no dia em que ligarem — por isso o fix vem antes do ligamento.
 *
 * O array sai pelo MESMO hashEventIdForLog do SCRUM-91/#531 (nenhum segundo mecanismo): o ops
 * segue cruzando pelo hash determinístico, e o id CRU permanece na linha do ledger.
 */
import { hashEventIdForLog } from '@startap/core/gcal-event-log';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpies } = vi.hoisted(() => ({
  logSpies: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => logSpies },
}));

const { findSuspectDoubleRedeemsMock } = vi.hoisted(() => ({
  findSuspectDoubleRedeemsMock: vi.fn(),
}));

vi.mock('@startap/db', () => ({
  packages: { findSuspectDoubleRedeems: findSuspectDoubleRedeemsMock },
}));

vi.mock('../config.js', () => ({
  config: { PACOTES_RECONCILE_WINDOW_HOURS: 48 },
}));

const { runReconcilePackages } = await import('./reconcile-packages.js');

/** Ids realistas do Google — são o reidentificador indireto do atendimento. */
const RAW_IDS = ['6k3jd9plq7v2c1hs8tnu4bgoim', 'a1b2c3d4e5f6g7h8i9j0klmnop'];

function suspect(over: Record<string, unknown> = {}) {
  return {
    slot: 'cirilobarbearia',
    credit_id: 42,
    servico_nome: 'Corte',
    redeems: 2,
    refunds: 0,
    gcal_event_ids: RAW_IDS,
    primeiro: '2026-07-01T10:00:00Z',
    ultimo: '2026-07-02T10:00:00Z',
    ...over,
  };
}

/** Tudo que o job logou, em todos os níveis. */
function loggedPayload(): string {
  return JSON.stringify([
    ...logSpies.info.mock.calls,
    ...logSpies.warn.mock.calls,
    ...logSpies.error.mock.calls,
  ]);
}

beforeEach(() => {
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  findSuspectDoubleRedeemsMock.mockReset();
});

describe('reconcile-packages — gcal_event_id nunca cru no log (SCRUM-148 item 2)', () => {
  it('NENHUM id cru aparece no log; o array vai hasheado', async () => {
    findSuspectDoubleRedeemsMock.mockResolvedValue([suspect()]);

    const res = await runReconcilePackages();
    expect(res.suspects).toBe(1);

    const logged = loggedPayload();
    for (const raw of RAW_IDS) {
      expect(logged).not.toContain(raw);
    }

    const warn = logSpies.warn.mock.calls.find(([, msg]) =>
      String(msg).includes('SUSPEITA de dupla-baixa'),
    );
    expect(warn).toBeDefined();
    const campo = (warn?.[0] as { gcalEventIds: string[] }).gcalEventIds;
    // Mesmo mecanismo do SCRUM-91: o array inteiro, item a item.
    expect(campo).toEqual(RAW_IDS.map(hashEventIdForLog));
    expect(campo).toHaveLength(2);
    for (const h of campo) expect(h).toMatch(/^sha256:[0-9a-f]{16}$/);
  });

  it('o resto do diagnóstico do ops fica intacto (slot, crédito, contagens)', async () => {
    findSuspectDoubleRedeemsMock.mockResolvedValue([suspect()]);

    await runReconcilePackages();

    const warn = logSpies.warn.mock.calls.find(([, msg]) =>
      String(msg).includes('SUSPEITA de dupla-baixa'),
    );
    expect(warn?.[0]).toMatchObject({
      slot: 'cirilobarbearia',
      creditId: 42,
      servico: 'Corte',
      redeems: 2,
      refunds: 0,
      baixaLiquida: 2,
    });
  });

  it('várias suspeitas: nenhum id cru escapa em nenhuma linha', async () => {
    const outros = ['zzz111yyy222xxx333www44', 'qqq555rrr666sss777ttt88'];
    findSuspectDoubleRedeemsMock.mockResolvedValue([
      suspect(),
      suspect({ credit_id: 43, gcal_event_ids: outros }),
    ]);

    const res = await runReconcilePackages();
    expect(res.suspects).toBe(2);

    const logged = loggedPayload();
    for (const raw of [...RAW_IDS, ...outros]) {
      expect(logged).not.toContain(raw);
    }
  });

  it('sem suspeita = silêncio (não polui o log em prod)', async () => {
    findSuspectDoubleRedeemsMock.mockResolvedValue([]);

    const res = await runReconcilePackages();

    expect(res).toEqual({ suspects: 0, windowHours: 48 });
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it('falha de leitura do ledger não derruba o worker e não loga id', async () => {
    findSuspectDoubleRedeemsMock.mockRejectedValue(new Error('conexao caiu'));

    const res = await runReconcilePackages();

    expect(res).toEqual({ suspects: 0, windowHours: 48 });
    expect(logSpies.error).toHaveBeenCalled();
    for (const raw of RAW_IDS) expect(loggedPayload()).not.toContain(raw);
  });
});
