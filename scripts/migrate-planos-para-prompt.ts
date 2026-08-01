/**
 * migrate-planos-para-prompt — migra `personalizacao.planos_beneficios` (JSONB, texto livre do
 * dono) de clones ELEGÍVEIS pra dentro do `bot_prompt` (ordem do Bruno 01/08 — repete o que foi
 * feito com o FAQ em 31/07: o campo "Planos e assinaturas" some de Meu negócio › Dados e o
 * conteúdo passa a se configurar conversando com a IA). Espelha a convenção do molde
 * scripts/migrate-faq-para-prompt.ts (removido do repo na faxina #562, recuperado do histórico
 * git como referência). Reversível via snapshot, dry-run por default.
 *
 * ESTRATÉGIA ZERO-DUPLICAÇÃO: o bloco anexado ao FIM do bot_prompt reproduz o texto do dono
 * BYTE A BYTE (sem passar pelo validador de persona — REJECT_LINE é heurística pra persona
 * GERADA pela IA, não pra dado estruturado que o dono já preencheu e confiou ao portal), com o
 * header `PLANOS_BLOCK_HEADER` (packages/db). A reconciliação do JSONB (remoção da chave) roda
 * NO PRÓPRIO SQL, contra a linha do banco, na MESMA transação que grava o bot_prompt e o
 * snapshot — ver o JSDoc de `migrateClonePlanosToBotPrompt` (packages/db/src/queries/bot-prompt.ts)
 * pro detalhe de por que a reconciliação NÃO pode ser feita a partir de um objeto JS lido antes
 * (P0 do FAQ: updateClone/updatePerfilBySlot regravam `personalizacao` por substituição total).
 *
 * Elegíveis: clones com `personalizacao.planos_beneficios` string NÃO-VAZIA (trim).
 *
 * GUARD IDEMPOTENTE: se o bot_prompt já contém a 1ª linha do header, a migração de UM clone é
 * NO-OP — nunca duplica o bloco numa 2ª execução (mesmo re-rodando --apply sem --slot).
 *
 * NÃO é auto-migration de deploy: é um script MANUAL. Pré-requisito: env de DB (mesma da api).
 *
 * USO:
 *   npx tsx scripts/migrate-planos-para-prompt.ts                 # DRY-RUN (nada gravado), todos elegíveis
 *   npx tsx scripts/migrate-planos-para-prompt.ts --slot <slot>   # DRY-RUN de UM clone
 *   npx tsx scripts/migrate-planos-para-prompt.ts --apply --slot <slot>  # APLICA em UM clone
 *   npx tsx scripts/migrate-planos-para-prompt.ts --apply         # APLICA em todos elegíveis
 *   ... --show-planos                                              # some com QUALQUER combinação
 *       acima: revela o VERBATIM do bloco de planos no preview (dado do dono — ver LGPD abaixo).
 *       Sem a flag, o preview mostra só o TAMANHO (chars) do bloco por clone.
 *
 * REVERSÃO: não há flag --revert automática (planos sai do JSONB no apply, então reverter exige
 * restaurar as DUAS colunas). Use o snapshot pré-migração em bot_prompt_versions
 * (comment = PLANOS_MIGRATION_SNAPSHOT_COMMENT, exportado por @startap/db) pra restaurar o
 * bot_prompt manualmente, e reconstrua `personalizacao.planos_beneficios` a partir do bloco
 * migrado (o preview impresso abaixo mostra o texto extraído com --show-planos) — ação de dupla
 * aprovação, fora do escopo deste script (é MUTAÇÃO reversa em produção, não dry-run).
 *
 * LGPD (repete o F4 da review de security da PR #552, 01/08): o preview VERBATIM dos planos
 * (texto livre do dono — normalmente comercial, mas pode conter dado sensível dependendo do
 * ramo) só imprime com --show-planos EXPLÍCITO. Sem a flag, mostra só o tamanho em chars —
 * suficiente pra decidir se roda --apply sem despejar o conteúdo em claro no stdout/log do
 * terminal. Rodar SEMPRE com --slot em ambiente controlado; NUNCA persistir a saída em log de
 * longa duração fora do terminal do operador, mesmo com --show-planos.
 */
