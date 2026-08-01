/**
 * migrate-faq-para-prompt — migra o FAQ personalizado (JSONB `personalizacao.faq_personalizado`)
 * de clones ELEGÍVEIS pra dentro do `bot_prompt` (ETAPA 1 do plano aprovado pelo Bruno 31/07).
 * Espelha a convenção do molde scripts/migrate-cartao-runtime.ts. Reversível, dry-run por default.
 *
 * ESTRATÉGIA ZERO-MUDANÇA DE COMPORTAMENTO: o bloco anexado ao FIM do bot_prompt reproduz
 * BYTE-A-BYTE o que renderFaqBlock (packages/integrations/src/scheduling/free-slots.ts) já
 * produz em runtime — mesmo header (FAQ_BLOCK_HEADER), mesmos pares P:/R: sanitizados/capados
 * por narrowFaqPairs. Depois de migrar, a chave `faq_personalizado` sai do JSONB na MESMA
 * transação: renderFaqBlock volta a retornar '' pra esse clone (chave ausente), então o
 * conteúdo nunca chega duas vezes no contexto do bot.
 *
 * Elegíveis: clones com personalizacao->'faq_personalizado' array NÃO-VAZIO (após narrow/sanitize).
 *
 * GUARD IDEMPOTENTE: se o bot_prompt já contém o header do bloco FAQ, a migração de UM clone
 * é NO-OP — nunca duplica o bloco numa 2ª execução (mesmo re-rodando --apply sem --slot).
 *
 * NÃO é auto-migration de deploy: é um script MANUAL. Pré-requisito: env de DB (mesma da api).
 *
 * USO:
 *   npx tsx scripts/migrate-faq-para-prompt.ts                 # DRY-RUN (nada gravado), todos elegíveis
 *   npx tsx scripts/migrate-faq-para-prompt.ts --slot <slot>   # DRY-RUN de UM clone
 *   npx tsx scripts/migrate-faq-para-prompt.ts --apply --slot <slot>  # APLICA em UM clone
 *   npx tsx scripts/migrate-faq-para-prompt.ts --apply         # APLICA em todos elegíveis
 *   ... --show-faq                                              # some com QUALQUER combinação
 *       acima: revela o VERBATIM do bloco FAQ no preview (dado sensível — ver LGPD abaixo).
 *       Sem a flag, o preview mostra só a CONTAGEM de pares por clone.
 *
 * REVERSÃO: não há flag --revert automática (o FAQ sai do JSONB no apply, então reverter exige
 * restaurar as DUAS colunas). Use o snapshot pré-migração em bot_prompt_versions
 * (comment = FAQ_MIGRATION_SNAPSHOT_COMMENT, exportado por @startap/db) pra restaurar o
 * bot_prompt manualmente, e reconstrua `personalizacao.faq_personalizado` a partir do bloco
 * migrado (o preview impresso abaixo mostra os pares extraídos) — ação de dupla aprovação,
 * fora do escopo deste script (é MUTAÇÃO reversa em produção, não dry-run).
 *
 * LGPD (F4, review de security da PR #552, 01/08): o preview VERBATIM do FAQ (pode conter dado
 * sensível cadastrado pelo dono — ex.: convênio/saúde, caso Ingrid) só imprime com --show-faq
 * EXPLÍCITO. Sem a flag, mostra só a contagem de pares por clone — suficiente pra decidir se
 * roda --apply sem despejar o conteúdo em claro no stdout/log do terminal. Rodar SEMPRE com
 * --slot em ambiente controlado; NUNCA persistir a saída em log de longa duração fora do
 * terminal do operador, mesmo com --show-faq.
 */
import { botPrompt, closePool, query } from '@startap/db';
import { FAQ_BLOCK_HEADER, narrowFaqPairs } from '@startap/integrations/scheduling';

const EDITED_BY = 'script:migrate-faq-para-prompt';

export interface CloneRow {
  slot: string;
  personalizacao: unknown;
  prompt: string | null;
}

type Verdict = 'CANDIDATE' | 'SKIP';

interface Classified {
  slot: string;
  verdict: Verdict;
  reason: string;
  faqBlock?: string;
  pairCount?: number;
}

/** Monta o bloco FAQ a partir do JSONB — MESMA composição de renderFaqBlock (header + P:/R:),
 *  reusando narrowFaqPairs (fonte única, sem duplicar sanitização/cap de 10 itens). Exportada
 *  pro teste unit cobrir a montagem byte-idêntica sem mockar banco. */
export function buildFaqBlock(personalizacao: Record<string, unknown>): string {
  const pairs = narrowFaqPairs(personalizacao.faq_personalizado);
  if (pairs.length === 0) return '';
  const linhas: string[] = [FAQ_BLOCK_HEADER];
  for (const p of pairs) {
    linhas.push(`P: ${p.pergunta}`);
    linhas.push(`R: ${p.resposta}`);
  }
  return linhas.join('\n');
}

