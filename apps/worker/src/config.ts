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

  // ── Reconciliacao de pacotes (ADR 0025 divida 5: cancelar+reagendar) ───────
  // RELATORIO read-only de suspeitas de dupla-baixa (2+ redeem do mesmo servico/credito
  // sem refund compensatorio) pra ops AGIR (refund manual). NAO estorna nada sozinho.
  // Gated: so registra o cron com PACOTES_RECONCILE_ENABLED=true (default OFF, como o
  // resto de pacotes). Com OFF o worker sobe normal e o cron nem existe (zero query).
  // Acompanha o rollout de PACOTES_ENABLED — ligar ANTES de escalar pacotes p/ muitos
  // clientes (recomendacao do review do #321). NUNCA obrigatorio no boot (licao #247).
  PACOTES_RECONCILE_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Padrao cron (croner). Default 1x/dia as 09:00 (depois do billing das 08:00).
  // Padrao invalido NUNCA crasha o boot — worker.ts cai pro fallback via scheduleCronSafe.
  PACOTES_RECONCILE_CRON: z.string().default('0 9 * * *'),
  // Janela (horas) pra agrupar redeems do mesmo servico/credito como suspeita. Default 48h.
  PACOTES_RECONCILE_WINDOW_HOURS: z.coerce.number().int().positive().default(48),

  // ── Lembrete de agendamento (one-way, configuravel por clone — migration 060) ──
  // GATE GLOBAL do ENVIO. Com REMINDERS_ENABLED ausente/false o worker sobe normal e o cron
  // 'reminders' NEM e registrado (zero query, zero chamada WAHA) — NO-OP total. Mesmo com a
  // flag ON, so processa clones com flow_clones.reminders_enabled=true (gate POR-CLONE). Dois
  // niveis (global + por-clone), igual ALERTS_ENABLED. OPCIONAL no boot (licao #247: NADA
  // aqui e obrigatorio). Pra ligar em prod: devops seta REMINDERS_ENABLED=true + restart do
  // worker; depois o dono liga o lembrete do clone dele pelo portal. NUNCA hardcoded.
  REMINDERS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Padrao cron (croner). Default a cada 5 min (design). Padrao invalido NUNCA crasha o boot —
  // worker.ts cai pro fallback via scheduleCronSafe.
  REMINDERS_CRON: z.string().default('*/5 * * * *'),
  // Horizonte (min) que a varredura olha pra frente: tem que cobrir a MAIOR janela (24h=1440)
  // + folga. Default 1500 (25h). Atendimentos alem disso ainda nao entram em nenhuma janela.
  REMINDERS_HORIZON_MIN: z.coerce.number().int().positive().default(1_500),
  // Tolerancia (min) do gatilho de janela: dispara quando faltam (janela - tol, janela]. Cobre
  // o passo do cron (*/5) sem perder/duplicar; o claim idempotente garante 1 envio. Default 6.
  REMINDERS_TOLERANCE_MIN: z.coerce.number().int().positive().default(6),
  // Teto de envios por CICLO por SESSAO WAHA (anti-flood/anti-ban da sessao do clone). Default
  // 20. Acima disso o ciclo para de enviar por aquela sessao (os demais entram no proximo).
  REMINDERS_MAX_PER_SESSION: z.coerce.number().int().positive().default(20),
  // Delay humanizador (ms) antes de cada envio (typing + pausa). Default 1500.
  REMINDERS_TYPING_DELAY_MS: z.coerce.number().int().nonnegative().default(1_500),
  // Timeout duro (ms) do sendText — nunca aguardar WAHA infinito (regra 7). Default 8s.
  REMINDERS_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ── Auto-aviso de DESCONEXÃO ao próprio cliente (B2B) ──────────────────────
  // Quando a sessão WAHA de um clone que JÁ conectou cai (up->down no monitor), avisa
  // AUTOMATICAMENTE o DONO do clone pelo WhatsApp (sessão ALERTAS), além do alerta interno
  // pro Bruno. GATE MACRO: SÓ dispara com CLIENT_DISCONNECT_ALERT_ENABLED=true (default OFF —
  // lição #247: nada aqui é obrigatório no boot; ausente = OFF = nenhum aviso). Gate fino
  // POR-CLONE = flow_clones.alert_owner_enabled + destino presente. Roda DENTRO do job monitor
  // já existente (reaproveita o debounce anti-flap); NÃO registra cron novo. Pra ligar em prod:
  // devops seta CLIENT_DISCONNECT_ALERT_ENABLED=true + restart do worker (o monitor já precisa
  // estar ON via ALERTS_ENABLED). NUNCA hardcoded.
  CLIENT_DISCONNECT_ALERT_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Cooldown (min) anti-flap por CLONE: depois de avisar o dono de uma queda, NÃO re-avisa o
  // mesmo clone dentro desta janela — só volta a avisar se a sessão reconectar e cair de novo.
  // A sessão do Seven 7 flapa MUITO (device_removed); somado ao debounce do monitor (~4 min) e à
  // máquina up->down (1 msg por episódio), isto blinda contra spam ao cliente. Default 6h.
  CLIENT_DISCONNECT_ALERT_COOLDOWN_MIN: z.coerce.number().int().positive().default(360),
  // Delay humanizador (ms) antes do envio (typing + pausa) — reduz risco de a sessão ALERTAS ser
  // derrubada por padrão de bot. Default 1500.
  CLIENT_DISCONNECT_ALERT_TYPING_DELAY_MS: z.coerce.number().int().nonnegative().default(1_500),
  // Timeout duro (ms) do sendText — nunca aguardar WAHA infinito (regra 7). Default 8s.
  CLIENT_DISCONNECT_ALERT_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const config = WorkerConfigSchema.parse(process.env);
