/**
 * backfill-pausa-contact-name (SCRUM-144) — preenche flow_pauses.contact_name a partir das
 * tabelas LEGADAS por cliente (pausa_<cliente>), que já têm nomes reais ("Wal Delfim", "Ed+").
 *
 * Por que existe: a captura-na-criação (portal + human_reply) só nomeia pausas NOVAS. As pausas
 * que já existem em flow_pauses ficariam pra sempre sem nome. As tabelas legadas de pausa
 * guardam (numero, nome) e têm nomes reais — este backfill migra esses nomes pro contact_name.
 *
 * SEGURANÇA / idempotência:
 *  - SÓ escreve onde contact_name IS NULL (nunca sobrescreve captura nova). Re-rodar = no-op.
 *  - PULA nome NULL/vazio e o literal 'BOT_DETECTADO' (não é nome — é marca de detecção).
 *  - Match do número INVARIANTE ao 9º dígito (canonicalE164) — legado grava COM o 9
 *    (13 díg.), flow_pauses pode ter 12/13; canonicalizar os dois lados casa o mesmo contato.
 *  - Escopo por slot (flow_id) — nunca cruza tenant.
 *  - Nomes de tabela são LITERAIS deste arquivo (não input) — sem SQL injection; ainda assim
 *    validados por to_regclass (tabela ausente = pula em silêncio).
 *  - LGPD: nome é PII — NUNCA impresso em claro (só contagens + telefone via hint).
 *
 * MAPEAMENTO slot↔tabela: conferido no CLAUDE.md (Estado Atual). O PM confirma os slots antes
 * de rodar (o slot ≠ o nome da sessão WAHA). Adicione linhas aqui conforme surgirem tabelas.
 *
 * USO (rodar como startap_user — o role do app pode não ter acesso às tabelas legadas):
 *   # PREVIEW (não grava — conta o que SERIA preenchido):
 *   npx tsx scripts/backfill-pausa-contact-name.ts --dry-run
 *   # APLICAR:
 *   npx tsx scripts/backfill-pausa-contact-name.ts
 *
 * Pré-requisito: env de DB no ambiente (mesma da api/migrations).
 */
import { canonicalE164, phoneHint } from '@startap/core/phone';
import { closePool, query } from '@startap/db';

/** slot (flow_id em flow_pauses) ↔ tabela legada de pausa. Literais — conferir no CLAUDE.md. */
const MAPPING: ReadonlyArray<{ slot: string; table: string }> = [
  { slot: 'clone_barbearia_samuel_uefpqc', table: 'pausa_samuel' },
  { slot: 'clone_cirilobarbearia_c8w2f0', table: 'pausa_cirilo' },
];

/** Nome só é backfillável se não for vazio nem o literal 'BOT_DETECTADO'. Puro/testável. */
export function isBackfillableName(nome: string | null | undefined): boolean {
  const t = nome?.trim();
  if (!t || t.length === 0) return false;
  return t.toUpperCase() !== 'BOT_DETECTADO';
}

/** Só valida nome literal de tabela (defesa a fundo; a lista é hardcoded). */
function isSafeTableName(t: string): boolean {
  return /^[a-z_][a-z0-9_]*$/.test(t);
}

async function tableExists(table: string): Promise<boolean> {
  const r = await query<{ reg: string | null }>('SELECT to_regclass($1) AS reg', [
    `public.${table}`,
  ]);
  return r.rows[0]?.reg != null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  console.log(
    `[backfill-pausa-contact-name] modo: ${dryRun ? 'DRY-RUN (nada gravado)' : 'APPLY'}\n`,
  );

  let totalFilled = 0;
  let totalSkipped = 0;

  for (const { slot, table } of MAPPING) {
    if (!isSafeTableName(table)) {
      console.log(`- ${table}: nome de tabela inválido — pulado`);
      continue;
    }
    if (!(await tableExists(table))) {
      console.log(`- ${slot} ↔ ${table}: tabela legada ausente — pulado`);
      continue;
    }

    // Candidatas: pausas SEM nome ainda. Só essas podem ser preenchidas (idempotência).
    const cand = await query<{ telefone: string }>(
      'SELECT telefone FROM flow_pauses WHERE flow_id = $1 AND contact_name IS NULL',
      [slot],
    );
    // canonical(telefone) -> lista de telefones crus (uma canônica pode ter formas com/sem 9).
    const byCanon = new Map<string, string[]>();
    for (const row of cand.rows) {
      const c = canonicalE164(row.telefone);
      if (!c) continue;
      const arr = byCanon.get(c) ?? [];
      arr.push(row.telefone);
      byCanon.set(c, arr);
    }

    const legacy = await query<{ numero: string; nome: string | null }>(
      `SELECT numero, nome FROM ${table} WHERE nome IS NOT NULL`,
      [],
    );

    let filled = 0;
    let skipped = 0;
    for (const row of legacy.rows) {
      if (!isBackfillableName(row.nome)) {
        skipped++;
        continue;
      }
      const c = canonicalE164(row.numero);
      const targets = c ? byCanon.get(c) : undefined;
      if (!c || !targets || targets.length === 0) {
        skipped++;
        continue;
      }
      const nome = (row.nome as string).trim();
      for (const tel of targets) {
        if (dryRun) {
          console.log(`- ${slot}: SETARIA contact_name em ${phoneHint(tel)} (do legado ${table})`);
          filled++;
          continue;
        }
        const upd = await query(
          `UPDATE flow_pauses SET contact_name = $3, updated_at = updated_at
             WHERE flow_id = $1 AND telefone = $2 AND contact_name IS NULL`,
          [slot, tel, nome],
        );
        if ((upd.rowCount ?? 0) > 0) {
          console.log(`- ${slot}: PREENCHIDO ${phoneHint(tel)} (do legado ${table})`);
          filled++;
        } else {
          skipped++;
        }
      }
    }
    console.log(
      `  ${slot}: ${filled} ${dryRun ? 'a preencher' : 'preenchidos'}, ${skipped} pulados.\n`,
    );
    totalFilled += filled;
    totalSkipped += skipped;
  }

  console.log(
    `Resumo: ${totalFilled} ${dryRun ? 'a preencher' : 'preenchidos'}, ${totalSkipped} pulados.`,
  );
}

// Só executa quando rodado como script (NÃO em import de teste do predicado).
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /backfill-pausa-contact-name\.ts$/.test(process.argv[1] ?? '');

if (invokedDirectly) {
  main()
    .then(() => closePool())
    .catch(async (e) => {
      console.error('[backfill-pausa-contact-name] erro fatal:', e);
      await closePool();
      process.exit(1);
    });
}
