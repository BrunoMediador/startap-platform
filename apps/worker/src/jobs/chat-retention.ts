/**
 * Job — RETENÇÃO POR IDADE das mensagens de clientes finais (SCRUM-136, LGPD).
 *
 * Ordem do Bruno: "não precisamos ficar salvando por muito tempo as mensagens dos
 * clientes dos nossos clientes". Roda DENTRO do cron cleanup-chat (de hora em hora),
 * DEPOIS do prune por quantidade (memória do bot), então cada sessão já vem capada nas
 * últimas N mensagens quando a retenção olha.
 *
 * O QUE FAZ:
 *  - varre TODAS as tabelas chat_histories* do catálogo (pg_tables), INCLUSIVE tabelas
 *    órfãs de clones excluídos (caso Seven 7 — não aparecem em flow_clones);
 *  - remove conversa VELHA (created_at < now - CHAT_RETENTION_DAYS): sessão morta sai
 *    inteira; sessão ativa preserva suas últimas `keep` mensagens (memória do bot).
 *
 * SEGURANÇA (apagar chat é IRREVERSÍVEL):
 *  - DRY-RUN por default: sem CHAT_RETENTION_ENABLED=true o job só CONTA e LOGA (não
 *    apaga NADA). A deleção real exige o env ON + GO do Bruno.
 *  - Piso anti-fat-finger: CHAT_RETENTION_DAYS abaixo de FLOOR_DAYS força DRY-RUN mesmo
 *    com ENABLED=true (uma retenção de "1 dia" por engano não nuka o banco).
 *  - Idempotente: rodar de novo re-conta/re-apaga só o que ainda se enquadra (sem efeito
 *    colateral em retry).
 *  - Erro por tabela não derruba o loop (tabela órfã sem created_at → warn + segue).
 *  - Log sem PII: contagem por NOME de tabela, nunca conteúdo/telefone.
 */
import { logger } from '@startap/core/logger';
import { chatMemory } from '@startap/db';
import { config } from '../config.js';

const log = logger.child({ job: 'chat-retention' });

/** Piso de segurança: abaixo disso, mesmo com ENABLED=true, força DRY-RUN. */
export const CHAT_RETENTION_FLOOR_DAYS = 7;

const MS_PER_DAY = 86_400_000;

export interface ChatRetentionResult extends Record<string, unknown> {
  dry_run: boolean;
  retention_days: number;
  keep: number;
  cutoff: string;
  tables: number;
  total_matched: number;
  total_deleted: number;
  per_table: Record<string, { matched: number; deleted: number }>;
}

/** Mesmo `keep` do prune por quantidade — a retenção nunca apaga o que a memória preserva. */
function resolveKeep(): number {
  const k = config.CHAT_MEMORY_RETENTION;
  return Number.isFinite(k) && k > 0 ? k : 50;
}

export async function runChatRetention(): Promise<ChatRetentionResult> {
  const retentionDays = config.CHAT_RETENTION_DAYS;
  const keep = resolveKeep();

  // DRY-RUN por default (sem ENABLED) OU piso de segurança violado.
  let dryRun = !config.CHAT_RETENTION_ENABLED;
  if (config.CHAT_RETENTION_ENABLED && retentionDays < CHAT_RETENTION_FLOOR_DAYS) {
    log.warn(
      { retention_days: retentionDays, floor_days: CHAT_RETENTION_FLOOR_DAYS },
      'CHAT_RETENTION_DAYS abaixo do piso de segurança — FORÇANDO DRY-RUN (nada será apagado)',
    );
    dryRun = true;
  }

  const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY);

  const empty: ChatRetentionResult = {
    dry_run: dryRun,
    retention_days: retentionDays,
    keep,
    cutoff: cutoff.toISOString(),
    tables: 0,
    total_matched: 0,
    total_deleted: 0,
    per_table: {},
  };

  let tables: string[];
  try {
    tables = await chatMemory.listChatTablesFromCatalog();
  } catch (e) {
    log.error(
      { err: e },
      'Falha ao listar tabelas de chat do catálogo — retenção abortada neste ciclo',
    );
    return empty;
  }

  const per_table: Record<string, { matched: number; deleted: number }> = {};
  let total_matched = 0;
  let total_deleted = 0;

  for (const table of tables) {
    const res = await chatMemory
      .applyAgeRetention(table, cutoff, keep, { dryRun })
      .catch((err: unknown) => {
        // Tabela sem created_at (órfã pré-migration) ou indisponível: warn, segue o loop.
        log.warn(
          { err, table },
          'Falha na retenção da tabela — pulando (fail-safe, nada apagado nela)',
        );
        return null;
      });
    if (!res) continue;
    if (res.matched > 0 || res.deleted > 0) {
      per_table[table] = { matched: res.matched, deleted: res.deleted };
    }
    total_matched += res.matched;
    total_deleted += res.deleted;
  }

  const result: ChatRetentionResult = {
    dry_run: dryRun,
    retention_days: retentionDays,
    keep,
    cutoff: cutoff.toISOString(),
    tables: tables.length,
    total_matched,
    total_deleted,
    per_table,
  };

  log.info(
    result,
    dryRun
      ? `[chat-retention] DRY-RUN retention_days=${retentionDays} tables=${tables.length} would_delete=${total_matched} per_table=${JSON.stringify(per_table)}`
      : `[chat-retention] APAGADO retention_days=${retentionDays} tables=${tables.length} deleted=${total_deleted} per_table=${JSON.stringify(per_table)}`,
  );

  return result;
}
