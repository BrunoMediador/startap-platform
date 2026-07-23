/**
 * migrate-cartao-runtime — migra clones ELEGÍVEIS pra cartao_mode='runtime' preservando o cartão
 * VERBATIM (SCRUM-92 inc.2 / ADR 0032, refinamento Bruno 23/07). REVERSÍVEL, dry-run por default.
 *
 * ESTRATÉGIA ZERO-MUDANÇA: pra cada clone elegível (prompt_custom=FALSE, modo agenda/estab), o
 * cartão que ele JÁ tem é CAPTURADO literalmente do bot_prompt e guardado em cartao_config.verbatim.
 * Em runtime o buildCartaoRuntimeBlock EMITE esse cartão exato — o cartão só sai do texto baked e
 * entra injetado, IDÊNTICO. O bot_prompt é regravado como PERSONA-ONLY (sem o cartão).
 *
 * QUANDO NÃO É REPRODUZÍVEL → FICA BAKED (fallback seguro > mudar o cartão de um pagante):
 *   - prompt_custom=TRUE (ex.: Ingrid 🌻, cartão à mão): EXCLUÍDO (invariante do arquiteto);
 *   - cartão INTERWOVEN / sem fronteira clara / não-trailing: NÃO migra;
 *   - estratégia 'template' (Cirilo/Samuel — cartão preservado mas com refs no FLUXO/REGRAS e o
 *     bloco muda de posição no systemPrompt): exige --allow-template EXPLÍCITO (revisão do
 *     arquiteto). Sem a flag → reportado como REVISAR e mantido baked.
 *
 * NÃO é auto-migration de deploy: é um script MANUAL. Idempotente. NÃO roda sozinho.
 *
 * USO:
 *   npx tsx scripts/migrate-cartao-runtime.ts                 # DRY-RUN (nada gravado), todos elegíveis
 *   npx tsx scripts/migrate-cartao-runtime.ts --slot <slot>   # DRY-RUN de UM clone
 *   npx tsx scripts/migrate-cartao-runtime.ts --apply --slot <slot>          # APLICA em UM clone
 *   npx tsx scripts/migrate-cartao-runtime.ts --apply --allow-template --slot <slot>  # inclui template
 *   npx tsx scripts/migrate-cartao-runtime.ts --revert <slot>  # REVERTE (restaura baked do snapshot)
 *
 * Sempre imprime o ANTES/DEPOIS do systemPrompt (com um [CONTEXTO] sentinela) pro PM mostrar ao Bruno.
 * Pré-requisito: env de DB (mesma da api).
 */
import { botPrompt, closePool, query } from '@startap/db';
// Subpath (não o barrel): puxa só o módulo puro do cartão, sem instanciar o cliente OpenAI —
// rodar uma migração não deve exigir OPENAI_API_KEY.
import * as promptBuilder from '@startap/integrations/prompt-builder';

const CONTEXT_SENTINEL = '<<< [CONTEXTO] injetado em runtime (dados do banco) >>>';
const EDITED_BY = 'script:migrate-cartao-runtime';

interface CloneRow {
  slot: string;
  prompt_custom: boolean | null;
  product_type: string | null;
  personalizacao: unknown;
  prompt: string | null;
}

type Verdict = 'CANDIDATE' | 'REVISAR' | 'SKIP';

interface Classified {
  slot: string;
  verdict: Verdict;
  reason: string;
  personaOnly?: string;
  cartao?: string;
  seedEmojis?: Record<string, string>;
  strategy?: 'bloco' | 'template';
}

function isAtendente(personalizacao: unknown): boolean {
  if (!personalizacao || typeof personalizacao !== 'object') return false;
  const v = (personalizacao as Record<string, unknown>).agenda_automatica;
  return v === false || v === 'false';
}

/** Classifica UM clone (pura, sem I/O de escrita). */
function classify(row: CloneRow, allowTemplate: boolean): Classified {
  const slot = row.slot;
  if (row.prompt_custom === true) {
    return {
      slot,
      verdict: 'SKIP',
      reason: 'prompt_custom=true (persona à mão — invariante: fica baked)',
    };
  }
  if (isAtendente(row.personalizacao)) {
    return { slot, verdict: 'SKIP', reason: 'modo atendente (sem cartão — no-op)' };
  }
  if (!row.prompt || row.prompt.trim() === '') {
    return { slot, verdict: 'SKIP', reason: 'sem bot_prompt' };
  }
  const ex = promptBuilder.extractBakedCartao(row.prompt);
  if (!ex.found) {
    const reason =
      ex.reason === 'cartao_nao_trailing'
        ? 'cartão NÃO-trailing (interwoven — não reproduzível, fica baked)'
        : 'nenhum cartão baked no bot_prompt (ex.: estabelecimento code-injected) — nada a migrar';
    return { slot, verdict: 'SKIP', reason };
  }
  const seedEmojis = promptBuilder.extractSeedEmojis(ex.cartao);
  if (ex.strategy === 'template' && !allowTemplate) {
    return {
      slot,
      verdict: 'REVISAR',
      reason:
        'cartão via seção [CARTAO DE CONFIRMACAO] (template): preservável VERBATIM, mas com refs no ' +
        'FLUXO/REGRAS e mudança de POSIÇÃO no systemPrompt. Requer --allow-template + revisão do arquiteto.',
      personaOnly: ex.personaOnly,
      cartao: ex.cartao,
      seedEmojis,
      strategy: ex.strategy,
    };
  }
  return {
    slot,
    verdict: 'CANDIDATE',
    reason:
      ex.strategy === 'bloco'
        ? 'cartão em bloco estrutural delimitado — reprodução verbatim limpa'
        : 'cartão em seção [CARTAO DE CONFIRMACAO] (template) — migração autorizada por --allow-template',
    personaOnly: ex.personaOnly,
    cartao: ex.cartao,
    seedEmojis,
    strategy: ex.strategy,
  };
}

