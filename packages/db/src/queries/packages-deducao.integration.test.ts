/**
 * Teste de INTEGRAÇÃO da dedução de pacotes (ADR 0025 BLOCO 2b) — roda SQL REAL.
 *
 * POR QUÊ: os testes unitários (packages.test.ts / packages-deducao.test.ts) MOCKAM o driver
 * pg e só validam a STRING do SQL. Toda uma classe de defeito é invisível assim: sintaxe
 * inválida, locking ilegal (ex.: FOR UPDATE + GROUP BY = erro 0A000 no PG 16), tipos, ON
 * CONFLICT mal-formado. Foi exatamente o que deixou passar o P0 do review do #321 (a query
 * de lock era inexecutável e degradava 100% pra avulso). Este arquivo executa as funções
 * REAIS contra um Postgres de verdade.
 *
 * COMO RODAR (local / smoke do devops):
 *   PG_TEST_URL=postgres://user:pass@localhost:5432/test_db npx vitest run packages-deducao.integration
 * Sem PG_TEST_URL o suite AUTO-SKIPA (não derruba o CI, que hoje não tem Postgres efêmero).
 * Quando o devops montar Postgres efêmero no CI (testcontainers/serviço pg), basta exportar a
 * env e estes testes passam a barrar SQL ilegal no pipeline. NUNCA toca o banco de produção:
 * usa só as tabelas de pacotes que ele mesmo cria/dropa num schema dedicado.
 *
 * O que cobre (caminho real, fonte da verdade = ledger):
 *  - dedução grava 1 redemption (-1), baixa o saldo e o cache;
 *  - retry do MESMO gcal_event_id NÃO duplica (ON CONFLICT + idempotência);
 *  - corrida de 2 reservas concorrentes do MESMO cliente na ÚLTIMA sessão: só UMA desconta
 *    (FOR UPDATE OF c serializa + guarda saldo>0), a outra cai pra avulso — nunca abaixo de 0;
 *  - estorno (+1) devolve a sessão e é idempotente.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ClientPackageCredit } from './packages.js';

const PG_TEST_URL = process.env.PG_TEST_URL;
const describeIf = PG_TEST_URL ? describe : describe.skip;

if (!PG_TEST_URL) {
  // Loud skip: deixa explícito no output do vitest por que o suite não rodou.
  console.warn(
    '[packages-deducao.integration] PG_TEST_URL ausente — suite de integração PULADO ' +
      '(SQL real não exercitado). Defina PG_TEST_URL para rodar.',
  );
}

// Importes dinâmicos só quando há banco — evita custo/erro quando o suite é skipado.
describeIf('redeem/refund de pacote contra Postgres REAL', () => {
  // biome-ignore lint/suspicious/noExplicitAny: pg é importado dinamicamente; tipos vêm via cast abaixo.
  let pgPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: idem.
  let pkg: any;

  const SLOT = 'itest_slot_pacotes';
  // SCRUM-90: schema PRÓPRIO — o comentário do topo prometia "schema dedicado" mas as tabelas
  // caíam em public e colidiam com as outras integrações (flow_clones global). Agora é de fato
  // isolado; teardown = DROP SCHEMA CASCADE.
  const SCHEMA = 'itest_pacotes';
  const TENANT = '00000000-0000-0000-0000-0000000000aa';
  const HMAC = 'itest-hmac-cliente-1';

  async function exec(sql: string, params?: unknown[]) {
    return pgPool.query(sql, params);
  }

  /** Cria as tabelas de pacotes SEM as FKs externas (clone_colaboradores) — as queries sob teste
   * não dependem delas; assim o suite é autocontido. Mesmas colunas, mesmos tipos, mesmo
   * UNIQUE(gcal_event_id,reason) e CHECK do cache. INCLUI um flow_clones mínimo (slot,timezone)
   * porque a validade do pacote agora é comparada no FUSO DO CLONE (SCRUM-46) via subquery
   * correlacionada em flow_clones.timezone — sem a tabela a query nem executa. */
  async function createSchema() {
    await exec(`CREATE TABLE IF NOT EXISTS flow_clones (
      slot TEXT PRIMARY KEY, timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo')`);
    // Fuso do clone de teste = SP (default de produção). data_expiracao '2999-12-31' segue no
    // futuro e '2020-01-01' no passado em QUALQUER fuso, então as asserções não mudam.
    await exec(
      `INSERT INTO flow_clones (slot, timezone) VALUES ($1, 'America/Sao_Paulo')
         ON CONFLICT (slot) DO NOTHING`,
      [SLOT],
    );
    await exec(`CREATE TABLE IF NOT EXISTS service_packages (
      id BIGSERIAL PRIMARY KEY, slot TEXT NOT NULL, tenant_id UUID NOT NULL,
      nome VARCHAR(160) NOT NULL, descricao TEXT,
      servicos_cobertos JSONB NOT NULL DEFAULT '[]',
      total_sessoes SMALLINT NOT NULL, validade_dias SMALLINT, data_validade_fixa DATE,
      preco_cents INTEGER, colaborador_id BIGINT, ativo BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await exec(`CREATE TABLE IF NOT EXISTS client_package_credits (
      id BIGSERIAL PRIMARY KEY, package_id BIGINT NOT NULL, slot TEXT NOT NULL, tenant_id UUID NOT NULL,
      cliente_phone_hmac TEXT NOT NULL, cliente_phone_hint VARCHAR(24),
      sessoes_total SMALLINT NOT NULL, sessoes_restantes SMALLINT NOT NULL,
      data_compra TIMESTAMPTZ NOT NULL DEFAULT now(), data_expiracao DATE NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (sessoes_restantes BETWEEN 0 AND sessoes_total))`);
    await exec(`CREATE TABLE IF NOT EXISTS package_redemptions (
      id BIGSERIAL PRIMARY KEY, credit_id BIGINT NOT NULL, slot TEXT NOT NULL, tenant_id UUID NOT NULL,
      gcal_event_id TEXT NOT NULL, colaborador_id BIGINT, servico_nome VARCHAR(160),
      delta SMALLINT NOT NULL, reason VARCHAR(24) NOT NULL DEFAULT 'redeem',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
    await exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_redemption_event_reason
         ON package_redemptions (gcal_event_id, reason)`,
    );
  }

  async function dropSchema() {
    // Dropa só o schema DESTA suíte (CASCADE derruba as 4 tabelas locais). Nunca tabela global.
    await exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  }

  /** Insere um template + um crédito do cliente com `total`/`restantes` sessões. Retorna creditId. */
  async function seedCredit(opts: {
    total: number;
    restantes: number;
    servicos?: string[];
    dataExpiracao?: string;
  }): Promise<number> {
    const servicos = JSON.stringify(opts.servicos ?? ['Corte', 'Barba']);
    // FONTE DA VERDADE = ledger: o código calcula saldo = sessoes_total + SUM(delta) e IGNORA o
    // cache sessoes_restantes (ver packages.ts selectActiveCreditsTx/rebuildCreditCacheTx). Logo,
    // para o crédito COMEÇAR com `restantes` sessões e ZERO redeems no ledger (countRedeems=0),
    // o sessoes_total do template/crédito tem de ser o próprio `restantes` (saldo_ledger = total
    // + 0). O `opts.total` original (sessões compradas) não afeta nenhuma asserção — nenhum teste
    // checa sessoes_total — e seedar total>restantes SEM redeems prévios deixava saldo_ledger=total
    // (a guarda saldo>0 nunca via a "última sessão"), que era a causa-raiz das 4 falhas.
    const totalLedger = opts.restantes;
    const pkgRes = await exec(
      `INSERT INTO service_packages (slot, tenant_id, nome, servicos_cobertos, total_sessoes)
       VALUES ($1,$2,'Pacote Teste',$3::jsonb,$4) RETURNING id`,
      [SLOT, TENANT, servicos, totalLedger],
    );
    const packageId = pkgRes.rows[0].id;
    const credRes = await exec(
      `INSERT INTO client_package_credits
         (package_id, slot, tenant_id, cliente_phone_hmac, sessoes_total, sessoes_restantes, data_expiracao)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        packageId,
        SLOT,
        TENANT,
        HMAC,
        totalLedger,
        opts.restantes,
        opts.dataExpiracao ?? '2999-12-31',
      ],
    );
    return Number(credRes.rows[0].id);
  }

  async function countRedeems(creditId: number, reason = 'redeem'): Promise<number> {
    const r = await exec(
      'SELECT COUNT(*)::int AS n FROM package_redemptions WHERE credit_id = $1 AND reason = $2',
      [creditId, reason],
    );
    return r.rows[0].n;
  }

  async function ledgerSaldo(creditId: number): Promise<number> {
    const r = await exec(
      `SELECT (c.sessoes_total + COALESCE(
                (SELECT SUM(delta) FROM package_redemptions WHERE credit_id = c.id), 0)) AS saldo
         FROM client_package_credits c WHERE c.id = $1`,
      [creditId],
    );
    return Number(r.rows[0].saldo);
  }

  beforeAll(async () => {
    // Aponta o pool do módulo sob teste para o Postgres de teste ANTES de importar o módulo.
    const url = new URL(PG_TEST_URL as string);
    process.env.PG_HOST = url.hostname;
    process.env.PG_PORT = url.port || '5432';
    process.env.PG_USER = decodeURIComponent(url.username);
    process.env.PG_PASS = decodeURIComponent(url.password);
    process.env.PG_DB = url.pathname.replace(/^\//, '');
    // Liga o pool do módulo sob teste (client.ts) ao MESMO schema — antes de importá-lo.
    process.env.PG_SEARCH_PATH = SCHEMA;
    const pg = await import('pg');
    pgPool = new pg.default.Pool({
      host: process.env.PG_HOST,
      port: Number(process.env.PG_PORT),
      user: process.env.PG_USER,
      password: process.env.PG_PASS,
      database: process.env.PG_DB,
      max: 6,
      options: `-c search_path=${SCHEMA}`,
    });
    await exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    pkg = await import('./packages.js');
    await createSchema();
  }, 30_000);

  afterAll(async () => {
    if (pgPool) {
      await dropSchema().catch(() => {});
      await pgPool.end().catch(() => {});
    }
    // Encerra também o pool interno do módulo (client.ts) para o vitest sair limpo.
    try {
      const client = await import('../client.js');
      await client.closePool();
    } catch {
      /* noop */
    }
  });

  beforeEach(async () => {
    await exec('DELETE FROM package_redemptions WHERE slot = $1', [SLOT]);
    await exec('DELETE FROM client_package_credits WHERE slot = $1', [SLOT]);
    await exec('DELETE FROM service_packages WHERE slot = $1', [SLOT]);
  });

  it('SQL do lock é EXECUTÁVEL e desconta 1 sessão (grava redemption, baixa saldo)', async () => {
    const creditId = await seedCredit({ total: 5, restantes: 3 });
    const r = await pkg.redeemForBooking({
      slot: SLOT,
      tenantId: TENANT,
      phoneHmac: HMAC,
      gcalEventId: 'evt-int-1',
      servicoNome: 'Corte',
    });
    expect(r.descontou_do_pacote).toBe(true);
    expect(r.motivo).toBe('descontado');
    expect(r.sessoes_restantes).toBe(2);
    expect(await countRedeems(creditId)).toBe(1);
    expect(await ledgerSaldo(creditId)).toBe(2);
  });

  it('IDEMPOTÊNCIA: retry do MESMO gcal_event_id não grava 2º redeem', async () => {
    const creditId = await seedCredit({ total: 5, restantes: 3 });
    const base = {
      slot: SLOT,
      tenantId: TENANT,
      phoneHmac: HMAC,
      gcalEventId: 'evt-int-dup',
      servicoNome: 'Corte',
    };
    const r1 = await pkg.redeemForBooking(base);
    const r2 = await pkg.redeemForBooking(base);
    expect(r1.descontou_do_pacote).toBe(true);
    expect(r2.descontou_do_pacote).toBe(true); // reporta descontado, sem dupla baixa
    expect(await countRedeems(creditId)).toBe(1);
    expect(await ledgerSaldo(creditId)).toBe(2);
  });

  it('CORRIDA: 2 reservas concorrentes na ÚLTIMA sessão → só UMA desconta, nunca < 0', async () => {
    const creditId = await seedCredit({ total: 5, restantes: 1 }); // só 1 sessão sobrando
    const mk = (evt: string) =>
      pkg.redeemForBooking({
        slot: SLOT,
        tenantId: TENANT,
        phoneHmac: HMAC,
        gcalEventId: evt,
        servicoNome: 'Corte',
      });
    // Duas dedduções de eventos DIFERENTES (action-lock por horário não as serializa) em paralelo.
    const [a, b] = await Promise.all([mk('evt-race-A'), mk('evt-race-B')]);
    const descontaram = [a, b].filter((x) => x.descontou_do_pacote).length;
    expect(descontaram).toBe(1); // exatamente uma baixou
    expect(await countRedeems(creditId)).toBe(1); // um único -1 no ledger
    expect(await ledgerSaldo(creditId)).toBe(0); // nunca abaixo de zero
    // a que não descontou caiu pra avulso (sem_pacote = saldo esgotado na corrida)
    const avulso = [a, b].find((x) => !x.descontou_do_pacote);
    expect(avulso?.avulso).toBe(true);
  });

  it('ESTORNO devolve a sessão e é idempotente', async () => {
    const creditId = await seedCredit({ total: 5, restantes: 3 });
    await pkg.redeemForBooking({
      slot: SLOT,
      tenantId: TENANT,
      phoneHmac: HMAC,
      gcalEventId: 'evt-int-ref',
      servicoNome: 'Corte',
    });
    expect(await ledgerSaldo(creditId)).toBe(2);
    const ref1 = await pkg.refundForBooking({
      slot: SLOT,
      tenantId: TENANT,
      gcalEventId: 'evt-int-ref',
    });
    expect(ref1.refunded).toBe(true);
    expect(await ledgerSaldo(creditId)).toBe(3); // sessão devolvida
    const ref2 = await pkg.refundForBooking({
      slot: SLOT,
      tenantId: TENANT,
      gcalEventId: 'evt-int-ref',
    });
    expect(ref2.refunded).toBe(false); // idempotente
    expect(ref2.reason).toBe('already_refunded');
    expect(await ledgerSaldo(creditId)).toBe(3);
    expect(await countRedeems(creditId, 'refund')).toBe(1);
  });

  // ── SCRUM-46: validade do pacote no FUSO DO CLONE (não UTC) ──────────────────────────────
  it('pacote que vence HOJE no fuso do clone NÃO aparece vencido; venceu ONTEM aparece', async () => {
    // Acceptance direto do card: "pacote que vence hoje 23h BRT NÃO aparece vencido antes da
    // meia-noite no fuso do clone". Vale em QUALQUER hora do relógio: "hoje"/"ontem" derivam da
    // MESMA regra que a query usa (NOW() AT TIME ZONE <fuso do clone>::date).
    await exec("UPDATE flow_clones SET timezone = 'America/Sao_Paulo' WHERE slot = $1", [SLOT]);
    const dRes = await exec(
      `SELECT (NOW() AT TIME ZONE 'America/Sao_Paulo')::date::text       AS hoje,
              ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date - 1)::text AS ontem`,
    );
    const hoje = dRes.rows[0].hoje as string;
    const ontem = dRes.rows[0].ontem as string;
    const idHoje = await seedCredit({ total: 3, restantes: 3, dataExpiracao: hoje });
    const idOntem = await seedCredit({ total: 3, restantes: 3, dataExpiracao: ontem });
    const credits = await pkg.listClientCredits({ slot: SLOT, phoneHmac: HMAC });
    const byId = new Map((credits as ClientPackageCredit[]).map((c) => [c.credit_id, c] as const));
    // vence HOJE = ainda válido (comparação é estritamente `<`; o dia da validade ainda conta).
    expect(byId.get(idHoje)?.expirado).toBe(false);
    expect(byId.get(idHoje)?.estado).toBe('ATIVO');
    // venceu ONTEM = expirado.
    expect(byId.get(idOntem)?.expirado).toBe(true);
    expect(byId.get(idOntem)?.estado).toBe('EXPIRADO');
  });

  it('a validade é lida POR CLONE: fusos extremos divergem no MESMO data_expiracao', async () => {
    // Guarda anti-regressão de "hardcode SP/UTC": Pacific/Kiritimati (UTC+14) está SEMPRE ≥1 dia à
    // frente de Etc/GMT+12 (UTC-12) — 26h de diferença. Com data_expiracao = HOJE no fuso ATRASADO,
    // o clone atrasado vê "vence hoje" (válido) e o adiantado vê "venceu ontem" (expirado). Prova,
    // de forma determinística e a qualquer hora, que a query lê flow_clones.timezone POR clone.
    const slotWest = 'itest_tz_west'; // Etc/GMT+12 = UTC-12 (atrasado)
    const slotEast = 'itest_tz_east'; // Pacific/Kiritimati = UTC+14 (adiantado)
    const hmacTz = 'itest-hmac-tz';
    for (const s of [slotWest, slotEast]) {
      await exec('DELETE FROM client_package_credits WHERE slot = $1', [s]);
      await exec('DELETE FROM service_packages WHERE slot = $1', [s]);
    }
    await exec(
      `INSERT INTO flow_clones (slot, timezone)
         VALUES ($1,'Etc/GMT+12'), ($2,'Pacific/Kiritimati')
       ON CONFLICT (slot) DO UPDATE SET timezone = EXCLUDED.timezone`,
      [slotWest, slotEast],
    );
    const dRes = await exec("SELECT (NOW() AT TIME ZONE 'Etc/GMT+12')::date::text AS hoje_oeste");
    const hojeOeste = dRes.rows[0].hoje_oeste as string;
    const seedTz = async (slot: string) => {
      const p = await exec(
        `INSERT INTO service_packages (slot, tenant_id, nome, servicos_cobertos, total_sessoes)
         VALUES ($1,$2,'Pacote TZ','["Corte"]'::jsonb,3) RETURNING id`,
        [slot, TENANT],
      );
      await exec(
        `INSERT INTO client_package_credits
           (package_id, slot, tenant_id, cliente_phone_hmac, sessoes_total, sessoes_restantes, data_expiracao)
         VALUES ($1,$2,$3,$4,3,3,$5)`,
        [p.rows[0].id, slot, TENANT, hmacTz, hojeOeste],
      );
    };
    await seedTz(slotWest);
    await seedTz(slotEast);
    const west = await pkg.listClientCredits({ slot: slotWest, phoneHmac: hmacTz });
    const east = await pkg.listClientCredits({ slot: slotEast, phoneHmac: hmacTz });
    expect(west[0]?.expirado).toBe(false); // UTC-12: vence hoje → válido
    expect(east[0]?.expirado).toBe(true); // UTC+14: já é o dia seguinte → expirado
    for (const s of [slotWest, slotEast]) {
      await exec('DELETE FROM client_package_credits WHERE slot = $1', [s]);
      await exec('DELETE FROM service_packages WHERE slot = $1', [s]);
      await exec('DELETE FROM flow_clones WHERE slot = $1', [s]);
    }
  });
});
