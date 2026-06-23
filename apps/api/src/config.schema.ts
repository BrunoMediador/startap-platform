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

  // ── Auth do webhook WAHA (P0 security — review do PR #268 + spike 2026-06-11) ──
  // Dois mecanismos, AMBOS opcionais no boot (lição do incidente #247: env nova
  // nunca derruba api/worker). Precedência (decisão do spike, HMAC = plano A):
  //   1. WAHA_WEBHOOK_HMAC_KEY presente  -> exige assinatura HMAC do WAHA nativo
  //      (webhooks[].hmac.key na config da sessão) calculada sobre o RAW BODY.
  //      HMAC sozinho basta: autentica + integridade; o header estático é IGNORADO
  //      mesmo se WAHA_WEBHOOK_SECRET também existir. Replay/duplicata de mensagem
  //      é tratado no router (dedup (sessao, messageId) no Redis, ADR 0019), não aqui.
  //   2. Só WAHA_WEBHOOK_SECRET presente -> plano B: header estático X-Webhook-Secret
  //      via webhooks[].customHeaders (comparação timing-safe).
  //   3. Nenhum -> aceita tudo (comportamento atual) + warn no boot.
  // Falha em qualquer modo -> 401 SEM processar nada (nem parse do payload).
  // Ativação em prod SEM downtime: docs/runbooks/runbook-waha-webhook-auth.md
  // (sessões WAHA primeiro, env depois). Pré-requisito pra ligar PORTAL_SIGNUP.
  // NUNCA logados nem hardcoded.
  WAHA_WEBHOOK_SECRET: z.string().min(1).optional(),
  WAHA_WEBHOOK_HMAC_KEY: z.string().min(1).optional(),
  // Nome do header da assinatura e algoritmo: a doc do WAHA indica X-Webhook-Hmac
  // (hex) + X-Webhook-Hmac-Algorithm: sha512, mas o OpenAPI da NOSSA versão
  // congelada (2026.3.2) não crava os nomes — por isso são configuráveis, com
  // default no que a doc indica. O runbook valida na cobaia WHATSAPP_ROUTER_TESTE
  // antes de ligar o enforcement.
  WAHA_WEBHOOK_HMAC_HEADER: z
    .string()
    .min(1)
    .default('x-webhook-hmac')
    .transform((v) => v.toLowerCase()),
  WAHA_WEBHOOK_HMAC_ALGORITHM: z.enum(['sha256', 'sha512']).default('sha512'),

  WHISPER_URL: z.string().url(),

  // ── Provider de transcrição de áudio (ADR 0021) ────────────────────────────
  // Flag-gated, default 'local' = comportamento ATUAL idêntico (Whisper :9000).
  // 'openai' roteia o áudio pra OpenAI audio.transcriptions.create (mesma chave
  // OPENAI_API_KEY do chat). Lida em RUNTIME no integrations, NÃO valida no boot
  // como obrigatória (lição #247: env nova nunca derruba api/worker). O enum aqui
  // só documenta/valida o formato quando presente. Permite desligar o Whisper
  // local depois (libera ~1.3 GiB RAM + 2 vCPU da VPS — ver capacidade-vps).
  TRANSCRIBE_PROVIDER: z.enum(['local', 'openai']).optional(),
  // Modelo de transcrição OpenAI. Default gpt-4o-mini-transcribe (~US$0.003/min,
  // metade do whisper-1, melhor qualidade PT-BR). Ajustável sem deploy.
  OPENAI_TRANSCRIBE_MODEL: z.string().optional(),
  // Timeout da chamada de transcrição OpenAI (ms).
  OPENAI_TRANSCRIBE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  // Se 'false', NÃO cai pro Whisper local quando a OpenAI falhar (default cai).
  TRANSCRIBE_OPENAI_FALLBACK_LOCAL: z.enum(['true', 'false']).optional(),

  OPENAI_API_KEY: z.string(),
  OPENAI_MODEL: z.string().default('gpt-5.4'),
  AGENT_HISTORY_MAX_CHARS: z.coerce.number().int().positive().default(12000),
  AGENT_TOOL_RESULT_MAX_CHARS: z.coerce.number().int().positive().default(6000),

  DEEPSEEK_API_KEY: z.string().optional(),

  REDIS_HOST: z.string().default('redis'),
  REDIS_PORT: z.coerce.number().default(6379),
  // OPCIONAL no boot (mesmo Redis do worker/portal-api; portal-api ja usa
  // REDIS_PASSWORD). Ausente = sem auth (Redis local sem senha) — comportamento
  // atual da api intacto. NUNCA logado nem hardcoded.
  REDIS_PASSWORD: z.string().optional(),

  // ── Dedup de evento de mensagem WAHA (ADR 0019, passo 2) ───────────────────
  // Flag-gated, default OFF, OPCIONAL no boot (licao do #247: env nova NUNCA
  // derruba api/worker). OFF = comportamento ATUAL (sem dedup; igual a hoje).
  // ON = antes de processar um evento de mensagem faz SET NX EX no Redis com
  // chave (sessao, messageId); se a chave ja existe -> retry/duplicata -> PULA.
  // FAIL-OPEN: Redis inacessivel/timeout no check -> processa MESMO ASSIM (warn).
  // Idempotencia e protecao contra duplicata, nunca pode calar o bot. Com 1
  // instancia e inocuo (nunca ha corrida) — serve pra observar quantos retries
  // a WAHA reenvia hoje. Fail-closed so no scale-out (passo 5, decisao Bruno).
  // NUNCA hardcoded.
  IDEMPOTENCY_DEDUP: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // TTL da chave de dedup (cobre a janela de retry da WAHA sem reter memoria).
  // Default 300s (valor do ADR 0019). Curto demais = retry tardio escapa;
  // longo demais = retem chaves. Ajustavel sem deploy.
  IDEMPOTENCY_DEDUP_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Timeout do comando Redis no check de dedup (ms). Estoura -> fail-open
  // (processa). Curto de proposito: o caminho quente nao pode esperar Redis.
  // Reusado tambem pelo action-lock (mesmo orcamento de latencia no caminho quente).
  IDEMPOTENCY_REDIS_TIMEOUT_MS: z.coerce.number().int().positive().default(500),

  // ── Lock de acao com efeito externo (ADR 0019, passo 3) ────────────────────
  // Flag-gated, default OFF, OPCIONAL no boot (licao do #247: env nova NUNCA
  // derruba api/worker). OFF = comportamento ATUAL (cria o evento GCal como hoje,
  // sem lock). ON = a criacao do evento GCal e envolvida por um lock distribuido
  // por chave semantica (actionlock:gcal:<slot>:<telefone>:<inicioISO>): so quem
  // adquire o SET NX PX cria o evento; processamento concorrente da MESMA acao
  // (mesma conversa, mesmo horario) PULA -> 1 evento, nao 2.
  // FAIL-OPEN: Redis inacessivel/timeout ao adquirir o lock -> cria o evento
  // MESMO ASSIM (warn). Nunca dropar agendamento legitimo por hiccup de Redis.
  // Com 1 instancia e inocuo (sempre adquire) — o ganho real e no scale-out
  // (passo 5, decisao Bruno). NUNCA hardcoded.
  IDEMPOTENCY_ACTION_LOCK: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // TTL do lock de acao (ms). Cobre a duracao de UMA criacao de evento GCal +
  // margem; expira sozinho (sem lock orfao se a instancia morrer no meio).
  // Default 10000ms (chamada GCal + rede). Ajustavel sem deploy.
  IDEMPOTENCY_ACTION_LOCK_TTL_MS: z.coerce.number().int().positive().default(10000),

  // ── Decouple async do webhook WAHA (ADR 0021) ─────────────────────────────
  // Flag-gated, default OFF, OPCIONAL no boot (licao do #247: env nova NUNCA
  // derruba api/worker). OFF = comportamento ATUAL byte-a-byte (await handleWebhook
  // sincrono no ciclo da request). ON = a rota responde 200 ao WAHA na hora
  // (ACK-early, apos HMAC+parse+safeParse+dedup+log) e processa handleWebhook em
  // BACKGROUND, fora do ciclo request->response, com semaforo de concorrencia.
  // Resolve isolamento: 1 cliente lento na LLM nao prende mais o pool PG e o event
  // loop dos demais. SO e seguro com IDEMPOTENCY_DEDUP ATIVO (dedup ANTES do ACK
  // evita reprocessar retry da WAHA). Enable encenado (sessao de teste -> janela
  // 01-05h BRT). NUNCA hardcoded. O caminho quente le esta flag via config (parseado
  // no boot); rollback = WEBHOOK_ASYNC=false (volta ao sincrono).
  WEBHOOK_ASYNC: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Maximo de processamentos de webhook em background simultaneos (backpressure
  // primario, ADR 0021). DEVE ser < pool PG (max 10) pra nunca esgotar conexao nem
  // saturar o event loop. Default conservador = 4. Quando saturado, a rota responde
  // 503 e a WAHA retenta (15x3s); o dedup evita duplicar. Ajustavel sem deploy.
  WEBHOOK_MAX_INFLIGHT: z.coerce.number().int().positive().default(4),
  // Timeout por tarefa de background (ms): uma LLM travada libera o slot do
  // semaforo e nao o segura pra sempre. Default 60s. 0 desativa (espera indefinida
  // — nao recomendado em prod). Rede final = close-stale-running no worker.
  WEBHOOK_TASK_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(60_000),

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

  // ── Cancelamento escalado (Missão 023 W5 — ALTO risco, DORMENTE) ───────────
  // Quando o cliente final pede CANCELAMENTO ao bot de um barbeiro, o bot NÃO cancela:
  // escala um alerta pro DONO do clone (flow_clones.alert_owner_phone, migration 050)
  // pela sessão remetente `ALERTAS` (W3). O GCal NUNCA é tocado (não há tool de delete).
  // Flag OPCIONAL no boot (default OFF — lição #247: env nova NUNCA derruba api/worker).
  //   OFF (ausente/false) -> comportamento ATUAL 100% preservado (o bot responde "vou
  //                          avisar o time", SEM enviar alerta nenhum). Idêntico a hoje.
  //   ON  (true)          -> a tool escalar_cancelamento dispara o alerta pro dono
  //                          (respeitando alert_owner_enabled por-clone + cooldown anti-flood).
  // Ligar SÓ após QA controlado no Cirilo. NUNCA hardcoded.
  CANCELAMENTO_ESCALADO_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Cooldown anti-flood do alerta, em minutos, por (slot, telefone-do-cliente). Evita 10
  // WhatsApps pro dono se o cliente repetir "cancelar". Default 30min (design W5). Persistido
  // em alert_states (reusa a máquina anti-spam; sem tabela nova). Ajustável sem deploy.
  CANCELAMENTO_ESCALADO_COOLDOWN_MIN: z.coerce.number().int().positive().default(30),

  // ── Blocklist GLOBAL de números internos (Missão 023 — fix do cancelamento) ──
  // Lista (CSV) de números OPERACIONAIS internos que os bots NÃO devem responder
  // (o remetente da sessão ALERTAS, 553598373138, que dispara avisos pro time/donos).
  // Aplicada no router compartilhado ANTES de antibot/routing/IA/GCal -> vale pra TODOS
  // os clones. OPCIONAL no boot (ausente = só o default = remetente da ALERTAS). Env
  // opcional com default NÃO é env obrigatória nova (lição #247: env nova nunca derruba
  // api/worker). O router lê a lib bot-blocklist (que lê process.env direto, mesmo padrão
  // dos gates de flag); esta entrada documenta/valida o formato. NÃO incluir números do
  // time/teste do Bruno aqui.
  BOT_BLOCKLIST_NUMBERS: z.string().optional(),

  // ── Estabelecimento multi-colaborador (ADR 0023/0024, Fase A — DORMENTE) ────
  // Gate macro do tipo de conta ESTABELECIMENTO. OPCIONAL no boot (default OFF —
  // lição #247: env nova NUNCA derruba api/worker). O caminho novo (agenda por
  // colaborador, blocos [PROFISSIONAIS]/[HORARIOS] rotulados, param colaborador_id)
  // SÓ é alcançado quando ESTA flag está ON **E** o slot é product_type='estabelecimento'.
  //   OFF (ausente/false) -> comportamento ATUAL byte-a-byte. Cirilo/Samuel (individual)
  //                          nunca entram no código novo, independentemente da flag.
  //   ON  (true)          -> clones com product_type='estabelecimento' passam a montar
  //                          a agenda por colaborador (resolvedor getGcalsForSlot).
  // O resolvedor em @startap/integrations lê process.env.ESTABELECIMENTO_ENABLED
  // direto (mesmo padrão dos demais gates de flag); esta entrada documenta/valida o
  // formato e expõe a flag tipada pro apps/api. NUNCA hardcoded. GATE OPERACIONAL do
  // ADR 0024 (rotação GCAL_ENCRYPTION_KEY) é pré-requisito do 1º estabelecimento REAL,
  // não desta flag de código.
  ESTABELECIMENTO_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── Pacotes de serviço (ADR 0025 — BLOCO 2a: modelo + consulta read-only) ───
  // Gate macro de pacotes. OPCIONAL no boot (default OFF — lição #247: env nova
  // NUNCA derruba api/worker). Com a flag OFF, o bot NÃO expõe a tool
  // consultar_pacote NEM injeta o bloco [SEU PACOTE]; inserir_agendamento é
  // byte-a-byte o de hoje (a DEDUÇÃO é o bloco 2b, fora deste PR e também gated).
  //   OFF (ausente/false) -> Cirilo/Samuel (e qualquer clone) 100% inalterados.
  //   ON  (true)          -> o bot consulta pacotes (read-only) e injeta o bloco
  //                          [SEU PACOTE] quando o telefone tem pacote ativo.
  // Ligar SÓ após o dono DEFINIR um pacote (CRUD = bloco 2b) e QA controlado.
  // Pré-requisito de USO (não de boot): PACKAGE_PHONE_PEPPER provisionado (validado
  // LAZY — sem ele, pacotes degradam para vazio, sem crash). NUNCA hardcoded.
  PACOTES_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── Billing DERIVADO DA AGENDA — gancho do BOT (ADR 0027, Fase D) ───────────
  // Gate POR-CLONE do GANCHO que faz um agendamento criado PELO BOT (WhatsApp) virar
  // linha de atendimento de PREVISÃO (origem='agenda', status='agendado'). Lista de slots
  // separada por vírgula; o gate é avaliado com isAtendFromAgendaEnabled(slot, ...).
  // OPCIONAL no boot (ausente = OFF, lição #247: feature dormente NUNCA derruba a api do
  // bot). Mesma env no portal-api (apps/portal-api ATEND_FROM_AGENDA_SLOTS) — liga a camada.
  //   vazio/ausente       -> OFF pra TODOS os slots (default seguro = byte-a-byte de hoje;
  //                          o bot cria o evento, deduz pacote e responde sem tocar
  //                          `atendimentos`. Cirilo/Samuel 100% inalterados).
  //   'slot_a,slot_b'      -> ON só nos slots listados (após criar o evento, sob o MESMO
  //                          action-lock idempotente, o bot grava/atualiza a linha de
  //                          previsão best-effort: try/catch, NUNCA quebra o agendamento).
  //   '*'                  -> ON pra TODOS (enable global futuro).
  // KILL-SWITCH: limpar a env volta a OFF pra todos, sem deploy de código.
  // Ligar SÓ no clone de teste (dragon = clone_barber_dragon_caly8b) com QA. NUNCA hardcoded.
  ATEND_FROM_AGENDA_SLOTS: z.string().optional().default(''),

  SERVICE_NAME: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
