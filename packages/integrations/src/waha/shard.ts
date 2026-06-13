/**
 * Resolução de endpoint WAHA por SHARD (ADR 0020, Passo 2) — atrás da flag
 * `WAHA_SHARDING` (default OFF).
 *
 * CONTEXTO (ADR 0020): hoje há UM único container WAHA (`automacoes-waha-1` = shard
 * 0) atendendo TODAS as sessões. O sharding sobe containers WAHA adicionais NO MESMO
 * box no futuro; clientes NOVOS nascem em shards novos, os existentes ficam no shard
 * 0. Mover sessão existente entre shards = risco de re-pareamento → NUNCA neste
 * rollout. Esta camada só PREPARA: o sistema passa a saber resolver a URL pelo shard,
 * mas hoje o mapa tem só o shard 0 = a WAHA_URL de sempre.
 *
 * SAFE-BY-CONSTRUCTION:
 *   - Flag OFF (default): `resolveWahaUrl` IGNORA o shardId e devolve SEMPRE a
 *     WAHA_URL única de hoje → comportamento idêntico ao de antes deste PR.
 *   - Flag ON: resolve pela URL do shard no mapa; shard desconhecido OU sem URL
 *     configurada cai no shard 0 (WAHA_URL atual). Como só o shard 0 está mapeado
 *     hoje, o resultado continua sendo a mesma URL para todo mundo.
 *
 * COMO LIGAR UM SHARD 1 NO FUTURO (fora deste PR — devops):
 *   1. `devops-sre` sobe `automacoes-waha-2` (mesma imagem congelada, volume próprio).
 *   2. Provisiona env `WAHA_SHARD_1_URL=http://automacoes-waha-2:3000`.
 *   3. Liga `WAHA_SHARDING=true`.
 *   4. Onboarding aloca o cliente NOVO com `flow_clones.waha_shard_id = 1`.
 *   Nada disso move sessão existente: Cirilo/Samuel/Lola seguem no shard 0.
 */

/** Shard do container WAHA atual (`automacoes-waha-1`). Default de todo clone. */
export const DEFAULT_WAHA_SHARD_ID = 0;

/** Lê a flag de sharding do ambiente. Default OFF. */
function isShardingEnabled(): boolean {
  return process.env.WAHA_SHARDING === 'true';
}

/** URL única de hoje (shard 0). Mesmo default que client.ts/sessions.ts usam. */
function baseWahaUrl(): string {
  return process.env.WAHA_URL ?? 'http://waha:3000';
}

/**
 * Monta o mapa shard->URL a partir do ambiente, a cada chamada (sem cache de
 * módulo) para que testes possam variar `process.env` sem reimportar o módulo e
 * para refletir reconfiguração sem restart de processo no caso de leitura tardia.
 *
 * Regras:
 *   - Shard 0 SEMPRE existe e aponta para WAHA_SHARD_0_URL se definida, senão para a
 *     WAHA_URL atual (compatibilidade total com o de hoje).
 *   - Shards >= 1 só entram no mapa se a env correspondente (`WAHA_SHARD_<n>_URL`)
 *     estiver definida. Hoje, nenhuma está → mapa = { 0: WAHA_URL }.
 */
function buildShardUrlMap(): Map<number, string> {
  const map = new Map<number, string>();
  const base = baseWahaUrl();
  map.set(DEFAULT_WAHA_SHARD_ID, process.env.WAHA_SHARD_0_URL ?? base);

  // Varre WAHA_SHARD_<n>_URL para n >= 1. Limite defensivo de 64 shards (a VPS não
  // chega perto disso); para acima do limite, alocar exige ADR/decisão de capacidade.
  for (let shard = 1; shard <= 64; shard++) {
    const url = process.env[`WAHA_SHARD_${shard}_URL`];
    if (url && url.length > 0) map.set(shard, url);
  }
  return map;
}

/**
 * Resolve a URL base do WAHA para um shard.
 *
 * @param shardId shard do clone (de `flow_clones.waha_shard_id`). Opcional; default
 *   shard 0. Com a flag OFF é IGNORADO de propósito (não há para onde rotear).
 * @returns URL base (sem path), ex. "http://waha:3000".
 */
export function resolveWahaUrl(shardId: number = DEFAULT_WAHA_SHARD_ID): string {
  // Flag OFF: sem sharding. Sempre a URL única de hoje — comportamento idêntico.
  if (!isShardingEnabled()) return baseWahaUrl();

  const map = buildShardUrlMap();
  // shard mapeado -> sua URL; shard desconhecido/sem URL -> fallback shard 0.
  return map.get(shardId) ?? map.get(DEFAULT_WAHA_SHARD_ID) ?? baseWahaUrl();
}

/**
 * Lista os shards atualmente configurados (para healthcheck/diagnóstico por shard
 * no futuro). Com a flag OFF retorna só o shard 0 (a realidade de hoje).
 */
export function listConfiguredShards(): Array<{ shardId: number; url: string }> {
  if (!isShardingEnabled()) {
    return [{ shardId: DEFAULT_WAHA_SHARD_ID, url: baseWahaUrl() }];
  }
  return [...buildShardUrlMap().entries()]
    .map(([shardId, url]) => ({ shardId, url }))
    .sort((a, b) => a.shardId - b.shardId);
}
