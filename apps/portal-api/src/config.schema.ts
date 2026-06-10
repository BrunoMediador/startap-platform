import { z } from 'zod';

/**
 * Config tipada do portal-api (ADR 0012). Espelha apps/api/config.schema.ts com
 * as variaveis especificas do portal. Nenhum segredo hardcoded — tudo de env.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.string().default('production'),
  PORTAL_API_PORT: z.coerce.number().default(3051),
  LOG_LEVEL: z.string().default('info'),

  PG_HOST: z.string(),
  PG_PORT: z.coerce.number().default(5432),
  PG_USER: z.string(),
  PG_PASS: z.string(),
  PG_DB: z.string(),

  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional(),

  WAHA_URL: z.string().url(),
  WAHA_API_KEY: z.string(),

  // GCAL é opcional: se ausente, /portal/agendamentos cai no stub vazio.
  GCAL_ENCRYPTION_KEY: z.string().optional(),

  // ── AbacatePay (pagamento PIX — ADR 0013, F3) ──────────────────────────────
  // OPCIONAIS no boot (mesmo padrao de apps/api e apps/worker). Pagamento e feature
  // que NAO pode crashar o portal-api se a config faltar (postmortem P0 2026-06-09:
  // segredo de feature INATIVA = opcional no boot, validado no PONTO DE USO). O
  // AbacatePayClient lanca AbacatePayNotConfiguredError se for usado sem a chave —
  // a rota /portal/mensalidade/pix responde 503 nesse caso, sem derrubar o boot.
  // Ambiente Dev/Prod e definido PELA CHAVE (prefixo abc_dev_*), nao pela URL.
  // NUNCA logada nem hardcoded.
  ABACATEPAY_API_KEY: z.string().min(1).optional(),
  ABACATEPAY_BASE_URL: z.string().url().default('https://api.abacatepay.com'),

  // Segredo para assinar o cookie de sessao (opaco; a sessao mora no Redis).
  // OBRIGATORIO em producao — sem default. Min 32 chars.
  PORTAL_SESSION_SECRET: z.string().min(32, 'PORTAL_SESSION_SECRET deve ter >=32 chars'),

  // TTL da sessao (segundos). Default 7 dias.
  PORTAL_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60),

  // bcrypt cost — apenas para comparacao no login (hash e gerado no painel-admin).
  PORTAL_BCRYPT_COST: z.coerce.number().int().min(8).max(15).default(12),

  // Lockout de login: N tentativas erradas => trava por M minutos.
  PORTAL_LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  PORTAL_LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  // Cookie: secure em prod; sameSite=lax para navegacao cross-subdominio do portal.
  PORTAL_COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),

  SERVICE_NAME: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
