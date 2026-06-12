import { z } from 'zod';

export const ConfigSchema = z.object({
  NODE_ENV: z.string().default('production'),
  API_PORT: z.coerce.number().default(3040),
  LOG_LEVEL: z.string().default('info'),

  PG_HOST: z.string(),
  PG_PORT: z.coerce.number().default(5432),
  PG_USER: z.string(),
  PG_PASS: z.string(),
  PG_DB: z.string(),

  WAHA_URL: z.string().url(),
  WAHA_API_KEY: z.string(),

  // ── Auth do webhook WAHA (P0 security — review do PR #268) ─────────────────
  // Secret compartilhado exigido no header X-Webhook-Secret de POST /webhooks/waha.
  // OPCIONAL no boot (lição do incidente #247: env nova nunca derruba api/worker):
  // ausente = aceita tudo (comportamento atual) + warn no boot; presente =
  // request sem header/match -> 401 sem processar (comparação timing-safe).
  // Ativação em prod SEM downtime: docs/runbooks/runbook-waha-webhook-auth.md
  // (env aqui + customHeaders em cada sessão WAHA). Pré-requisito pra ligar
  // PORTAL_SIGNUP. NUNCA logado nem hardcoded.
  WAHA_WEBHOOK_SECRET: z.string().min(1).optional(),

  WHISPER_URL: z.string().url(),

  OPENAI_API_KEY: z.string(),
  OPENAI_MODEL: z.string().default('gpt-5.4'),
  AGENT_HISTORY_MAX_CHARS: z.coerce.number().int().positive().default(12000),
  AGENT_TOOL_RESULT_MAX_CHARS: z.coerce.number().int().positive().default(6000),

  DEEPSEEK_API_KEY: z.string().optional(),

  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().default(6379),

  STARTAP_WAHA_SESSIONS: z.string().default('startap,STARTAP_AI,STARTAP_AI_PROD'),

  CHAT_MEMORY_RETENTION: z.coerce.number().int().positive().default(30),
  CHAT_STALE_RUNNING_MAX_MINUTES: z.coerce.number().int().positive().default(30),

  GCAL_ENCRYPTION_KEY: z.string().optional(),

  // ── AbacatePay (pagamento PIX — ADR 0013) ──────────────────────────────────
  // OPCIONAL no boot. Pagamento (F1) e feature DORMENTE — sem webhook nem cron ativos
  // em prod hoje. Tornar a key obrigatoria no boot acoplou o uptime dos bots a uma
  // config nao usada e derrubou api/worker no incidente P0 de 2026-06-09 (loop de
  // restart). Corretiva nº1 do postmortem: segredo de feature INATIVA = opcional no
  // boot, validado no PONTO DE USO. O AbacatePayClient lanca AbacatePayNotConfiguredError
  // se for usado sem a chave — falha alta e explicita SO quando a feature roda.
  // Ambiente Dev/Prod e definido PELA CHAVE (nao pela URL). NUNCA logada nem hardcoded.
  ABACATEPAY_API_KEY: z.string().min(1).optional(),
  ABACATEPAY_BASE_URL: z.string().url().default('https://api.abacatepay.com'),

  // ── Webhook PIX (F2 — ADR 0013 / threat-model C9) ───────────────────────────
  // OPCIONAIS no boot (mesmo padrao do #248 / postmortem P0 2026-06-09): webhook e
  // feature INATIVA ate o go-live. Validados no PONTO DE USO (a rota /webhooks/abacatepay
  // responde 503 se chamada sem eles), NUNCA no boot — ausencia nao crasha a api.
  // - ABACATEPAY_WEBHOOK_QUERY_SECRET: comparado com ?webhookSecret= (timing-safe, C6).
  // - ABACATEPAY_WEBHOOK_SECRET: chave do HMAC-SHA256 sobre o RAW BODY (C3/C6).
  // NUNCA logados nem hardcoded. Key de Prod rotacionada antes do go-live; Dev != Prod.
  ABACATEPAY_WEBHOOK_QUERY_SECRET: z.string().min(1).optional(),
  ABACATEPAY_WEBHOOK_SECRET: z.string().min(1).optional(),

  // ── Modelo de cobranca por DATA DE VENCIMENTO (ADR 0014) ───────────────────
  // Flag global do novo modelo de billing. OFF (default) = comportamento ATUAL intacto.
  // No apps/api a flag governa SO o avanco de vencimento do webhook PAID: ON usa
  // max(next_due_date, hoje)+1mes (nao renova pro passado em re-cobranca/vencido); OFF
  // usa o avanco legado (a partir de next_due_date puro). Opcional no boot (ausente =
  // OFF) — NUNCA crasha o boot dos bots. NUNCA hardcoded.
  BILLING_DUE_DATE_MODEL: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── Silêncio do bot por perfil de cobrança (ADR 0016) ──────────────────────
  // Flag do segundo eixo do gate de silêncio: quando ON, o bot de um clone CALA se
  // estiver vencido além da carência (daysUntilDue(next_due_date) < -GRACE_DAYS, e só
  // se houver billing: next_due_date E amount_cents>0). OFF (default) = comportamento
  // ATUAL intacto — só flow_enabled=false (suspensão manual) cala. Opcional no boot
  // (ausente = OFF) — NUNCA crasha o boot dos bots. NUNCA hardcoded. O router lê o
  // process.env diretamente no gate; esta entrada documenta/valida o formato.
  BILLING_OVERDUE_SILENCE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  SERVICE_NAME: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
