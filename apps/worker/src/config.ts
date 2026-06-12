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

  // ── Cron de limpeza de trials ÓRFÃOS (Missao 020 F1 — condicao 2 do PORTAL_SIGNUP) ──
  // TODAS opcionais com default (licao #247: nada aqui e obrigatorio no boot).
  // Com PORTAL_SIGNUP OFF nao existe clone trial_status='awaiting' => o job roda e
  // nao faz nada. Kill switch: 'false' desliga o job sem deploy.
  TRIAL_ORPHAN_CLEANUP_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),
  // Idade minima (horas) pra signup nunca-pareado virar orfao. Default 72h —
  // o doc 020 nao crava idade pra este caso (o ">30d" do doc e pra trial VENCIDO,
  // outro cenario). Decisao registrada no PR pro Bruno ajustar se quiser.
  TRIAL_ORPHAN_MAX_AGE_HOURS: z.coerce.number().int().positive().default(72),
  // Padrao cron da rodada (croner). Default horario, :30 (evita colidir com o
  // cleanup-chat de :00). Padrao invalido NUNCA crasha o boot — worker.ts cai
  // pro default e loga alto.
  TRIAL_ORPHAN_CRON: z.string().default('30 * * * *'),

  // ── WAHA (teardown da sessao orfa) — mesmos defaults de packages/integrations/waha ──
  WAHA_URL: z.string().default('http://waha:3000'),
  WAHA_API_KEY: z.string().default(''),
  // Exigida apenas pelo contrato WahaConfig (criacao de sessao); o teardown so
  // DELETA sessao — string vazia e segura aqui.
  TS_WEBHOOK_URL: z.string().default(''),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const config = WorkerConfigSchema.parse(process.env);
