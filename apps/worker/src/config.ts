import { z } from 'zod';

const WorkerConfigSchema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  SERVICE_NAME: z.string().optional(),

  CHAT_MEMORY_RETENTION: z.coerce.number().int().positive().default(30),
  CHAT_STALE_RUNNING_MAX_MINUTES: z.coerce.number().int().positive().default(30),

  // ── AbacatePay (pagamento PIX — ADR 0013) ──────────────────────────────────
  // C9 (threat-model): boot FALHA se a key ausente. O worker gera as cobrancas (F4)
  // instanciando o AbacatePayClient com esta chave. Ambiente Dev/Prod = a CHAVE.
  // Nunca logada nem hardcoded.
  ABACATEPAY_API_KEY: z.string().min(1, 'ABACATEPAY_API_KEY ausente'),
  ABACATEPAY_BASE_URL: z.string().url().default('https://api.abacatepay.com'),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const config = WorkerConfigSchema.parse(process.env);
