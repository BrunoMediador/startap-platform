/**
 * tenant — resolução barata de `slot -> flow_clones.tenant_id` para o DUAL-WRITE
 * da Fase 2 do `tenant_id` (ADR 0018, Passo 2).
 *
 * CONTEXTO: a migration 045 (Fase 1) adicionou `tenant_id UUID` em `flow_clones`
 * (âncora, NOT NULL DEFAULT gen_random_uuid()) e nas satélites (NULLABLE) +
 * backfill pontual. Registros NOVOS inseridos DEPOIS da 045 nasciam com
 * `tenant_id NULL` (o backfill foi único). Este módulo + o dual-write nos
 * caminhos de INSERT passam a carimbar `tenant_id` em toda escrita nova.
 *
 * REGRA DE LEITURA: NADA aqui muda caminho de LEITURA. Ninguém filtra por
 * `tenant_id` ainda — isso é Fase 2b/3 (cutover), com aprovação do Bruno.
 *
 * SAFE-BY-CONSTRUCTION (não-negociável): resolver `tenant_id` JAMAIS pode
 * derrubar uma escrita. `resolveTenantId` NUNCA lança — em cache miss + falha de
 * DB devolve `null`. Slot de plataforma (startap/teste_*) sem linha em
 * `flow_clones` resolve `null` de propósito (esperado, ADR §"slots de plataforma").
 *
 * HOT PATH: `model_usage` é escrito a cada chamada de LLM. Por isso a resolução é
 * cacheada em memória (TTL) por slot — uma chamada de LLM custa, no pior caso, 1
 * SELECT a cada TTL por slot (não 1 por chamada). Caminhos não-quentes (billing,
 * provisioning, mídia) usam subselect inline no próprio INSERT (ver os módulos),
 * que é atômico e resolve NULL sozinho quando não há clone — nem passam por aqui.
 */
import { query } from '../client.js';

/** TTL do cache slot -> tenant_id. Alinhado ao cache de flow-clones (60s). */
const CACHE_TTL_MS = 60_000;

/** Cache slot -> { value: tenant_id | null }. `null` = resolvido como sem tenant. */
const cache = new Map<string, { value: string | null; expiresAt: number }>();

/**
 * Invalida o cache de tenant_id. Sem args limpa tudo; com `slot` limpa um.
 * Chamado quando um clone é criado/removido (o slot pode passar a ter/perder linha).
 */
export function invalidateTenantCache(slot?: string): void {
  if (slot) cache.delete(slot);
  else cache.clear();
}

/**
 * READ CUTOVER (ADR 0018, Fase 2b / Passo 3) — flag `TENANT_READ_CUTOVER`.
 *
 * OFF (default, ausente/qualquer valor != 'true') = LEITURAS AGREGADAS de
 * billing/relatório continuam IDÊNTICAS às de hoje (agregam/juntam por `slot`).
 * ON ('true') = as MESMAS leituras passam a agregar/juntar por `tenant_id`.
 *
 * Escopo do cutover: SÓ leitura agregada/billing/relatório (rollup de model_usage,
 * cross-tabela MRR+uso por cliente). O HOT PATH por-conversa (bot_config/bot_prompt
 * por slot na resposta ao cliente) NÃO é tocado — continua por `slot` sempre.
 *
 * Opcional no boot (lição #247: env nova nunca derruba api/worker). Lida via
 * process.env no ponto de uso — não há config tipado em @startap/db (este package
 * lê env direto, como client.ts). Rollback = desligar a flag (volta a ler por slot).
 *
 * Injetável (`env`) só para teste — em produção sempre lê `process.env`.
 */
export function isTenantReadCutoverEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TENANT_READ_CUTOVER === 'true';
}

/**
 * Resolve o `tenant_id` (UUID) de um `slot` via `flow_clones`. Cacheado (TTL 60s).
 *
 * - Slot com clone -> UUID estável do clone.
 * - Slot de plataforma (sem linha em flow_clones) -> `null` (esperado).
 * - Falha de DB / qualquer erro -> `null` (NUNCA lança — fail-safe do dual-write).
 *
 * O resultado `null` TAMBÉM é cacheado: evita martelar o banco em todo turno de um
 * slot de plataforma (Lola/router de teste, escritos com a mesma frequência).
 */
export async function resolveTenantId(slot: string): Promise<string | null> {
  const cached = cache.get(slot);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const r = await query<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM flow_clones WHERE slot = $1 LIMIT 1',
      [slot],
    );
    const value = r.rows[0]?.tenant_id ?? null;
    cache.set(slot, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    // Fail-safe: erro de resolução NUNCA derruba a escrita que depende de nós.
    // Não cacheia o erro (próxima escrita tenta de novo); devolve null e o INSERT
    // grava tenant_id NULL — exatamente o estado pré-dual-write (não pior).
    return null;
  }
}
