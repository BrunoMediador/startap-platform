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

  // ── Modelo de cobranca por DATA DE VENCIMENTO (ADR 0014) ───────────────────
  // Flag global do novo modelo de billing (janela de pagamento + cobranca ativa por
  // slot). OFF (default) = comportamento ATUAL intacto (cycle=mes, auto-gera sempre).
  // ON = janela de 7 dias antes do next_due_date; em dia nao ve/gera PIX. Opcional no
  // boot (ausente = OFF) — NUNCA crasha o boot. Liga-se em Dev primeiro, depois Prod,
  // sem novo deploy de codigo. NUNCA hardcoded.
  BILLING_DUE_DATE_MODEL: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── Reconexão self-service da sessão WAHA no Portal (ADR 0015) ─────────────
  // Flag da feature. OPCIONAL no boot (ausente = OFF) — NUNCA crasha o boot (lição do
  // postmortem P0 2026-06-09: segredo/flag de feature INATIVA = opcional, validado no
  // ponto de uso). OFF -> GET /portal/conexao responde { enabled:false } e as rotas de
  // ação respondem 404 (front esconde tudo). Liga-se em Dev/piloto sem novo deploy de
  // código. NUNCA hardcoded.
  PORTAL_RECONEXAO_WAHA: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // Timeout (ms) por chamada WAHA do portal-api. Default 8s (ADR 0015 — toda chamada
  // WAHA tem timeout). Opcional; ausente = 8000.
  PORTAL_WAHA_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ── Signup self-service + trial 10 dias (Missão 020 F1) ────────────────────
  // Flag da feature. OPCIONAL no boot (ausente = OFF) — NUNCA crasha o boot (lição
  // do postmortem P0 2026-06-09). OFF -> POST /auth/signup responde 404. Pré-requisito
  // pra ligar: TRIAL_PHONE_PEPPER e TS_WEBHOOK_URL provisionados (validados LAZY no
  // ponto de uso — rota responde 503 se faltarem, sem derrubar o boot).
  PORTAL_SIGNUP: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // Matriz usada pelos clones do signup (v1: matriz única de serviços — decisão
  // 2026-05-24). O modelo de IA vem do bot_config DESSA matriz (gpt-5.4 hoje) —
  // zero default de modelo hardcoded (decisão Bruno 2026-06-11: trial = gpt-5.4).
  PORTAL_SIGNUP_MATRIZ_SLOT: z.string().default('teste_barbearia'),

  // Preço default pós-trial em centavos (client_billing.amount_cents do clone novo).
  // Default R$99,99 (decisão Bruno 2026-06-11). Time edita por cliente no gestão.
  PORTAL_SIGNUP_AMOUNT_CENTS: z.coerce.number().int().positive().default(9999),

  // Rate-limit do signup: N cadastros por dia por IP (anti farm — doc 020 propõe 3).
  PORTAL_SIGNUP_RATE_MAX: z.coerce.number().int().positive().default(3),

  // URL do webhook WAHA do apps/api (mesma TS_WEBHOOK_URL do painel-admin).
  // OPCIONAL no boot; exigida LAZY quando o signup provisiona a sessão WAHA.
  TS_WEBHOOK_URL: z.string().url().optional(),

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
