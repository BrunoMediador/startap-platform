/**
 * Teste de INTEGRAÇÃO das pausas do portal (SCRUM-86) — roda SQL REAL.
 *
 * POR QUÊ: o unit (portal-config-pausa.test.ts) MOCKA o driver pg e só valida a STRING do SQL.
 * O bug do SCRUM-86 é de ESTADO DA LINHA no upsert (ON CONFLICT herdava o expires_at vencido de
 * uma pausa human_reply anterior), invisível num teste de string. Este arquivo executa as funções
 * REAIS (addPausaBySlot / removePausaBySlot / listPausasBySlot / addHumanReplyPause) contra um
 * Postgres de verdade e checa a linha resultante.
 *
 * COMO RODAR (local / smoke do devops):
 *   PG_TEST_URL=postgres://user:pass@localhost:5432/test_db npx vitest run portal-config-pausa.integration
 * Sem PG_TEST_URL o suite AUTO-SKIPA (não derruba o CI, que hoje não tem Postgres efêmero).
 * NUNCA toca produção: cria/dropa um flow_clones + flow_pauses mínimos, escopados a um slot de teste.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;

if (!PG_TEST_URL) {
  console.warn(
    '[portal-config-pausa.integration] PG_TEST_URL ausente — suite de integração PULADO ' +
      '(SQL real não exercitado). Defina PG_TEST_URL para rodar.',
  );
}

describeIf('pausas do portal contra Postgres REAL (SCRUM-86)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: pg importado dinamicamente; tipos via cast abaixo.
  let pgPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: idem — módulos importados dinamicamente.
  let portal: any;
  // biome-ignore lint/suspicious/noExplicitAny: idem.
  let pausa: any;

  const SLOT = 'itest_slot_pausa_portal';
  const TEL = '5535999998888';

  async function exec(sql: string, params?: unknown[]) {
    return pgPool.query(sql, params);
  }

  async function createSchema() {
    await exec(`CREATE TABLE IF NOT EXISTS flow_clones (
      slot TEXT PRIMARY KEY,
      display_name TEXT,
      waha_sessao TEXT)`);
    await exec(
      `INSERT INTO flow_clones (slot, display_name, waha_sessao)
         VALUES ($1, 'Meduzza Teste', 'SESS_ITEST') ON CONFLICT (slot) DO NOTHING`,
      [SLOT],
    );
    // Mesmo shape de migrations 008 + 071 (flow_id+telefone PK; expires_at TIMESTAMP NULL).
    await exec(`CREATE TABLE IF NOT EXISTS flow_pauses (
      flow_id     VARCHAR(100) NOT NULL,
      flow_name   VARCHAR(150),
      telefone    VARCHAR(32)  NOT NULL,
      session     VARCHAR(100),
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      source      VARCHAR(40) DEFAULT 'manual',
      reason      TEXT,
      expires_at  TIMESTAMP NULL,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (flow_id, telefone))`);
  }

  async function dropSchema() {
    await exec('DROP TABLE IF EXISTS flow_pauses');
    await exec('DROP TABLE IF EXISTS flow_clones');
  }

  /** Lê a linha de pausa (flow_id=SLOT, telefone=TEL) direto do banco pra asserir estado. */
  async function readRow() {
    const r = await exec(
      'SELECT active, source, expires_at FROM flow_pauses WHERE flow_id = $1 AND telefone = $2',
      [SLOT, TEL],
    );
    return r.rows[0] ?? null;
  }

  /** Semeia uma pausa human_reply com TTL JÁ VENCIDO (cenário-raiz do bug). */
  async function seedExpiredHumanReply() {
    await exec(
      `INSERT INTO flow_pauses (flow_id, flow_name, telefone, session, active, source, reason, expires_at, updated_at)
       VALUES ($1, 'Meduzza Teste', $2, 'SESS_ITEST', TRUE, 'human_reply', 'resposta à mão', NOW() - INTERVAL '2 hours', NOW())`,
      [SLOT, TEL],
    );
  }

  beforeAll(async () => {
    const url = new URL(PG_TEST_URL as string);
    process.env.PG_HOST = url.hostname;
    process.env.PG_PORT = url.port || '5432';
    process.env.PG_USER = decodeURIComponent(url.username);
    process.env.PG_PASS = decodeURIComponent(url.password);
    process.env.PG_DB = url.pathname.replace(/^\//, '');
    const pg = await import('pg');
    pgPool = new pg.default.Pool({
      host: process.env.PG_HOST,
      port: Number(process.env.PG_PORT),
      user: process.env.PG_USER,
      password: process.env.PG_PASS,
      database: process.env.PG_DB,
      max: 6,
    });
    portal = await import('./portal-config.js');
    pausa = await import('./pausa.js');
    await createSchema();
  }, 30_000);

  afterAll(async () => {
    if (pgPool) {
      await dropSchema().catch(() => {});
      await pgPool.end().catch(() => {});
    }
    try {
      const client = await import('../client.js');
      await client.closePool();
    } catch {
      /* noop */
    }
  });

  beforeEach(async () => {
    await exec('DELETE FROM flow_pauses WHERE flow_id = $1', [SLOT]);
  });

  it('re-pausa via portal de linha human_reply VENCIDA → source=portal, active=TRUE, expires_at NULL', async () => {
    await seedExpiredHumanReply();
    // sanity: começou vencida
    const before = await readRow();
    expect(before.source).toBe('human_reply');
    expect(before.expires_at).not.toBeNull();

    const row = await portal.addPausaBySlot({ slot: SLOT, telefone: TEL });
    expect(row?.source).toBe('portal');

    const after = await readRow();
    expect(after.active).toBe(true);
    expect(after.source).toBe('portal');
    // O CORAÇÃO DO FIX: o TTL vencido foi ZERADO — a pausa virou permanente.
    expect(after.expires_at).toBeNull();

    // E aparece no painel (o filtro admite expires_at NULL).
    const lista = await portal.listPausasBySlot(SLOT);
    expect(lista.map((p: { telefone: string }) => p.telefone)).toContain(TEL);
  });

  it('pausa NOVA via portal (sem linha prévia) → expires_at NULL', async () => {
    const row = await portal.addPausaBySlot({ slot: SLOT, telefone: TEL });
    expect(row?.source).toBe('portal');
    const after = await readRow();
    expect(after.active).toBe(true);
    expect(after.expires_at).toBeNull();
  });

  it('despausar linha ATIVA com expires_at VENCIDO → true (não 404) e active=FALSE', async () => {
    await seedExpiredHumanReply(); // active=TRUE, expires_at no passado
    const ok = await portal.removePausaBySlot({ slot: SLOT, telefone: TEL });
    expect(ok).toBe(true);
    const after = await readRow();
    expect(after.active).toBe(false);
  });

  it('regressão: addHumanReplyPause segue gravando TTL (human_reply é temporário)', async () => {
    const exp = new Date(Date.now() + 3_600_000);
    await pausa.addHumanReplyPause({
      flowId: SLOT,
      telefone: TEL,
      session: 'SESS_ITEST',
      expiresAt: exp,
    });
    const after = await readRow();
    expect(after.source).toBe('human_reply');
    expect(after.expires_at).not.toBeNull();
    expect(new Date(after.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('regressão: addHumanReplyPause NÃO rebaixa pausa portal permanente ativa (guard N1)', async () => {
    // Primeiro o dono pausa pelo portal (permanente, expires_at NULL)...
    await portal.addPausaBySlot({ slot: SLOT, telefone: TEL });
    // ...depois chega uma resposta humana: NÃO pode virar human_reply/TTL nem soltar o bot em 1h.
    const exp = new Date(Date.now() + 3_600_000);
    await pausa.addHumanReplyPause({
      flowId: SLOT,
      telefone: TEL,
      session: 'SESS_ITEST',
      expiresAt: exp,
    });
    const after = await readRow();
    expect(after.source).toBe('portal');
    expect(after.expires_at).toBeNull();
  });
});