import { botPrompt, closePool, query } from '@startap/db';

const EDITED_BY = 'script:migrate-planos-para-prompt';

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
  planosText?: string;
}

/** Classifica UM clone (pura, sem I/O de escrita). Exportada pro teste unit. */
export function classify(row: CloneRow): Classified {
  const slot = row.slot;
  const pers =
    row.personalizacao && typeof row.personalizacao === 'object'
      ? (row.personalizacao as Record<string, unknown>)
      : {};
  const raw = pers.planos_beneficios;
  const planosText = typeof raw === 'string' ? raw.trim() : '';
  if (planosText === '') {
    return { slot, verdict: 'SKIP', reason: 'planos_beneficios ausente/vazio — nada a migrar' };
  }
  const header0 = botPrompt.PLANOS_BLOCK_HEADER.split('\n')[0];
  if (row.prompt?.includes(header0)) {
    return {
      slot,
      verdict: 'SKIP',
      reason: 'bot_prompt JÁ contém o bloco de planos (idempotente)',
    };
  }
  return {
    slot,
    verdict: 'CANDIDATE',
    reason: `${planosText.length} char(s) — bloco anexado ao FIM do bot_prompt`,
    planosText,
  };
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `    | ${l}`)
    .join('\n');
}

/** Preview do bloco que ENTRARIA no prompt. LGPD: o texto VERBATIM só sai com --show-planos
 *  explícito. Sem a flag, mostra só o tamanho — suficiente pra decidir rodar --apply sem
 *  despejar o conteúdo do dono no terminal/log por padrão. */
function printPreview(c: Classified, showPlanos: boolean): void {
  if (showPlanos) {
    console.log('  ── texto de planos que seria anexado ao FIM do bot_prompt (--show-planos) ──');
    console.log(indent(c.planosText ?? ''));
  } else {
    console.log(
      `  ── planos: ${c.planosText?.length ?? 0} char(s) (rode com --show-planos pra ver o texto) ──`,
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
  const showPlanos = args.includes('--show-planos');
  const slotIdx = args.indexOf('--slot');
  const slot = slotIdx >= 0 ? args[slotIdx + 1] : null;

  const mode = apply ? 'APPLY (grava no banco)' : 'DRY-RUN (preview, nada gravado)';
  console.log(`[migrate-planos-para-prompt] modo: ${mode}${showPlanos ? ' | --show-planos' : ''}`);
  console.log(
    `[migrate-planos-para-prompt] escopo: ${slot ? `slot=${slot}` : 'todos elegíveis'}\n`,
  );

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
    if (c.verdict === 'CANDIDATE' && c.planosText) {
      candidates++;
      printPreview(c, showPlanos);
      if (apply) {
        const res = await botPrompt.migrateClonePlanosToBotPrompt(c.slot, EDITED_BY);
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
  /migrate-planos-para-prompt\.ts$/.test(process.argv[1] ?? '');

/** LGPD (mesma cautela da PR #552, 01/08): NUNCA loga `err.message` cru — um erro do driver `pg`
 *  pode ecoar o VALOR do parâmetro que causou o erro (ex.: um constraint violado sobre o próprio
 *  bloco de planos), e o log do processo é sink persistente (fora do controle deste script).
 *  Extrai só `err.name` + o código do Postgres (`err.code`, ex.: '23505'), suficiente pra
 *  diagnosticar sem vazar dado. O erro completo já foi logado pelo PRÓPRIO Postgres (sink
 *  operacional separado, dentro do perímetro de acesso do time de infra). */
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
      console.error('[migrate-planos-para-prompt] ERRO:', safeErrorSummary(err));
      return closePool().finally(() => process.exit(1));
    });
}
