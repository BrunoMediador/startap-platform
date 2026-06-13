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

  // ── Sistema de Alertas Interno (Missao 021, Fase 1) ────────────────────────
  // TODAS opcionais com default OFF/seguro (licao #247: NADA aqui e obrigatorio
  // no boot — worker sobe normal mesmo sem nenhuma destas envs). Camada 1 do
  // rollout: liga/desliga o REGISTRO do cron monitor. Com OFF o cron nem registra
  // (zero chamada a WAHA/health, zero envio). A camada 2 (kill-switch quente) vive
  // em alert_config.enabled no banco — toggle na UI sem restart.
  // Pra LIGAR em prod: devops seta ALERTS_ENABLED=true + restart do worker; depois
  // cadastrar numeros e ligar o toggle na UI do gestao.
  ALERTS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Padrao cron do monitor (croner). Default a cada 2 min (spec §1). Padrao
  // invalido NUNCA crasha o boot — worker.ts cai pro fallback via scheduleCronSafe.
  ALERTS_CRON: z.string().default('*/2 * * * *'),
  // URL do /health do startap-api na rede interna Docker (spec §1 reusa o /health
  // que ja expoe checks.db/checks.redis). Default = nome+porta do compose.
  ALERTS_API_HEALTH_URL: z.string().default('http://startap-api:3040/health'),
  // Hard cap global anti-flood: max de mensagens somando todos os checks por
  // janela (spec §4). Protege o numero da Lola num cenario "tudo caiu de uma vez".
  ALERTS_MAX_PER_WINDOW: z.coerce.number().int().positive().default(10),
  ALERTS_WINDOW_MIN: z.coerce.number().int().positive().default(30),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const config = WorkerConfigSchema.parse(process.env);
