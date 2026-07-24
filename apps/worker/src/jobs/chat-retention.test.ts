/**
 * Testes do job chat-retention (SCRUM-136 — retenção por IDADE, LGPD).
 *
 * `../config.js` e `@startap/db` são MOCKADOS — sem banco. Cobre a ORQUESTRAÇÃO
 * (a semântica do SQL de deleção é exercitada no chat-retention.integration.test.ts):
 *  - DRY-RUN por default (sem CHAT_RETENTION_ENABLED): applyAgeRetention chamado com
 *    dryRun=true, nada apagado (total_deleted=0);
 *  - ENABLED=true → dryRun=false (deleção real);
 *  - piso de segurança: dias < FLOOR força DRY-RUN mesmo com ENABLED=true;
 *  - tabela ÓRFÃ vinda do catálogo é varrida (não depende de flow_clones);
 *  - erro por tabela não derruba o loop (fail-safe);
 *  - agregação por tabela + total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listChatTablesFromCatalog = vi.fn();
const applyAgeRetention = vi.fn();

vi.mock('@startap/db', () => ({
  chatMemory: { listChatTablesFromCatalog, applyAgeRetention },
}));

interface ConfigOverrides {
  enabled?: boolean;
  days?: number;
  keep?: number;
}

async function loadJob(overrides: ConfigOverrides = {}) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({
    config: {
      CHAT_RETENTION_ENABLED: overrides.enabled ?? false,
      CHAT_RETENTION_DAYS: overrides.days ?? 180,
      CHAT_MEMORY_RETENTION: overrides.keep ?? 30,
    },
  }));
  return import('./chat-retention.js');
}

/** applyAgeRetention fake que respeita o dryRun (matched sempre; deleted só se real). */
function fakeApply(matchedByTable: Record<string, number>) {
  return async (table: string, _cutoff: Date, _keep: number, opts: { dryRun: boolean }) => {
    const matched = matchedByTable[table] ?? 0;
    return { table, matched, deleted: opts.dryRun ? 0 : matched };
  };
}

beforeEach(() => {
  listChatTablesFromCatalog.mockReset();
  applyAgeRetention.mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('runChatRetention', () => {
  it('DRY-RUN por default (sem ENABLED): conta mas não apaga', async () => {
    listChatTablesFromCatalog.mockResolvedValue(['chat_histories', 'chat_histories_ricardo']);
    applyAgeRetention.mockImplementation(
      fakeApply({ chat_histories: 12, chat_histories_ricardo: 3 }),
    );

    const { runChatRetention } = await loadJob({ enabled: false });
    const r = await runChatRetention();

    expect(r.dry_run).toBe(true);
    expect(r.total_matched).toBe(15);
    expect(r.total_deleted).toBe(0);
    expect(r.per_table.chat_histories).toEqual({ matched: 12, deleted: 0 });
    // Todas as chamadas foram dryRun=true.
    for (const call of applyAgeRetention.mock.calls) {
      expect(call[3]).toEqual({ dryRun: true });
    }
  });

  it('ENABLED=true: dryRun=false → deleção real', async () => {
    listChatTablesFromCatalog.mockResolvedValue(['chat_histories']);
    applyAgeRetention.mockImplementation(fakeApply({ chat_histories: 7 }));

    const { runChatRetention } = await loadJob({ enabled: true, days: 180 });
    const r = await runChatRetention();

    expect(r.dry_run).toBe(false);
    expect(r.total_deleted).toBe(7);
    expect(applyAgeRetention.mock.calls[0][3]).toEqual({ dryRun: false });
  });

  it('piso de segurança: dias < FLOOR força DRY-RUN mesmo com ENABLED=true', async () => {
    listChatTablesFromCatalog.mockResolvedValue(['chat_histories']);
    applyAgeRetention.mockImplementation(fakeApply({ chat_histories: 999 }));

    const { runChatRetention, CHAT_RETENTION_FLOOR_DAYS } = await loadJob({
      enabled: true,
      days: 1,
    });
    const r = await runChatRetention();

    expect(CHAT_RETENTION_FLOOR_DAYS).toBeGreaterThan(1);
    expect(r.dry_run).toBe(true);
    expect(r.total_deleted).toBe(0);
    expect(applyAgeRetention.mock.calls[0][3]).toEqual({ dryRun: true });
  });

  it('tabela ÓRFÃ vinda do catálogo é varrida (independe de flow_clones)', async () => {
    // chat_histories_seven7 = tabela de clone excluído (órfã) — só o catálogo a enxerga.
    listChatTablesFromCatalog.mockResolvedValue(['chat_histories', 'chat_histories_seven7']);
    applyAgeRetention.mockImplementation(
      fakeApply({ chat_histories: 0, chat_histories_seven7: 40 }),
    );

    const { runChatRetention } = await loadJob({ enabled: true });
    const r = await runChatRetention();

    expect(r.per_table.chat_histories_seven7).toEqual({ matched: 40, deleted: 40 });
    expect(r.total_deleted).toBe(40);
  });

  it('erro numa tabela não derruba o loop (fail-safe)', async () => {
    listChatTablesFromCatalog.mockResolvedValue(['chat_bad', 'chat_histories']);
    applyAgeRetention.mockImplementation(
      async (table: string, _c: Date, _k: number, o: { dryRun: boolean }) => {
        if (table === 'chat_bad') throw new Error('sem coluna created_at');
        return { table, matched: 5, deleted: o.dryRun ? 0 : 5 };
      },
    );

    const { runChatRetention } = await loadJob({ enabled: true });
    const r = await runChatRetention();

    // A tabela boa foi processada apesar do erro na anterior.
    expect(r.per_table.chat_histories).toEqual({ matched: 5, deleted: 5 });
    expect(r.per_table.chat_bad).toBeUndefined();
    expect(r.total_deleted).toBe(5);
  });

  it('cutoff reflete retention_days (janela conservadora)', async () => {
    listChatTablesFromCatalog.mockResolvedValue([]);
    const { runChatRetention } = await loadJob({ days: 180 });
    const r = await runChatRetention();
    const ageMs = Date.now() - new Date(r.cutoff).getTime();
    // ~180 dias (tolerância de 1 dia).
    expect(ageMs).toBeGreaterThan(179 * 86_400_000);
    expect(ageMs).toBeLessThan(181 * 86_400_000);
  });
});
