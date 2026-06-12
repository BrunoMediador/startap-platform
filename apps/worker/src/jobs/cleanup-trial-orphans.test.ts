/**
 * Testes do job cleanup-trial-orphans (Missão 020 F1 — condição 2 do PORTAL_SIGNUP).
 *
 * `../config.js`, `@startap/db` e `@startap/integrations` são MOCKADOS — sem banco
 * nem rede (fetch do ping WAHA é stubado).
 *
 * Cobre:
 *  - kill switch OFF -> NO-OP total (não lê banco, não toca WAHA).
 *  - zero candidatos (estado de prod com PORTAL_SIGNUP OFF) -> não consulta WAHA
 *    nem chama teardown; idempotência de reruns.
 *  - caminho feliz: teardown reusado com slot + sessionName certos (e fallback
 *    sessionName = slot quando waha_sessao é NULL).
 *  - guard de trial_status no CHAMADOR: candidato fora do contrato ('none'/sem
 *    prefixo clone_) é recusado mesmo se a query devolver (defesa em camadas).
 *  - respeito ao lock: advisory lock ocupado -> teardown NÃO roda.
 *  - recheck dentro do lock: deixou de ser órfão (pareou no meio) -> skip.
 *  - fail-safe WAHA inacessível -> rodada aborta sem teardown.
 *  - erro por candidato não derruba os demais.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks dos módulos externos ao job ───────────────────────────────────────────
const listOrphanTrialCandidates = vi.fn();
const findOrphanTrialClone = vi.fn();
const withTrialSlotLock = vi.fn();
const teardownProvisionedClone = vi.fn();
const fetchMock = vi.fn();

vi.mock('@startap/db', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  trialLedger: { listOrphanTrialCandidates, findOrphanTrialClone, withTrialSlotLock },
}));

vi.mock('@startap/integrations', () => ({
  provisioning: { teardownProvisionedClone },
}));

interface ConfigOverrides {
  enabled?: boolean;
  maxAgeHours?: number;
}

async function loadJob(overrides: ConfigOverrides = {}) {
  vi.resetModules();
  vi.doMock('../config.js', () => ({
    config: {
      TRIAL_ORPHAN_CLEANUP_ENABLED: overrides.enabled ?? true,
      TRIAL_ORPHAN_MAX_AGE_HOURS: overrides.maxAgeHours ?? 72,
      WAHA_URL: 'http://waha:3000',
      WAHA_API_KEY: 'k',
      TS_WEBHOOK_URL: 'http://api:3040/webhooks/waha',
    },
  }));
  return import('./cleanup-trial-orphans.js');
}

const ORPHAN = {
  slot: 'clone_barbearia_xyz123',
  waha_sessao: 'clone_barbearia_xyz123',
  status: 'aguardando_qr',
  trial_status: 'awaiting' as const,
  age_hours: 80,
};

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset().mockResolvedValue({ ok: true });
  listOrphanTrialCandidates.mockReset().mockResolvedValue([]);
  findOrphanTrialClone.mockReset().mockResolvedValue(null);
  // Default: lock SEMPRE adquirido — executa o fn (caminho feliz).
  withTrialSlotLock
    .mockReset()
    .mockImplementation(async (_slot: string, fn: () => Promise<unknown>) => ({
      acquired: true,
      result: await fn(),
    }));
  teardownProvisionedClone.mockReset().mockResolvedValue({ wahaDeleted: true, dbDeleted: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../config.js');
});

describe('runCleanupTrialOrphans — kill switch e no-op', () => {
  it('TRIAL_ORPHAN_CLEANUP_ENABLED=false -> NO-OP: não lê banco nem toca WAHA', async () => {
    const { runCleanupTrialOrphans } = await loadJob({ enabled: false });
    const r = await runCleanupTrialOrphans();

    expect(r.skipped).toBe(true);
    expect(r.deleted).toBe(0);
    expect(listOrphanTrialCandidates).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(teardownProvisionedClone).not.toHaveBeenCalled();
  });

  it('zero candidatos (PORTAL_SIGNUP OFF em prod) -> roda e não faz nada, sem consultar WAHA', async () => {
    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(r).toMatchObject({ skipped: false, scanned: 0, deleted: 0, errors: 0 });
    expect(listOrphanTrialCandidates).toHaveBeenCalledWith(72, expect.any(Number));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(teardownProvisionedClone).not.toHaveBeenCalled();
  });

  it('idempotência: 2ª rodada após o teardown (candidato sumiu do SELECT) é no-op limpo', async () => {
    listOrphanTrialCandidates
      .mockResolvedValueOnce([ORPHAN]) // 1ª rodada: tem órfão
      .mockResolvedValueOnce([]); // 2ª rodada: já desfeito
    findOrphanTrialClone.mockResolvedValueOnce(ORPHAN);

    const { runCleanupTrialOrphans } = await loadJob();
    const r1 = await runCleanupTrialOrphans();
    const r2 = await runCleanupTrialOrphans();

    expect(r1.deleted).toBe(1);
    expect(r2).toMatchObject({ scanned: 0, deleted: 0, errors: 0 });
    expect(teardownProvisionedClone).toHaveBeenCalledTimes(1);
  });
});

describe('runCleanupTrialOrphans — caminho feliz (teardown reusado)', () => {
  it('desfaz órfão awaiting sob lock, com slot + sessionName do banco', async () => {
    listOrphanTrialCandidates.mockResolvedValue([ORPHAN]);
    findOrphanTrialClone.mockResolvedValue(ORPHAN);

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(r).toMatchObject({ scanned: 1, deleted: 1, wahaSessionsDeleted: 1, errors: 0 });
    expect(withTrialSlotLock).toHaveBeenCalledWith(ORPHAN.slot, expect.any(Function));
    expect(teardownProvisionedClone).toHaveBeenCalledWith(
      expect.objectContaining({
        waha: expect.objectContaining({ url: 'http://waha:3000', apiKey: 'k' }),
      }),
      { slot: ORPHAN.slot, sessionName: ORPHAN.waha_sessao },
    );
    // recheck fresh DENTRO do lock, com a mesma idade limite
    expect(findOrphanTrialClone).toHaveBeenCalledWith(ORPHAN.slot, 72);
  });

  it('waha_sessao NULL (sessão falhou no signup) -> sessionName cai pro próprio slot', async () => {
    const semSessao = { ...ORPHAN, waha_sessao: null, status: 'rascunho' };
    listOrphanTrialCandidates.mockResolvedValue([semSessao]);
    findOrphanTrialClone.mockResolvedValue(semSessao);

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(r.deleted).toBe(1);
    expect(teardownProvisionedClone).toHaveBeenCalledWith(expect.anything(), {
      slot: semSessao.slot,
      sessionName: semSessao.slot,
    });
  });

  it('teardown que NÃO removeu o DB conta erro e não marca deleted (retenta na próxima)', async () => {
    listOrphanTrialCandidates.mockResolvedValue([ORPHAN]);
    findOrphanTrialClone.mockResolvedValue(ORPHAN);
    teardownProvisionedClone.mockResolvedValue({ wahaDeleted: false, dbDeleted: false });

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(r.deleted).toBe(0);
    expect(r.errors).toBe(1);
  });
});

describe('runCleanupTrialOrphans — guards de segurança (camadas)', () => {
  it('GUARD chamador: trial_status none JAMAIS chega no teardown (Cirilo/clone manual intocável)', async () => {
    // Simula query quebrada devolvendo um clone manual: o guard do chamador segura.
    listOrphanTrialCandidates.mockResolvedValue([
      { ...ORPHAN, slot: 'clone_manual_abc111', trial_status: 'none' },
    ]);

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(teardownProvisionedClone).not.toHaveBeenCalled();
    expect(withTrialSlotLock).not.toHaveBeenCalled();
    expect(r.errors).toBe(1);
    expect(r.deleted).toBe(0);
  });

  it('GUARD chamador: trial_status exempt (whitelist interna) também é recusado', async () => {
    listOrphanTrialCandidates.mockResolvedValue([{ ...ORPHAN, trial_status: 'exempt' }]);

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(teardownProvisionedClone).not.toHaveBeenCalled();
    expect(r.errors).toBe(1);
  });

  it('GUARD chamador: slot sem prefixo clone_ é recusado (sessão de matriz/cliente nunca)', async () => {
    listOrphanTrialCandidates.mockResolvedValue([{ ...ORPHAN, slot: 'cirilobarbearia' }]);

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(teardownProvisionedClone).not.toHaveBeenCalled();
    expect(r.errors).toBe(1);
  });

  it('RESPEITO AO LOCK: advisory lock ocupado (pareamento em curso) -> teardown NÃO roda', async () => {
    listOrphanTrialCandidates.mockResolvedValue([ORPHAN]);
    withTrialSlotLock.mockResolvedValue({ acquired: false });

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(teardownProvisionedClone).not.toHaveBeenCalled();
    expect(r.skippedLockBusy).toBe(1);
    expect(r.deleted).toBe(0);
    expect(r.errors).toBe(0);
  });

  it('RECHECK no lock: cliente pareou entre o SELECT e o lock -> skip silencioso logado', async () => {
    listOrphanTrialCandidates.mockResolvedValue([ORPHAN]);
    findOrphanTrialClone.mockResolvedValue(null); // fresh diz: não é mais órfão

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(teardownProvisionedClone).not.toHaveBeenCalled();
    expect(r.skippedNotOrphan).toBe(1);
    expect(r.errors).toBe(0);
  });

  it('FAIL-SAFE: WAHA inacessível com candidatos -> rodada aborta sem nenhum teardown', async () => {
    listOrphanTrialCandidates.mockResolvedValue([ORPHAN]);
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(teardownProvisionedClone).not.toHaveBeenCalled();
    expect(withTrialSlotLock).not.toHaveBeenCalled();
    expect(r.errors).toBe(1);
    expect(r.deleted).toBe(0);
  });

  it('erro num candidato NÃO derruba os demais (isolamento por item)', async () => {
    const outro = { ...ORPHAN, slot: 'clone_salao_def456', waha_sessao: 'clone_salao_def456' };
    listOrphanTrialCandidates.mockResolvedValue([ORPHAN, outro]);
    findOrphanTrialClone
      .mockRejectedValueOnce(new Error('pg down')) // 1º candidato explode no recheck
      .mockResolvedValueOnce(outro); // 2º segue normal

    const { runCleanupTrialOrphans } = await loadJob();
    const r = await runCleanupTrialOrphans();

    expect(r.errors).toBe(1);
    expect(r.deleted).toBe(1);
    expect(teardownProvisionedClone).toHaveBeenCalledTimes(1);
    expect(teardownProvisionedClone).toHaveBeenCalledWith(expect.anything(), {
      slot: outro.slot,
      sessionName: outro.waha_sessao,
    });
  });
});
