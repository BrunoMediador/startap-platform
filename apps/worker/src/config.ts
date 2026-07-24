import { z } from 'zod';

export const WorkerConfigSchema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  SERVICE_NAME: z.string().optional(),

  CHAT_MEMORY_RETENTION: z.coerce.number().int().positive().default(30),
  CHAT_STALE_RUNNING_MAX_MINUTES: z.coerce.number().int().positive().default(30),

  // ── Allowlist DURA do antibot (SCRUM-4 PR-A) ───────────────────────────────
  // Quando ON, ANTES de o antibot pausar um suspeito de flood, checa se aquele telefone JÁ
  // tem histórico de agendamento NAQUELE clone (atendimentos) — se tem, é cliente real e NÃO
  // é pausado (reduz falso-positivo de pausar cliente). Default OFF (ausente/false) =
  // comportamento IDÊNTICO ao de hoje: zero mudança, zero query nova (a checagem só roda com a
  // flag ON). OPCIONAL no boot (lição #247: nada aqui é obrigatório — worker sobe sem a env).
  // Pra ligar em prod: devops seta ANTIBOT_ALLOWLIST_ENABLED=true + restart do worker.
  // ⚠️ Decisão ON/OFF em prod é do Bruno (ver corpo do PR) — NÃO assumir. NUNCA hardcoded.
  ANTIBOT_ALLOWLIST_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

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

  // ── Cadencia + reemissao antecipada do cron de billing F4 (SCRUM-124) ───────
  // O cron de geracao/reconciliacao/expiracao roda HORARIO (era 1x/dia as 08:00): antes
  // uma cobranca vencia (expires_at) e a PROXIMA so nascia ~24h depois — janela
  // deterministica SEM PIX pagavel (cliente abria o portal e nao achava cobranca).
  // Rodando horario + reemitindo a proxima ANTES do vencimento (janela abaixo), sempre
  // existe 1 PIX pagavel. Padrao invalido NUNCA crasha o boot (scheduleCronSafe -> fallback).
  BILLING_CRON: z.string().default('0 * * * *'),
  // Janela (min) de reemissao antecipada: pending cujo expires_at cai dentro de now+janela
  // e reemitida AGORA reusando a MESMA linha (idempotente, sem duplicar). Deve ser >=
  // cadencia do cron + folga p/ 1 run perdido. Default 120min (60 de cadencia + 60 de
  // folga): fecha o buraco a zero mantendo pequena a janela em que a cobranca antiga fica
  // orfa no gateway. Opcional com default (licao #247: nada obrigatorio no boot).
  BILLING_REISSUE_AHEAD_MIN: z.coerce.number().int().positive().default(120),

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
  // Intervalo MÍNIMO (horas) entre RE-lembretes "🔴 AINDA CAÍDO" do MESMO check enquanto ele segue
  // down. O alerta de TRANSIÇÃO (up→down "🔴 CAIU") sai NA HORA e é INTOCADO — isto governa SÓ o
  // lembrete recorrente. Antes o intervalo vinha de alert_config.cooldown_min (~30 min no banco) e
  // gerava flood noturno (100+ alertas por sessão caída = risco de BAN do número remetente). Agora o
  // padrão é 1 lembrete a cada 24h (ordem do Bruno 05/07). NÃO é flag de on/off — o re-alerta segue
  // existindo, só espaçado; ajustável por env sem deploy (ex.: 12 = 2×/dia). OPCIONAL no boot (lição
  // #247: nada aqui é obrigatório — worker sobe sem a env, cai no default 24). NUNCA hardcoded.
  MONITOR_REALERT_HOURS: z.coerce.number().positive().default(24),

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

  // ── Health-check do Google Calendar (SCRUM-27 — fim do "active mentiroso") ──────────────────
  // Cron que REVALIDA periodicamente as agendas marcadas 'active' (clones individuais em
  // flow_clones + colaboradores em clone_colaboradores) reusando o MESMO testConnection() do
  // botão "Testar conexão" do painel. Se a agenda quebrou (403/404/creds inválidas) o status cai
  // pra 'invalid' — o bot para de prometer agenda que não existe. Se voltar a passar, re-promove
  // 'invalid'->'active' (auto-heal). NUNCA mexe em 'pending' (confirmação do operador) nem
  // 'disabled' (desligado de propósito). Forward-only, idempotente, não destrutivo.
  //
  // GATE: SÓ registra o cron com GCAL_HEALTHCHECK_ENABLED=true. OPCIONAL no boot (lição #247: nada
  // aqui é obrigatório — worker sobe normal sem a env). Com OFF o cron NEM é registrado (zero query,
  // zero chamada ao Google). ⚠️ Decisão ON/OFF em prod é do Bruno (ver corpo do PR) — NÃO assumir.
  GCAL_HEALTHCHECK_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Padrão cron (croner). Default a cada 2h no minuto 23 (não colide com :00 cleanup-chat, :15
  // close-stale, :30 trial-orphan, :08 billing, :09 reconcile). Padrão inválido NUNCA crasha o boot
  // — worker.ts cai pro fallback via scheduleCronSafe.
  GCAL_HEALTHCHECK_CRON: z.string().default('23 */2 * * *'),
  // Teto de validações por CICLO (anti-burst contra a API do Google + previsibilidade de custo). O
  // cron prioriza as agendas com check mais ANTIGO (NULLS FIRST) e dá a volta em todas ao longo de
  // vários ciclos. Default 50 — folgado pros ~5 clones de hoje (todos checados todo ciclo).
  GCAL_HEALTHCHECK_MAX_PER_RUN: z.coerce.number().int().positive().default(50),
  // Timeout duro (ms) por validação — nunca aguardar o Google infinito (regra 7). Timeout NÃO
  // demove a agenda (transitório = inconclusivo, status preservado): só falha DEFINITIVA
  // (403/404/creds inválidas) vira 'invalid'. Default 8s.
  GCAL_HEALTHCHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ── Detecção de bot (SCRUM-4 PR-C, Fase 1: heurística + alerta-only, NÃO pausa) ──────────────
  // Detecta números que parecem OUTRO bot/empresa (não cliente humano) conversando com o nosso
  // bot e AVISA o dono via ALERTAS ("número X parece um bot — quer que eu pare de responder?").
  // Fase 1 NUNCA pausa (auto-pausa = PR-E). WORKER-ONLY: zero mudança no router/ingestion.
  //
  // GATE MACRO: SÓ registra o cron com BOT_DETECT_ENABLED=true (default OFF — lição #247: nada
  // aqui é obrigatório no boot; ausente = OFF). Com OFF o worker sobe normal e o cron NEM é
  // registrado (zero query, zero WAHA). GATE POR-CLONE: BOT_DETECT_SLOTS (CSV, estilo
  // ATEND_FROM_AGENDA_SLOTS) — vazio/ausente = OFF pra TODOS; só os slots listados são varridos
  // (match EXATO, sem prefixo). Pagante fora da lista = OFF byte-a-byte. KILL-SWITCH = limpar a
  // env. ⚠️ Decisão ON/OFF + quais slots em prod é do Bruno (ver corpo do PR). NUNCA hardcoded.
  BOT_DETECT_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Lista (CSV) de slots onde o job roda. Vazio/ausente = OFF pra todos (default seguro).
  BOT_DETECT_SLOTS: z.string().default(''),
  // Padrão cron (croner). Default a cada hora no minuto 17 (não colide com :00 cleanup, :15
  // close-stale, :23 gcal, :30 trial). Padrão inválido NUNCA crasha o boot — fallback via
  // scheduleCronSafe.
  BOT_DETECT_CRON: z.string().default('17 * * * *'),
  // Teto de candidatos (números novos) classificados por CICLO por clone (custo previsível +
  // anti-burst). O cache (contact_classification) garante que cada número é visto 1× — os que
  // sobram entram nos próximos ciclos. Default 50.
  BOT_DETECT_MAX_PER_RUN: z.coerce.number().int().positive().default(50),
  // Teto de ALERTAS ao dono por CICLO por clone (anti-spam = "cooldown"). Bots além do teto NÃO
  // são cacheados neste ciclo -> são reavaliados/alertados no próximo (nenhum alerta é perdido).
  // Combinado com o cron horário, espaça os avisos. Default 3.
  BOT_DETECT_MAX_ALERTS_PER_RUN: z.coerce.number().int().positive().default(3),
  // Quantas mensagens `human` recentes o sinal de CONTEÚDO analisa por número. Default 20.
  BOT_DETECT_CONTENT_LIMIT: z.coerce.number().int().positive().default(20),
  // Delay humanizador (ms) antes do envio do alerta (typing + pausa) — reduz risco de a sessão
  // ALERTAS ser derrubada por padrão de bot. Default 1500.
  BOT_DETECT_TYPING_DELAY_MS: z.coerce.number().int().nonnegative().default(1_500),
  // Timeout duro (ms) do sendText — nunca aguardar WAHA infinito (regra 7). Default 8s.
  BOT_DETECT_SEND_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ── Auto-pausa de bot (SCRUM-4 PR-E, Fase 2: escalação -> auto-pausa + TTL/reversão) ──────────
  // Passo ADITIVO sobre o bot-detect: depois que a Fase 1 ALERTA o dono, se após uma JANELA DE
  // CARÊNCIA (BOT_DETECT_GRACE_HOURS) o dono não agiu, o número não parou e ainda classifica como
  // bot -> PAUSA AUTOMÁTICO (flow_pauses source='bot_detected' + contact_classification.paused_at).
  // Reversível SEMPRE: TTL (BOT_DETECT_PAUSE_TTL_HOURS) + despausar do cliente no portal.
  //
  // GATE: SÓ roda com BOT_DETECT_AUTOPAUSE=true (default OFF — lição #247; ausente = OFF). Roda
  // DENTRO do cron bot-detect (que já exige BOT_DETECT_ENABLED) + nos MESMOS BOT_DETECT_SLOTS.
  // Com a flag ausente/false a escalação NEM é avaliada (zero query extra) — byte-a-byte OFF.
  // KILL-SWITCH = limpar a env (as pausas já criadas expiram pelo TTL ou o cliente despausa).
  // ⚠️ Decisão ON/OFF em prod é do Bruno (ver corpo do PR). NUNCA hardcoded.
  BOT_DETECT_AUTOPAUSE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // CARÊNCIA (horas) entre o alerta ao dono e a auto-pausa. Dá tempo do dono agir. Default 24h.
  BOT_DETECT_GRACE_HOURS: z.coerce.number().int().positive().default(24),
  // TTL (horas) da pausa source='bot_detected': depois disso o job a remove sozinho (auto-expira).
  // Reversibilidade garantida sem ação humana. Default 168h (7 dias).
  BOT_DETECT_PAUSE_TTL_HOURS: z.coerce.number().int().positive().default(168),
  // Janela (horas) de "atividade recente" em message_log pra considerar que o número NÃO parou.
  // Sem atividade nesta janela -> não auto-pausa (conservador; o número já parou sozinho). message_log
  // retém ~24h, então valores acima disso são efetivamente 24h. Default 12h.
  BOT_DETECT_ACTIVITY_WINDOW_HOURS: z.coerce.number().int().positive().default(12),
  // Teto de AUTO-PAUSAS por CICLO por clone (custo previsível + conservador). Default 10.
  BOT_DETECT_AUTOPAUSE_MAX_PER_RUN: z.coerce.number().int().positive().default(10),

  // ── Classificador LLM na ZONA-CINZA do bot-detect (SCRUM-4 PR-D) ─────────────────────────────
  // Só a ZONA-CINZA da heurística (exatamente 1 eixo ortogonal disparou — ambíguo) paga LLM. Fora
  // dela (≥2 eixos = bot; 0 eixos = humano) NUNCA chama LLM. GATE: BOT_DETECT_LLM=true habilita a
  // chamada na zona-cinza; default OFF (ausente/false) = zona-cinza cai no comportamento atual da
  // heurística (não-bot), ZERO chamada LLM. Independe de BOT_DETECT_ENABLED/SLOTS (que já portam o
  // job): com BOT_DETECT_LLM off, o job roda igual a hoje. ⚠️ Ligar em prod é decisão do Bruno (ver
  // corpo do PR). Pra ligar: devops seta BOT_DETECT_LLM=true + OPENAI_API_KEY no worker + restart.
  // NUNCA hardcoded.
  BOT_DETECT_LLM: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Modelo da zona-cinza. Default gpt-4o-mini (barato; custo input-dominado). Persona-free, temp 0.
  BOT_DETECT_LLM_MODEL: z.string().default('gpt-4o-mini'),
  // Quantas mensagens `human` recentes (cronológicas) vão no prompt do LLM. Default 12 (v1.md).
  BOT_DETECT_LLM_MAX_MSGS: z.coerce.number().int().positive().default(12),
  // Timeout duro (ms) da chamada LLM — nunca aguardar o provider infinito (regra 7). Default 30s.
  BOT_DETECT_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // ── Alerta interno: bot PAGANTE silenciado por inadimplência (SCRUM-67) ──────────────────────
  // VISIBILIDADE (não muda o gate): quando um clone PAGANTE (client_billing.last_payment_at
  // preenchido) é silenciado pelo gate de inadimplência (router: vencido > GRACE_DAYS, atrás de
  // BILLING_OVERDUE_SILENCE), o bot fica mudo e HOJE ninguém sabe (aconteceu com o Cirilo: ~2 dias
  // mudo, 37 msgs ignoradas). Este cron varre os pagantes silenciados e manda UM alerta interno via
  // ALERTAS ("bot do <cliente> silenciado por atraso — reconciliar ou confirmar churn"), com cooldown
  // por-slot pra não spammar todo ciclo. NÃO toca o silêncio (comportamento intocado) — só avisa o time.
  //
  // GATE: SÓ registra o cron com BILLING_SILENCE_ALERT_ENABLED=true (default OFF — lição #247: nada
  // aqui é obrigatório no boot; ausente = OFF = nenhum alerta). Com OFF o worker sobe normal e o cron
  // NEM é registrado (zero query, zero WAHA). Além disso, o job só age quando o PRÓPRIO gate está ON
  // (process.env.BILLING_OVERDUE_SILENCE === 'true', mesma fonte do router): com o gate OFF ninguém
  // está silenciado -> NO-OP (nenhum alerta falso). ⚠️ Decisão ON/OFF em prod é do Bruno (ver corpo
  // do PR). Pra ligar: devops seta BILLING_SILENCE_ALERT_ENABLED=true (+ garantir BILLING_OVERDUE_SILENCE
  // no worker) + restart do worker; o monitor de alertas (ALERTS_ENABLED) já precisa estar configurado
  // pra a ALERTAS/destinatários existirem. NUNCA hardcoded.
  BILLING_SILENCE_ALERT_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Padrão cron (croner). Default de hora em hora no minuto 43 (não colide com :00 cleanup, :08
  // billing, :09 reconcile, :15 close-stale, :17 bot-detect, :23 gcal, :30 trial). Padrão inválido
  // NUNCA crasha o boot — worker.ts cai pro fallback via scheduleCronSafe.
  BILLING_SILENCE_ALERT_CRON: z.string().default('43 * * * *'),
  // Cooldown (min) por CLONE entre alertas do MESMO clone silenciado: enquanto seguir mudo, no máx 1
  // alerta por janela (não 1 por ciclo). Reusa alert_states (chave 'billsilence:<slot>'). Default 1440
  // (24h) = 1 lembrete/dia enquanto pendente — igual à cadência do "🔴 AINDA CAÍDO" do monitor.
  BILLING_SILENCE_ALERT_COOLDOWN_MIN: z.coerce.number().int().positive().default(1_440),

  // ── Rastreio de ENTREGA de outbound + alerta de nack/preso (SCRUM-58) ────────────────────────
  // O app é CEGO à entrega: loga `bot.reply-sent` no 2xx do WAHA, mas o `ack error:463` e outros
  // nacks acontecem DEPOIS (nível WhatsApp) e ninguém sabe (Bruno "chegou?"; Lola 3 dias muda —
  // SCRUM-55). Com o rastreio ON, cada resposta do bot registra o message.id (tabela outbound_
  // messages, migration 073), o evento message.ack atualiza o status (PENDING→SERVER→DEVICE→READ /
  // ERROR) e ESTE cron varre nack TERMINAL (ack -1/463) + outbound PRESO sem entrega além do
  // timeout, avisando o time via ALERTAS (agregado por sessão, com cooldown — não spamma).
  //
  // GATE ÚNICO (mesma env do api): MESSAGE_ACK_TRACKING_ENABLED (default OFF — lição #247). Com a
  // env ausente/false o worker sobe normal e o cron NEM é registrado (zero query, zero WAHA) e o
  // api não registra/atualiza nada (byte-idêntico). A assinatura de `message.ack` na config das
  // sessões WAHA é passo de deploy SEPARADO. ⚠️ Decisão ON/OFF em prod é do Bruno (ver corpo do
  // PR). Pra ligar: devops seta MESSAGE_ACK_TRACKING_ENABLED=true nos DOIS serviços (api + worker)
  // + assina message.ack nas sessões + restart. NUNCA hardcoded.
  MESSAGE_ACK_TRACKING_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Padrão cron (croner). Default a cada 5 min no offset :2 (2-59/5 — evita colidir com :00 cleanup,
  // */5 reminders, :08 billing, :15 close-stale, :17 bot-detect, :23 gcal, :30 trial, :43 billsilence).
  // Padrão inválido NUNCA crasha o boot — worker.ts cai pro fallback via scheduleCronSafe.
  MESSAGE_ACK_ALERT_CRON: z.string().default('2-59/5 * * * *'),
  // Janela (min) que um outbound pode ficar em PENDING/SERVER (aceito, mas sem confirmação de
  // ENTREGA ao aparelho) antes de ser considerado PRESO e virar alerta. Cobre o caso 463 em que o
  // DEVICE nunca chega. Default 5.
  MESSAGE_ACK_STUCK_MIN: z.coerce.number().int().positive().default(5),
  // Cooldown (min) por SESSÃO entre alertas de entrega falhando da MESMA sessão. Uma sessão mute
  // (463) falharia N mensagens; agregamos por sessão e alertamos no máx 1×/janela (reusa
  // alert_states, chave 'msgack:<session>'). Default 360 (6h) — mesma cadência do auto-aviso de
  // desconexão.
  MESSAGE_ACK_ALERT_COOLDOWN_MIN: z.coerce.number().int().positive().default(360),
  // Teto de outbounds alertáveis lidos por CICLO (anti-burst). O agregado por sessão + o cooldown já
  // limitam o ENVIO; isto limita a LEITURA. Default 200.
  MESSAGE_ACK_ALERT_MAX_PER_RUN: z.coerce.number().int().positive().default(200),
  // Retenção (dias) das linhas de tracking (efêmeras, não fonte de verdade). O cron poda as antigas
  // (mesmo padrão de pruneOldFlowEvents). Default 7.
  MESSAGE_ACK_RETENTION_DAYS: z.coerce.number().int().positive().default(7),

  // ── Gate por-clone do billing DERIVADO da agenda (ADR 0027/0030 D1) — reusado pelo reconciler ──
  // MESMA env que os apps api/portal-api usam pra decidir se o hook de billing-da-agenda roda num
  // slot (CSV; '*' = todos). NO WORKER ela é OBRIGATÓRIA pro reconciler (SCRUM-89) enxergar os
  // clones gated por ENV (dragon/cirilo/samuel) — os gated por COLUNA (Ingrid) já entram pela query.
  // Sem esta env, o worker só reconciliaria os por-coluna. Default '' = só a coluna decide (seguro).
  // ⚠️ Passo de deploy: devops garante ATEND_FROM_AGENDA_SLOTS no container startap-worker (hoje só
  // existe no api/portal-api). OPCIONAL no boot (lição #247: ausente = ''  = nenhum slot por-env).
  ATEND_FROM_AGENDA_SLOTS: z.string().default(''),

  // ── Sync periódico GCal→atendimentos (SCRUM-89 / ADR 0031 — Faturamento espelha a agenda) ─────
  // Reconcilia, por clone com o gate billing-da-agenda ON e agenda 'active', uma janela [-LOOKBACK,
  // +LOOKAHEAD]: UPSERT de todo evento presente (inclusive os criados À MÃO no GCal, que não passam
  // por hook) + DELETE (soft) das linhas origem='agenda' cujo evento SUMIU — INCLUSIVE passado e
  // linha já paga (decisão do Bruno: a agenda é a fonte da verdade; deleção de linha paga é auditada
  // em warn). origem='manual' é INTOCÁVEL. DELETAR só sobre listagem COMPLETA (fail-safe): qualquer
  // truncamento/erro/timeout na paginação do GCal → NÃO deleta nada naquele ciclo (upsert segue).
  //
  // GATE MACRO: SÓ registra o cron com GCAL_ATEND_SYNC_ENABLED=true (default OFF — lição #247: nada
  // aqui é obrigatório no boot; ausente = OFF = cron nem existe = zero query, zero GCal). ⚠️ Decisão
  // ON/OFF em prod é do Bruno (ver corpo do PR). NUNCA hardcoded.
  GCAL_ATEND_SYNC_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Padrão cron (croner). Default de hora em hora no minuto :37 (LIVRE — os ocupados: * antibot,
  // */2 monitor, */5 reminders, 2-59/5 msgack, :00 cleanup, :08 billing, :09 reconcile, :15
  // close-stale, :17 bot-detect, :23 gcal-health, :30 trial, :43 billsilence). Padrão inválido
  // NUNCA crasha o boot — worker.ts cai pro fallback via scheduleCronSafe.
  GCAL_ATEND_SYNC_CRON: z.string().default('37 * * * *'),
  // Janela de DELEÇÃO pra trás (dias): cobre a aba "Mês passado" do portal com folga. Default 62.
  GCAL_ATEND_SYNC_LOOKBACK_DAYS: z.coerce.number().int().positive().default(62),
  // Janela de DELEÇÃO pra frente (dias): cobre a Previsão. Default 60.
  GCAL_ATEND_SYNC_LOOKAHEAD_DAYS: z.coerce.number().int().positive().default(60),
  // Pad (dias) da janela de LISTAGEM sobre a de deleção (listagem = deleção ± pad). Evita
  // falso-delete de evento arrastado pra borda da janela de deleção. Default 7.
  GCAL_ATEND_SYNC_LIST_PAD_DAYS: z.coerce.number().int().positive().default(7),
  // Teto de páginas do listEventsPaged por calendário (100 eventos/página → 20 = até 2000). É o
  // LIMITE DE COMPLETUDE: teto atingido com token pendente → ciclo "incompleto" → NÃO deleta. Default 20.
  GCAL_ATEND_SYNC_MAX_PAGES: z.coerce.number().int().positive().default(20),
  // Timeout duro (ms) por PÁGINA do listEventsPaged — nunca aguardar o Google infinito (regra 7).
  // Timeout = página incompleta = não deleta. Default 15000.
  GCAL_ATEND_SYNC_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  // Grace (segundos) no filtro por updated_at: candidato a deleção precisa ter updated_at <
  // (inicio_do_ciclo - grace). Mata a corrida com o hook do bot/portal (linha nascida durante o
  // ciclo não é deletada). Default 120.
  GCAL_ATEND_SYNC_DELETE_GRACE_SEC: z.coerce.number().int().positive().default(120),
  // Teto de clones reconciliados por ciclo (previsibilidade de custo). Folgado pros ~4 de hoje.
  // Default 50.
  GCAL_ATEND_SYNC_MAX_SLOTS_PER_RUN: z.coerce.number().int().positive().default(50),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const config = WorkerConfigSchema.parse(process.env);
