/**
 * Unit de pauseBotByOwner / resumeBotByOwner — pausa SELF-SERVICE do bot pelo DONO.
 *
 * O pool pg é MOCKADO (client fake roteado por substring da query) — nada bate em DB real.
 * Cobre o contrato estrito:
 *  - pause seta suspended_kind='owner_request' (NUNCA 'billing') só quando flow_enabled=true;
 *  - pause NÃO sobrescreve suspensão da Startap (UPDATE não casa o WHERE -> changed:false);
 *  - resume só destrava owner_request (WHERE suspended_kind='owner_request');
 *  - resume com 0 linhas (suspenso pela Startap) -> changed:false (o caller responde 409);
 *  - log de auditoria só quando rowCount>0 (idempotência: retry não duplica efeito);
 *  - invalidateCloneCache só na mudança real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { sql: string; params: unknown[] }[] = [];

/** rowCountUpdate = quantas linhas o UPDATE flow_clones afetou (0 = WHERE não casou). */
function makeClient(rowCountUpdate: number, sessao: string | null = 'sess_x') {
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const q = sql.replace(/\s+/g, ' ');
      if (q.includes('BEGIN') || q.includes('COMMIT') || q.includes('ROLLBACK')) {
        return { rows: [], rowCount: 0 };
      }
      if (q.includes('UPDATE flow_clones')) {
        return rowCountUpdate > 0
          ? { rows: [{ slot: params?.[0], waha_sessao: sessao }], rowCount: rowCountUpdate }
          : { rows: [], rowCount: 0 };
      }
      if (q.includes('INSERT INTO flow_suspension_log')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
}

let currentClient: ReturnType<typeof makeClient>;

vi.mock('../client.js', () => ({
  pool: { connect: vi.fn(async () => currentClient) },
  query: vi.fn(),
}));

const {
  pauseBotByOwner,
  resumeBotByOwner,
  OWNER_PAUSE_KIND,
  getCloneBySlot,
  invalidateCloneCache,
} = await import('./flow-clones.js');

function setup(rowCountUpdate: number, sessao: string | null = 'sess_x') {
  calls.length = 0;
  currentClient = makeClient(rowCountUpdate, sessao);
}

function sqlsRun(): string[] {
  return calls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
}
function findCall(needle: string) {
  return calls.find((c) => c.sql.replace(/\s+/g, ' ').includes(needle));
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── pauseBotByOwner ────────────────────────────────────────────────────────────
describe('pauseBotByOwner — pausa do dono (owner_request)', () => {
  it('flow_enabled=true -> seta owner_request, loga suspend, changed:true', async () => {
    setup(1);
    const res = await pauseBotByOwner('clone_x', 'portal:7');

    expect(res).toEqual({ changed: true, flow_enabled: false });

    // UPDATE condicional: só pausa quem está ATIVO (WHERE flow_enabled = TRUE).
    const upd = findCall('UPDATE flow_clones');
    expect(upd?.sql.replace(/\s+/g, ' ')).toContain('flow_enabled = TRUE');
    // kind canônico = owner_request (NUNCA billing).
    expect(upd?.params).toEqual(['clone_x', OWNER_PAUSE_KIND, 'Pausado pelo cliente no portal']);
    expect(upd?.sql).not.toContain('billing');
    expect(OWNER_PAUSE_KIND).toBe('owner_request');

    // Log de auditoria (suspend, actor do portal).
    const logCall = findCall('INSERT INTO flow_suspension_log');
    expect(logCall?.params).toEqual(['clone_x', 'Pausado pelo cliente no portal', 'portal:7']);
    expect(logCall?.sql).toContain("'suspend'");

    // COMMIT (não ROLLBACK).
    expect(sqlsRun()).toContain('COMMIT');
    expect(currentClient.release).toHaveBeenCalled();
  });

  it('NÃO sobrescreve suspensão da Startap: 0 linhas -> changed:false, SEM log', async () => {
    // Já suspenso (flow_enabled=false) -> WHERE flow_enabled=TRUE não casa.
    setup(0);
    const res = await pauseBotByOwner('clone_x', 'portal:7');

    // Estado já era pausado: devolve flow_enabled=false (correto), mas changed=false.
    expect(res).toEqual({ changed: false, flow_enabled: false });
    // NÃO loga nem reescreve o kind da Startap.
    expect(findCall('INSERT INTO flow_suspension_log')).toBeUndefined();
    expect(sqlsRun()).toContain('COMMIT');
  });

  it('invalidateCloneCache: a pausa derruba o cache do slot (TTL 60s não atrasa)', async () => {
    // Semeia o cache com flow_enabled=true via getCloneBySlot.
    const queryMod = await import('../client.js');
    const queryMock = vi.mocked(queryMod.query);
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 1, slot: 'clone_cache', flow_enabled: true, suspended_kind: null }],
      rowCount: 1,
    } as never);
    const before = await getCloneBySlot('clone_cache');
    expect(before?.flow_enabled).toBe(true);

    // Pausa: deve invalidar o cache do slot.
    setup(1);
    await pauseBotByOwner('clone_cache', 'portal:7');

    // Próximo getCloneBySlot re-consulta o DB (cache invalidado), pega flow_enabled=false.
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 1, slot: 'clone_cache', flow_enabled: false, suspended_kind: 'owner_request' }],
      rowCount: 1,
    } as never);
    const after = await getCloneBySlot('clone_cache');
    expect(after?.flow_enabled).toBe(false);
    expect(after?.suspended_kind).toBe('owner_request');

    invalidateCloneCache(); // limpa p/ não vazar entre testes
  });
});

// ── resumeBotByOwner ───────────────────────────────────────────────────────────
describe('resumeBotByOwner — retoma só a própria pausa', () => {
  it('owner_request -> reativa (flow_enabled=true, kind/reason/at=NULL), loga resume', async () => {
    setup(1);
    const res = await resumeBotByOwner('clone_x', 'portal:7');

    expect(res).toEqual({ changed: true, flow_enabled: true });

    const upd = findCall('UPDATE flow_clones');
    const sql = upd?.sql.replace(/\s+/g, ' ') ?? '';
    // WHERE estrito: só destrava owner_request E quando está suspenso.
    expect(sql).toContain('flow_enabled = FALSE');
    expect(sql).toContain('suspended_kind = $2');
    expect(upd?.params).toEqual(['clone_x', OWNER_PAUSE_KIND]);
    // Limpa o estado de suspensão.
    expect(sql).toContain('suspended_kind = NULL');
    expect(sql).toContain('suspended_reason = NULL');
    expect(sql).toContain('suspended_at = NULL');

    const logCall = findCall('INSERT INTO flow_suspension_log');
    expect(logCall?.sql).toContain("'resume'");
    expect(logCall?.params).toEqual(['clone_x', 'portal:7']);
    expect(sqlsRun()).toContain('COMMIT');
  });

  it('suspenso pela Startap (kind != owner_request): 0 linhas -> changed:false, SEM log', async () => {
    // billing/manual_other/abuse NÃO casam o WHERE suspended_kind='owner_request'.
    setup(0);
    const res = await resumeBotByOwner('clone_x', 'portal:7');

    // O cliente NÃO levanta suspensão da Startap — caller usa changed=false p/ 409.
    expect(res).toEqual({ changed: false, flow_enabled: false });
    expect(findCall('INSERT INTO flow_suspension_log')).toBeUndefined();
    expect(sqlsRun()).toContain('COMMIT');
  });
});
