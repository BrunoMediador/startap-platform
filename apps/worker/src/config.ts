import { z } from 'zod';

export const WorkerConfigSchema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  SERVICE_NAME: z.string().optional(),

  CHAT_MEMORY_RETENTION: z.coerce.number().int().positive().default(30),
  CHAT_STALE_RUNNING_MAX_MINUTES: z.coerce.number().int().positive().default(30),

  // ── AbacatePay (pagamento PIX — ADR 0013) ──────────────────────────────────
  // OPCIONAL no boot. Pagamento e feature DORMENTE — o cron de geracao (F4) ainda nao
  // esta ativo em prod. Exigir a key no boot derrubou o worker no incidente P0 de
  // 2026-06-09 (loop de restart). Corretiva nº1 do postmortem: segredo de feature
  // INATIVA = opcional no boot, validado no uso. Quando o worker for gerar cobrancas
  // (F4) ele instancia o AbacatePayClient, que lanca AbacatePayNotConfiguredError se a
  // chave faltar — falha alta e explicita SO quando a feature roda. Nunca logada/hardcoded.
  ABACATEPAY_API_KEY: z.string().min(1).optional(),
  ABACATEPAY_BASE_URL: z.string().url().default('https://api.abacatepay.com'),

  // ── Modelo de cobranca por DATA DE VENCIMENTO (ADR 0014) ───────────────────
  // Flag global do novo modelo de billing. OFF (default) = comportamento ATUAL intacto.
  // No worker a flag prepara o terreno pro cron de geracao (F4, fase posterior) — hoje
  // nao altera nenhum job em prod. Opcional no boot (ausente = OFF) — NUNCA crasha o
  // worker. NUNCA hardcoded.
  BILLING_DUE_DATE_MODEL: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const config = WorkerConfigSchema.parse(process.env);
