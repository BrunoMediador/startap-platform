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
  // C9 (threat-model): boot FALHA se a key estiver ausente. O ambiente Dev/Prod e
  // definido PELA CHAVE (nao pela URL) — Dev nunca vira Prod sem rotacionar a key.
  // A key NUNCA e logada nem hardcoded (vai so no header Authorization do cliente).
  ABACATEPAY_API_KEY: z.string().min(1, 'ABACATEPAY_API_KEY ausente'),
  ABACATEPAY_BASE_URL: z.string().url().default('https://api.abacatepay.com'),

  SERVICE_NAME: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