/** ANTES (baked) vs DEPOIS (runtime), com [CONTEXTO] sentinela — mostra a mudança estrutural. */
function printBeforeAfter(c: Classified, botPromptText: string): void {
  const before = `${botPromptText}\n\n${CONTEXT_SENTINEL}`;
  const after = `${c.personaOnly}\n\n${CONTEXT_SENTINEL}\n\n${c.cartao}`;
  console.log('  ── systemPrompt ANTES (baked) ──────────────────────────────────');
  console.log(indent(before));
  console.log('  ── systemPrompt DEPOIS (runtime, cartão injetado no fim) ───────');
  console.log(indent(after));
  console.log(`  ── seed de emoji pro picker: ${JSON.stringify(c.seedEmojis)}`);
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `    | ${l}`)
    .join('\n');
}

async function loadClones(slot: string | null): Promise<CloneRow[]> {
  // Elegíveis: prompt_custom não-true, product_type conhecido. (atendente é filtrado no classify.)
  const base = `SELECT fc.slot, fc.prompt_custom, fc.product_type, fc.personalizacao, bp.prompt
                  FROM flow_clones fc
                  LEFT JOIN bot_prompt bp ON bp.slot = fc.slot`;
  if (slot) {
    const r = await query<CloneRow>(`${base} WHERE fc.slot = $1`, [slot]);
    return r.rows;
  }
  const r = await query<CloneRow>(
    `${base} WHERE COALESCE(fc.prompt_custom, false) = false ORDER BY fc.slot`,
  );
  return r.rows;
}

async function doRevert(slot: string): Promise<void> {
  console.log(`[migrate-cartao-runtime] REVERT de ${slot}\n`);
  const res = await botPrompt.revertCloneCartaoRuntime(slot);
  if (res.reverted) {
    console.log(`  ✓ revertido pra baked (restaurado do snapshot v${res.restoredVersion}).`);
  } else {
    console.log(`  ⚠ nada revertido: ${res.skipped}.`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const allowTemplate = args.includes('--allow-template');
  const revertIdx = args.indexOf('--revert');
  const slotIdx = args.indexOf('--slot');
  const revertSlot = revertIdx >= 0 ? args[revertIdx + 1] : null;
  const slot = slotIdx >= 0 ? args[slotIdx + 1] : null;

  if (revertSlot) {
    await doRevert(revertSlot);
    return;
  }

  const mode = apply ? 'APPLY (grava no banco)' : 'DRY-RUN (preview, nada gravado)';
  console.log(
    `[migrate-cartao-runtime] modo: ${mode}${allowTemplate ? ' | --allow-template' : ''}`,
  );
  console.log(`[migrate-cartao-runtime] escopo: ${slot ? `slot=${slot}` : 'todos elegíveis'}\n`);

  const clones = await loadClones(slot);
  if (clones.length === 0) {
    console.log('Nenhum clone elegível encontrado.');
    return;
  }

  let candidates = 0;
  let revisar = 0;
  let skipped = 0;
  let applied = 0;

  for (const row of clones) {
    const c = classify(row, allowTemplate);
    console.log(`▸ ${c.slot} [${c.verdict}] — ${c.reason}`);
    if (c.verdict === 'CANDIDATE' && c.personaOnly && c.cartao) {
      candidates++;
      printBeforeAfter(c, row.prompt ?? '');
      if (apply) {
        const res = await botPrompt.migrateCloneToCartaoRuntime({
          slot: c.slot,
          personaOnlyPrompt: c.personaOnly,
          cartaoConfig: { verbatim: c.cartao, emojis: c.seedEmojis ?? {} },
          editedBy: EDITED_BY,
        });
        if (res.migrated) {
          applied++;
          console.log(
            `  ✓ MIGRADO (snapshot v${res.versionSaved ?? '—'}). Revert: --revert ${c.slot}`,
          );
        } else {
          console.log(`  ⚠ NÃO migrado no apply: ${res.skipped}`);
        }
      }
    } else if (c.verdict === 'REVISAR') {
      revisar++;
      if (c.personaOnly && c.cartao) printBeforeAfter(c, row.prompt ?? '');
    } else {
      skipped++;
    }
    console.log('');
  }

  console.log('── RESUMO ────────────────────────────────────────────────────────');
  console.log(`  candidatos (migráveis): ${candidates}`);
  console.log(`  revisar (template, precisa --allow-template + arquiteto): ${revisar}`);
  console.log(`  skip (não migráveis / no-op): ${skipped}`);
  if (apply) console.log(`  APLICADOS: ${applied}`);
  else
    console.log(
      '  (dry-run — nada foi gravado; rode com --apply --slot <slot> pra migrar 1 clone)',
    );
}

main()
  .then(() => closePool())
  .catch((err) => {
    console.error('[migrate-cartao-runtime] ERRO:', err instanceof Error ? err.message : err);
    return closePool().finally(() => process.exit(1));
  });