/** Classifica UM clone (pura, sem I/O de escrita). Exportada pro teste unit. */
export function classify(row: CloneRow): Classified {
  const slot = row.slot;
  if (!row.prompt || row.prompt.trim() === '') {
    return { slot, verdict: 'SKIP', reason: 'sem bot_prompt' };
  }
  const pers =
    row.personalizacao && typeof row.personalizacao === 'object'
      ? (row.personalizacao as Record<string, unknown>)
      : {};
  const rawFaq = pers.faq_personalizado;
  if (!Array.isArray(rawFaq) || rawFaq.length === 0) {
    return { slot, verdict: 'SKIP', reason: 'faq_personalizado ausente/vazio — nada a migrar' };
  }
  const faqBlock = buildFaqBlock(pers);
  if (faqBlock === '') {
    return {
      slot,
      verdict: 'SKIP',
      reason: 'faq_personalizado tinha itens, mas nenhum sobreviveu ao narrow/sanitize',
    };
  }
  if (row.prompt.includes(FAQ_BLOCK_HEADER.split('\n')[0])) {
    return { slot, verdict: 'SKIP', reason: 'bot_prompt JÁ contém o bloco FAQ (idempotente)' };
  }
  const pairCount = (faqBlock.match(/^P: /gm) ?? []).length;
  return {
    slot,
    verdict: 'CANDIDATE',
    reason: `${pairCount} par(es) P/R elegíveis — bloco anexado ao FIM do bot_prompt`,
    faqBlock,
    pairCount,
  };
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `    | ${l}`)
    .join('\n');
}

/** Preview do bloco que ENTRARIA no prompt. F4 (LGPD, review de security 01/08): o texto
 *  VERBATIM (pode ter dado sensível — saúde/convênio) só sai com --show-faq explícito. Sem a
 *  flag, mostra só a contagem de pares — suficiente pra decidir rodar --apply sem despejar o
 *  conteúdo do dono no terminal/log por padrão. */
function printPreview(c: Classified, showFaq: boolean): void {
  if (showFaq) {
    console.log('  ── bloco FAQ que seria anexado ao FIM do bot_prompt (--show-faq) ──');
    console.log(indent(c.faqBlock ?? ''));
  } else {
    console.log(
      `  ── bloco FAQ: ${c.pairCount ?? 0} par(es) P/R (rode com --show-faq pra ver o texto) ──`,
    );
  }
}

async function loadClones(slot: string | null): Promise<CloneRow[]> {
  const base = `SELECT fc.slot, fc.personalizacao, bp.prompt
                  FROM flow_clones fc
                  LEFT JOIN bot_prompt bp ON bp.slot = fc.slot`;
  if (slot) {
    const r = await query<CloneRow>(`${base} WHERE fc.slot = $1`, [slot]);
    return r.rows;
  }
  const r = await query<CloneRow>(`${base} ORDER BY fc.slot`);
  return r.rows;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const showFaq = args.includes('--show-faq');
  const slotIdx = args.indexOf('--slot');
  const slot = slotIdx >= 0 ? args[slotIdx + 1] : null;

  const mode = apply ? 'APPLY (grava no banco)' : 'DRY-RUN (preview, nada gravado)';
  console.log(`[migrate-faq-para-prompt] modo: ${mode}${showFaq ? ' | --show-faq' : ''}`);
  console.log(`[migrate-faq-para-prompt] escopo: ${slot ? `slot=${slot}` : 'todos elegíveis'}\n`);

  const clones = await loadClones(slot);
  if (clones.length === 0) {
    console.log('Nenhum clone encontrado.');
    return;
  }

  let candidates = 0;
  let skipped = 0;
  let applied = 0;

  for (const row of clones) {
    const c = classify(row);
    console.log(`▸ ${c.slot} [${c.verdict}] — ${c.reason}`);
    if (c.verdict === 'CANDIDATE' && c.faqBlock) {
      candidates++;
      printPreview(c, showFaq);
      if (apply) {
        const res = await botPrompt.migrateCloneFaqToBotPrompt({
          slot: c.slot,
          faqBlock: c.faqBlock,
          editedBy: EDITED_BY,
        });
        if (res.migrated) {
          applied++;
          console.log(`  ✓ MIGRADO (snapshot v${res.versionSaved ?? '—'}).`);
        } else {
          console.log(`  ⚠ NÃO migrado no apply: ${res.skipped}`);
        }
      }
    } else {
      skipped++;
    }
    console.log('');
  }

  console.log('── RESUMO ────────────────────────────────────────────────────────');
  console.log(`  candidatos (migráveis): ${candidates}`);
  console.log(`  skip (não elegíveis / já migrados): ${skipped}`);
  if (apply) console.log(`  APLICADOS: ${applied}`);
  else
    console.log(
      '  (dry-run — nada foi gravado; rode com --apply --slot <slot> pra migrar 1 clone)',
    );
}

// Só executa quando rodado como script (NÃO em import de teste das funções puras).
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /migrate-faq-para-prompt\.ts$/.test(process.argv[1] ?? '');

/** F4 (LGPD, review de security da PR #552, 01/08): NUNCA loga `err.message` cru — um erro do
 *  driver `pg` pode ecoar o VALOR do parâmetro que causou o erro (ex.: um constraint violado
 *  sobre o próprio bloco FAQ), e o log do processo é sink persistente (fora do controle deste
 *  script). Extrai só `err.name` + o código do Postgres (`err.code`, ex.: '23505'), suficiente
 *  pra diagnosticar sem vazar dado. O erro completo já foi logado pelo PRÓPRIO Postgres (sink
 *  operacional separado, dentro do perímetro de acesso do time de infra).
 */
export function safeErrorSummary(err: unknown): string {
  if (err instanceof Error) {
    const pgCode = (err as Error & { code?: unknown }).code;
    return typeof pgCode === 'string' ? `${err.name} (pg code=${pgCode})` : err.name;
  }
  return 'erro não-Error';
}

if (invokedDirectly) {
  main()
    .then(() => closePool())
    .catch((err) => {
      console.error('[migrate-faq-para-prompt] ERRO:', safeErrorSummary(err));
      return closePool().finally(() => process.exit(1));
    });
}
