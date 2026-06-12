/**
 * trustProxy do portal-api (security review PR #268, item P1 #3).
 *
 * Problema: `trustProxy: true` faz o Fastify confiar na cadeia X-Forwarded-For
 * INTEIRA — req.ip vira o endereço mais à esquerda, CONTROLADO pelo cliente.
 * Atacante manda `X-Forwarded-For: <aleatório>` e bypassa todo rate-limit por
 * IP (inclusive o anti-farm 3/dia do signup).
 *
 * Correção: confiar APENAS nos hops reais (NPM e portal-web, que chegam pelos
 * bridges Docker em faixas privadas). Com isso o proxy-addr percorre a cadeia
 * da direita pra esquerda e para no primeiro endereço NÃO confiável — o IP
 * real do cliente, anexado pelo NPM ($proxy_add_x_forwarded_for, append).
 * XFF forjado pelo cliente fica À ESQUERDA do IP real e é ignorado.
 *
 * Default 'loopback,uniquelocal' (presets do proxy-addr): cobre 127.0.0.0/8,
 * ::1 e as faixas privadas IPv4 (10/8, 172.16/12, 192.168/16) — qualquer
 * subnet que o Docker sortear pros bridges. Sobrescrevível por env
 * PORTAL_TRUST_PROXY ('true' | 'false' | CSV de IPs/CIDRs/presets) sem deploy.
 */
export function parseTrustProxy(raw: string | undefined): boolean | string[] {
  const v = raw?.trim();
  if (!v) return ['loopback', 'uniquelocal'];
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
