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

  // Gate canônico de silêncio financeiro (ADR 0016). O envio humano consulta este
  // mesmo gate para não furar suspensão financeira; ausente preserva OFF.
  BILLING_OVERDUE_SILENCE: z
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

  // Kill-switch do FALLBACK logout+start no reconectar self-service. DEFAULT ON (ausente
  // ou qualquer valor != 'false' = ligado) — o fix funciona por padrão. Quando uma NOWEB
  // está FAILED com auth-state quebrado, o `restart` só reanexa a credencial podre e recai
  // em FAILED (nunca chega a SCAN_QR_CODE → cliente sem QR/código). Com o fallback, se a
  // sessão CONTINUA FAILED após a 1ª janela do restart, escala UMA vez para logout (descarta
  // o auth-state) + start (sobe limpo rumo ao QR). OFF (='false') = comportamento antigo (só
  // restart). Permite desligar sem deploy se algum dia atrapalhar. NUNCA hardcoded.
  PORTAL_RECONEXAO_LOGOUT_FALLBACK: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v !== 'false'),

  // Kill-switch da PAUSA self-service do bot pelo cliente no portal (POST /portal/bot/
  // pause|resume + os campos bot_paused/pause_self/pause_locked no GET /portal/conexao).
  // OPCIONAL no boot (ausente = OFF; feature dormente nunca derruba o portal-api). OFF ->
  // as rotas de ação respondem 404 e o GET omite os campos de pausa (front esconde a UI);
  // produção byte-a-byte como hoje. Liga em piloto sem novo deploy. NUNCA hardcoded.
  PORTAL_BOT_PAUSE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // Timeout (ms) por chamada WAHA do portal-api. Default 8s (ADR 0015 — toda chamada
  // WAHA tem timeout). Opcional; ausente = 8000.
  PORTAL_WAHA_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ── Signup self-service + trial 7 dias (Missão 020 F1; 7d desde 2026-07-14) ─
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

  // Teto GLOBAL de trials simultâneos (security review PR #268, P0 #2): cada trial
  // vivo = 1 sessão WAHA consumindo RAM na VPS sem swap; sem teto, farm de signups
  // derruba TODOS os clientes (fere regra de isolamento nº7). Acima do teto o signup
  // responde 503 trial_lotado. OPCIONAL com default — NUNCA obrigatória no boot.
  TRIAL_MAX_ATIVOS: z.coerce.number().int().positive().default(10),

  // trustProxy do Fastify (security review PR #268, P1 #3): com `true`, o req.ip
  // vinha do X-Forwarded-For MAIS À ESQUERDA (forjável pelo cliente) — bypass de
  // TODO rate-limit por IP. Default 'loopback,uniquelocal' = só honra XFF anexado
  // por hops em faixas privadas (NPM/portal-web nos bridges Docker), e o req.ip
  // vira o primeiro endereço NÃO confiável da cadeia (o IP real do cliente).
  // Valores aceitos: 'true' | 'false' | lista CSV de IPs/CIDRs/presets proxy-addr.
  PORTAL_TRUST_PROXY: z.string().optional(),

  // URL do webhook WAHA do apps/api (mesma TS_WEBHOOK_URL do painel-admin).
  // OPCIONAL no boot; exigida LAZY quando o signup provisiona a sessão WAHA.
  TS_WEBHOOK_URL: z.string().url().optional(),

  // ── Auth do webhook WAHA em sessão NOVA do signup (P0 #268 + spike 2026-06-11) ──
  // Mesmas envs do apps/api e do painel-admin — manter em sincronia. AMBAS
  // OPCIONAIS no boot (lição do incidente #247): ausentes = sessão nasce sem auth
  // (comportamento atual). Presentes = a sessão do trial já nasce com
  // webhooks[].hmac.key (plano A) e/ou customHeaders X-Webhook-Secret (plano B) —
  // sem isso, com o enforcement ligado no apps/api, o trial nasceria surdo (401).
  // NUNCA logadas nem hardcoded.
  WAHA_WEBHOOK_HMAC_KEY: z.string().min(1).optional(),
  WAHA_WEBHOOK_SECRET: z.string().min(1).optional(),

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

  // ── Demo interativa de IA na landing (Missão 023 W6) ───────────────────────
  // Endpoint PÚBLICO e ANÔNIMO (POST /demo/chat). TODAS as envs abaixo são
  // OPCIONAIS no boot (lição #247: feature dormente nunca derruba o portal-api).
  // Com DEMO_ENABLED ausente/false a rota responde 404 (front esconde a demo).
  // Sobe dormente; liga-se em prod sem novo deploy de código, só após QA.
  DEMO_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // Chave do provider DeepSeek (mesma do apps/api). A demo usa DeepSeek
  // (deepseek-chat) por custo (~10x menor que gpt-4o) — tráfego anônimo de volume
  // imprevisível. OPCIONAL no boot; com DEMO_ENABLED=true e esta chave AUSENTE a
  // rota /demo/chat responde 503 (validação LAZY no ponto de uso). NUNCA logada
  // nem hardcoded.
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  // Chave do provider OpenAI (mesma da stack do apps/api). Usada pelo builder conversacional
  // (SCRUM-92): o meta-entrevistador roda no OpenAI (gpt-4o) desde 20/07 — DeepSeek deu tom
  // ruim no teste ao vivo do Bruno. OPCIONAL no boot; validada LAZY no ponto de uso (a rota
  // /portal/prompt-builder/message responde 503 se faltar, sem derrubar o boot). NUNCA logada
  // nem hardcoded. NÃO muda o bot real do cliente (esse segue no bot_config.model do clone).
  OPENAI_API_KEY: z.string().min(1).optional(),
  // Modelo do provider DeepSeek. Default deepseek-chat (design W6). Ajustável sem deploy.
  DEMO_MODEL: z.string().default('deepseek-chat'),
  // Teto de tokens de SAÍDA por turn (custo duro por resposta). Default 180 (W6:
  // resposta curta de WhatsApp).
  DEMO_MAX_TOKENS: z.coerce.number().int().positive().default(180),
  // Temperatura da demo (W6: 0.5 = conversa fluida mas previsível, evita "viajar").
  DEMO_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.5),
  // Timeout (ms) da chamada ao DeepSeek — nunca aguardar infinito (regra 7).
  DEMO_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // ── Caps anti-abuso/custo da demo (todos com default seguro, W6 §guarda) ───
  // Teto de mensagens por sessão de visitante (cookie/sessionId efêmero). Default 15.
  DEMO_MSG_PER_SESSION: z.coerce.number().int().positive().default(15),
  // Rate-limit por IP: N mensagens / janela. Default 20 / 10 min (W6) + burst abaixo.
  DEMO_RATE_PER_IP: z.coerce.number().int().positive().default(20),
  DEMO_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(600),
  // Burst por IP (rajada curta): N / minuto. Default 5 / 60s (W6).
  DEMO_BURST_PER_IP: z.coerce.number().int().positive().default(5),
  DEMO_BURST_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  // HARD CAP GLOBAL diário (nº de chamadas LLM somando TODOS os visitantes).
  // Protege o custo num cenário de bot/scraper. Corta a demo em modo offline
  // (canned + CTA) ao atingir. Default 5.000/dia (W6; Bruno pediu ~5.000). Alerta
  // (warn no log) ao cruzar DEMO_DAILY_ALERT_AT. Ajustável por env sem deploy.
  DEMO_DAILY_CALL_CAP: z.coerce.number().int().positive().default(5_000),
  DEMO_DAILY_ALERT_AT: z.coerce.number().int().positive().default(3_000),
  // Truncagem do texto do visitante antes de enviar ao modelo (input bounded).
  DEMO_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(500),
  // Quantas mensagens de histórico a demo reenvia ao modelo (corta custo de input).
  DEMO_HISTORY_TURNS: z.coerce.number().int().positive().default(8),
  // Salt opaco pro hash de IP no log (LGPD: IP nunca em claro). OPCIONAL; ausente
  // cai num default fixo (hash determinístico ainda anonimiza o suficiente p/ log).
  DEMO_IP_HASH_SALT: z.string().optional(),

  // ── Painel do dono de ESTABELECIMENTO no portal (Fatia 1 — equipe) ──────────
  // Kill-switch da seção Equipe self-service no portal. OPCIONAL no boot (ausente =
  // OFF, lição #247: feature dormente nunca derruba o portal-api). É defesa em
  // PROFUNDIDADE — o gating real é o product_type do clone (READ-only do banco): só
  // estabelecimento alcança as rotas /portal/equipe. Esta flag permite DESLIGAR a
  // feature no portal sem mexer no banco nem no caminho do gestão (que tem a sua
  // própria ESTABELECIMENTO_ENABLED, já ON em prod). OFF -> /portal/equipe responde
  // 404 e /auth/me omite product_type/seat_cap (nav não renderiza o item). Individual
  // (Cirilo/Samuel) é byte-a-byte com a flag em qualquer estado.
  ESTABELECIMENTO_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── Painel do COLABORADOR (barbeiro de estabelecimento) no portal (SCRUM-32) ──
  // Kill-switch do login + visão READ-ONLY escopada do colaborador (rotas /auth/login
  // detectando role + /colaborador/*). OPCIONAL no boot (ausente = OFF, lição #247:
  // feature dormente nunca derruba o portal-api). OFF -> o login NUNCA tenta credencial
  // de colaborador (byte-a-byte como hoje) e as rotas /colaborador/* respondem 404. É
  // defesa em PROFUNDIDADE: o acesso real exige credencial gerada no gestão (só
  // estabelecimento) + colaborador ativo. Sobe dormente; liga em piloto sem novo deploy
  // de código. NUNCA hardcoded.
  COLABORADOR_PORTAL_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // Escrita de agenda pelo colaborador. Separada do painel/read-only porque uma
  // rota mutante fica acessível por chamada direta mesmo antes da UI. Ausente =
  // OFF; a allowlist limita o rollout e '*' exige intenção explícita do operador.
  COLABORADOR_AGENDAMENTOS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  COLABORADOR_AGENDAMENTOS_SLOTS: z.string().optional().default(''),

  // ── Atendimentos / financeiro do negócio do cliente (ADR 0026, Fase 1 MVP) ──
  // Kill-switch da camada de atendimentos (POST /portal/atendimentos + relatórios de
  // faturamento e comissão). OPCIONAL no boot (ausente = OFF, lição #247: feature
  // dormente nunca derruba o portal-api). OFF -> as rotas respondem 404 (não vazam) e
  // NENHUM fluxo existente é tocado; produção byte-a-byte como hoje. Sobe dormente; liga
  // em Dev/QA primeiro, depois prod, sem novo deploy de código. Aplica aos DOIS cenários
  // (individual=SOLO sem comissão / estabelecimento=EMPRESA com comissão). NUNCA hardcoded.
  ATENDIMENTOS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── CRM de clientes finais do negócio (Missão 034, backend) ───────────────
  // Kill-switch GLOBAL das rotas /portal/clientes e /portal/colaborador/clientes.
  // OPCIONAL no boot (ausente = OFF, lição #247): OFF -> 404 antes de tocar DB e o
  // portal segue byte-a-byte como hoje. ON habilita o CRM canônico por tenant+telefone,
  // com owner full-access e colaborador READ-ONLY só dos próprios clientes. NUNCA
  // hardcoded; Bruno pediu default OFF até rollout explícito.
  CRM_CLIENTES_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── CRM Ranking "Sem Retorno" (Missão 035, backend) ───────────────────────
  // Kill-switch das rotas /portal/clientes/sem-retorno e /portal/colaborador/
  // clientes/sem-retorno. OPCIONAL no boot (ausente = OFF, lição #247): OFF -> 404
  // feature_off antes de consulta pesada. Depende do CRM canônico já ligado, mas nasce
  // separado para rollout conservador desta leitura read-only, sem WhatsApp/export.
  RANKING_SEM_RETORNO_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── CRM Aniversariantes read-only (Missão 036, backend) ──────────────────
  // Kill-switch das rotas /portal/clientes/aniversariantes e /portal/colaborador/
  // clientes/aniversariantes. OPCIONAL no boot (ausente = OFF, lição #247):
  // OFF -> 404 feature_off antes de consultar o CRM. Depende do CRM canônico já
  // ligado, mas nasce separado para rollout conservador desta leitura read-only.
  CRM_ANIVERSARIANTES_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── CRM WhatsApp manual (Missão 037, backend) ───────────────────────────
  // Envio humano pontual a UM cliente por requisição. Ausente/OFF fecha a rota
  // antes de consultar CRM, Redis ou WAHA; nunca habilitar junto do CRM por acaso.
  CRM_WHATSAPP_MANUAL_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // O envio inclui typing + humanização de 12s. Este teto cobre essa espera e a
  // chamada externa; é opcional para a feature dormente não quebrar o boot.
  CRM_WHATSAPP_MANUAL_TIMEOUT_MS: z.coerce.number().int().min(20_000).max(60_000).default(20_000),
  // Guarda server-side contra duplo clique. Não vem do cliente e se aplica ao
  // mesmo owner + cliente em todas as instâncias da API.
  CRM_WHATSAPP_MANUAL_COOLDOWN_MS: z.coerce.number().int().min(10_000).max(300_000).default(30_000),
  // Limite por slot em Redis, independente do cliente, para conter fan-out manual.
  // Sem Redis a reserva falha fechada e nenhum envio alcança a WAHA.
  CRM_WHATSAPP_MANUAL_SLOT_MAX_SENDS: z.coerce.number().int().min(1).max(10).default(3),
  CRM_WHATSAPP_MANUAL_SLOT_WINDOW_SECONDS: z.coerce.number().int().min(10).max(300).default(60),

  // ── Billing DERIVADO DA AGENDA (ADR 0027) ──────────────────────────────────
  // Gate POR-CLONE da camada que DERIVA atendimentos dos eventos do GCal (split
  // previsão×faturado, sticky de edição). Lista de slots separada por vírgula; o gate é
  // avaliado com isAtendFromAgendaEnabled(slot, ...). OPCIONAL no boot (ausente = OFF,
  // lição #247: feature dormente nunca derruba o portal-api). O GANCHO de
  // criar-no-agendamento + sync no cancelar/remarcar (Fase B2) é gated por slot.
  //   vazio/ausente   -> OFF pra TODOS (produção byte-a-byte como hoje; nenhuma linha é
  //                      criada/sincronizada/deletada — o helper nem é chamado).
  //   'slot_a,slot_b'  -> ON só nos slots listados.
  //   '*'              -> ON pra TODOS (enable global futuro).
  // KILL-SWITCH: limpar a env volta a OFF pra todos, sem deploy de código.
  // Os endpoints de atendimento (GET por balde / PATCH / DELETE) são ADITIVOS e
  // independem deste gate. Mesma env no apps/api (bot). NUNCA hardcoded.
  ATEND_FROM_AGENDA_SLOTS: z.string().optional().default(''),

  // ── Modo ATENDENTE — gate POR-CLONE (SCRUM-59) ─────────────────────────────
  // Lista de slots (CSV) em que o clone roda no MODO ATENDENTE (bot sem agenda automática).
  // Mesma env do apps/api (bot). No portal, é o que decide se a seção "agenda automática/
  // link" aparece pro cliente: features.modo_atendente do GET /portal/perfil é calculado
  // POR-CLONE com isModoAtendenteEnabled(slot, ...) — assim os clientes atuais NÃO veem a
  // seção nova; só o clone do piloto (e quem o Bruno adicionar depois). OPCIONAL no boot
  // (ausente = OFF, lição #247: feature dormente NUNCA derruba o portal-api).
  //   vazio/ausente   -> OFF pra TODOS (byte-a-byte de hoje).
  //   'slot_a,slot_b'  -> ON só nos slots listados.
  //   '*'              -> ON pra TODOS.
  // KILL-SWITCH: esvaziar a env volta a OFF pra todos, sem deploy. NUNCA hardcoded.
  MODO_ATENDENTE_SLOTS: z.string().optional().default(''),

  // ── Lembrete de agendamento (one-way, configurável por clone — migration 060) ──
  // Kill-switch da camada de CONFIG do lembrete no portal (GET/PATCH /portal/lembretes).
  // OPCIONAL no boot (ausente = OFF, lição #247: feature dormente nunca derruba o
  // portal-api). OFF -> as rotas respondem 404 (não vazam; front esconde a seção) e nenhum
  // fluxo existente é tocado; produção byte-a-byte como hoje. O ENVIO em si vive no worker
  // (gated por REMINDERS_ENABLED lá) — esta flag só controla a UI de config. NUNCA hardcoded.
  REMINDERS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── Entrega da credencial Google do CLIENTE no portal (migration 061) ──────
  // Kill-switch do GET /portal/google-conta, que ENTREGA ao dono o login (e-mail +
  // senha) da conta Google que a empresa criou pra ele logar no app Google Agenda no
  // cel/PC. NÃO é a Service Account do bot (gcal_*). OPCIONAL no boot (ausente = OFF,
  // lição #247: feature dormente nunca derruba o portal-api). OFF -> a rota responde 404
  // (não vaza; nem consulta o banco; o front esconde a seção). A senha é decifrada
  // server-side (decryptSecret) e a resposta vai com cache-control: no-store; a senha
  // NUNCA entra em log. Sobe dormente; liga em prod sem novo deploy de código. NUNCA
  // hardcoded.
  GOOGLE_ACCOUNT_PORTAL_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── Bloqueios de agenda (almoço, ausência, férias, indisponível) ───────────
  // Kill-switch GLOBAL das rotas /portal/agenda/bloqueios e /portal/colaborador/
  // bloqueios. OPCIONAL no boot (ausente = OFF, lição #247): OFF -> 404 antes de
  // qualquer DB/GCal mutante; produção byte-a-byte como hoje. O evento GCal nasce
  // com extendedProperties.private.kind='bloqueio' para o reconciler financeiro
  // ignorar e nunca virar atendimento.
  AGENDA_BLOQUEIOS_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Allowlist por slot para canário seguro. Só tem efeito quando
  // AGENDA_BLOQUEIOS_ENABLED=true. Default vazio = OFF para todos; '*' libera geral
  // explicitamente para rollout amplo.
  AGENDA_BLOQUEIOS_SLOTS: z.string().optional().default(''),

  // ── Builder conversacional de persona (SCRUM-92, ADR 0032) ─────────────────
  // Kill-switch das rotas /portal/prompt-builder/*. OPCIONAL no boot (ausente = OFF,
  // lição #247: feature dormente nunca derruba o portal-api). OFF -> as rotas respondem
  // 404 (front esconde a seção "Monte seu atendente"). Decisão do Bruno: subir ON pra
  // TODOS -> o PM seta PROMPT_BUILDER_ENABLED=true no deploy (a flag é o kill-switch, não
  // um rollout dormente). Provisionar OPENAI_API_KEY antes de ligar (validado LAZY: rota
  // responde 503 se faltar, sem derrubar o boot). NUNCA hardcoded.
  PROMPT_BUILDER_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── Modo MELHORIA do builder — conversa livre sobre persona que JÁ EXISTE (SCRUM-153) ──
  // OFF (default e estado de deploy): TODA sessão do builder roda a V4 (entrevista, criação do
  // zero) — comportamento atual de produção, byte-a-byte, para todos os clones.
  // ON: clone com persona própria (prompt_custom=true E bot_prompt não-vazio) passa a abrir o
  // builder em CONVERSA LIVRE de melhoria (system prompt V5), com a persona atual + os RÓTULOS
  // dos campos já configurados injetados no contexto; o padrão passa a ser PRESERVAR o texto
  // existente (guarda determinística de encolhimento) e reescrever só sob pedido explícito.
  // Clone SEM persona própria continua na V4 mesmo com a flag ON — a flag não toca a criação.
  // OPCIONAL no boot (env nova NUNCA derruba o serviço — lição #247). NUNCA hardcoded.
  PROMPT_BUILDER_MELHORIA_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // O meta-agente entrevistador roda SEMPRE no OpenAI (gpt-4o) — NÃO herda o bot_config do
  // clone (é meta-agente, não o bot do cliente) e NÃO muda o bot real do cliente. Desde 20/07
  // usa OPENAI_API_KEY (endpoint default OpenAI, sem baseURL); o DeepSeek foi trocado por dar
  // tom ruim no teste ao vivo do Bruno. Modelo ajustável sem deploy; default = decisão 20/07.
  PROMPT_BUILDER_MODEL: z.string().default('gpt-4o'),
  // Temperature baixa (0.4): tom profissional consistente + aderência às regras duras +
  // tool-calling confiável (propor_prompt), sem virar robótico. Ajustável sem deploy.
  PROMPT_BUILDER_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.4),
  // Timeout (ms) por chamada ao OpenAI — nunca aguardar infinito (regra 7).
  PROMPT_BUILDER_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // maxTurns do runAgent por mensagem (1 tool-call + 1 mensagem final = 2; folga p/ 3).
  PROMPT_BUILDER_MAX_AGENT_TURNS: z.coerce.number().int().positive().default(3),

  // ── Caps anti-abuso/custo (todos com default seguro) ───────────────────────
  // Teto de turns (mensagens do dono) por ENTREVISTA — corta loop de refino infinito.
  PROMPT_BUILDER_MAX_TURNS: z.coerce.number().int().positive().default(30),
  // Teto de mensagens/dia por TENANT (slot).
  PROMPT_BUILDER_MAX_MSGS_DAY: z.coerce.number().int().positive().default(60),
  // Hard cap GLOBAL diário de chamadas ao LLM (kill-switch de custo, somando tenants).
  PROMPT_BUILDER_DAILY_CALL_CAP: z.coerce.number().int().positive().default(2_000),
  // Truncagem do texto do dono por mensagem (input bounded = custo bounded).
  PROMPT_BUILDER_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(4_000),
  // Quantos turns de histórico reenviamos ao modelo (corta custo de input crescente).
  PROMPT_BUILDER_HISTORY_TURNS: z.coerce.number().int().positive().default(24),
  // TTL (segundos) do estado da entrevista no Redis (sliding). Default 2h (janela de onboarding).
  PROMPT_BUILDER_STATE_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 60 * 60),

  // ── Validação cruzada serviço↔persona (ADR 0035) ────────────────────────────────
  // Kill-switch REAL (não canário log-only — decisão do Bruno 01/08): OFF (default, sobe assim)
  // = comportamento antigo byte-a-byte no PUT /portal/servicos (sem chamada de LLM, sem 409/503
  // novo) e no builder (validatePersona roda sem allowlist de plano, cortando toda linha `moeda`
  // como sempre cortou). Ligar exige GO explícito do Bruno DAQUELE flag, depois da prova dos 9
  // casos do ADR §D4 contra o modelo real. OPCIONAL no boot (lição #247). NUNCA hardcoded.
  SERVICO_VALIDACAO_CRUZADA_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // ⚠️ Env PRÓPRIA — NÃO reusar PROMPT_BUILDER_MODEL (ADR §D5): builder é conversa criativa
  // (temperature alta), este é classificador binário determinístico (temperature=0). Acoplar as
  // envs faz uma troca de modelo do builder mexer numa trava de save sem ninguém perceber.
  // ⚠️ gpt-5 puro REJEITA temperature e quebraria a chamada — usar a linha .1.
  // ⚠️ `gpt-5.1-mini` NÃO EXISTE nesta conta (404, medido 04/08 em `GET /v1/models`): a conta tem
  // `gpt-5-mini` e `gpt-5.1`, nunca a combinação. O default anterior apontava pra esse id e faria
  // TODO save com indício de moeda na persona cair em 503 assim que a flag fosse ligada — bug que
  // CI, tsc e 3485 testes não pegam porque a suíte MOCKA o LLM. Default = o mesmo modelo que o
  // builder já roda em prod (`PROMPT_BUILDER_MODEL=gpt-5.1`), único id .1 provado nesta conta.
  SERVICO_VALIDATOR_MODEL: z.string().default('gpt-5.1'),
  SERVICO_VALIDATOR_TEMPERATURE: z.coerce.number().min(0).max(2).default(0),
  // Timeout curto (regra 7) — bem abaixo do builder (20s): aqui o dono espera um botão, não uma
  // conversa. Total pior caso com 1 retry ≈ 2x este valor antes do 503.
  SERVICO_VALIDATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),

  // ── Cartão de confirmação em RUNTIME — kill-switch GLOBAL (SCRUM-92 inc.2 / ADR 0032) ──
  // MESMA flag do apps/api. ATIVA em produção desde 23/07/2026 (ADR 0033). No portal-api ela
  // gate 2 caminhos: (1) o approve do builder nasce em runtime (persona SEM cartão baked +
  // cartao_mode='runtime') quando ON — mas um clone JÁ em cartao_mode='runtime' é honrado mesmo
  // com a flag OFF (PR #480, anti-cartão-duplo); (2) o endpoint /portal/cartao-config responde 404
  // quando OFF. ⚠️ LOAD-BEARING, não kill-switch: ver a nota completa em apps/api/src/config.schema
  // e no ADR 0033. OPCIONAL no boot (env nova NUNCA derruba o serviço — lição #247). NUNCA hardcoded.
  CARTAO_RUNTIME_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),

  // ── "Testar conversa" — SANDBOX da persona real do clone (SCRUM-101) ──────────
  // Endpoint AUTENTICADO (withTenant — slot SÓ da sessão) em que o DONO conversa com o
  // PRÓPRIO assistente rodando a persona+tom+cartão REAIS do clone, mas em SANDBOX: SEM
  // NENHUMA tool registrada (tools:[]) — zero escrita em GCal/DB/billing/pausa, nenhuma
  // mensagem sai por WAHA. É read-only por construção (as write-tools nem existem neste
  // caminho). Custo de LLM controlado (teto de turns/dia + cap global). TODAS as envs abaixo
  // são OPCIONAIS no boot (lição #247: feature dormente nunca derruba o portal-api). Com
  // SANDBOX_ENABLED ausente/false as rotas /portal/sandbox/* respondem 404 (front esconde).
  // Sobe dormente; liga em prod sem novo deploy de código, só após QA.
  SANDBOX_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Timeout (ms) da chamada ao modelo — nunca aguardar infinito (regra 7).
  SANDBOX_LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  // Teto de turns do DONO por sessão de teste (corta loop caro; UI manda recomeçar).
  SANDBOX_MAX_TURNS: z.coerce.number().int().positive().default(30),
  // Quantas mensagens de histórico o sandbox reenvia ao modelo (corta custo de input).
  SANDBOX_HISTORY_TURNS: z.coerce.number().int().positive().default(12),
  // Truncagem do texto do dono antes de enviar ao modelo (input bounded).
  SANDBOX_MAX_INPUT_CHARS: z.coerce.number().int().positive().default(1_000),
  // Teto de mensagens/dia por TENANT (slot) — corta um tenant que exagera sem afetar outros.
  SANDBOX_MAX_MSGS_DAY: z.coerce.number().int().positive().default(200),
  // HARD CAP GLOBAL diário (nº de chamadas LLM somando TODOS os tenants) — kill-switch de custo.
  SANDBOX_DAILY_CALL_CAP: z.coerce.number().int().positive().default(3_000),

  SERVICE_NAME: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
