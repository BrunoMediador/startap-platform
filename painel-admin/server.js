import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import multer from 'multer';
import fetch from 'node-fetch';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PG_HOST = 'postgres',
  PG_PORT = '5432',
  PG_USER = 'startap_user',
  PG_PASS,
  PG_DB = 'startap_database',
  WAHA_URL = 'http://waha:3000',
  WAHA_API_KEY = '',
  ADMIN_USER = 'admin',
  ADMIN_PASS,
  PORT = '3030',
  MEDIA_STORAGE_DIR = path.join(__dirname, 'uploads'),
  MEDIA_PUBLIC_BASE_URL = '/uploads',
  MEDIA_UPLOAD_MAX_MB = '250',
  SESSION_SECRET,
} = process.env;

// PG_PASS não tem default — expor senha no código é proibido (Regra 3 CLAUDE.md).
// Se ausente em produção, o pool falhará na primeira query com erro claro no stderr.
if (!PG_PASS) {
  throw new Error('boot: PG_PASS não definida — configure a variável de ambiente antes de iniciar');
}

// ADMIN_PASS sem default — fallback 'admin' permitia acesso público (Missão 012-A3).
if (!ADMIN_PASS) {
  console.error('[boot] ADMIN_PASS nao definida — defina no .env antes de subir o painel.');
  process.exit(1);
}
if (ADMIN_PASS === 'admin' || ADMIN_PASS.length < 8) {
  console.error('[boot] ADMIN_PASS fraca demais (default "admin" ou < 8 chars). Use senha forte.');
  process.exit(1);
}

if (!process.env.GCAL_ENCRYPTION_KEY) {
  throw new Error(
    'boot: GCAL_ENCRYPTION_KEY não definida — gere com: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  );
}

// ── Criptografia AES-256-GCM para gcal_credentials_json ──────────────────────
// Espelha packages/core/src/crypto.ts (painel é JS sem build-time dep do core).
// Chave: GCAL_ENCRYPTION_KEY — 32 bytes hex. Obrigatória; ausência para o boot.
const _GCAL_ENC_PREFIX = 'enc:v1:';

function _getGcalKey() {
  const hex = process.env.GCAL_ENCRYPTION_KEY;
  if (!hex || hex.trim() === '') {
    throw new Error(
      'boot: GCAL_ENCRYPTION_KEY ausente — defina 32 bytes hex no .env antes de iniciar',
    );
  }
  const buf = Buffer.from(hex.trim(), 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `boot: GCAL_ENCRYPTION_KEY deve ter 32 bytes (64 chars hex); recebido ${buf.length} bytes`,
    );
  }
  return buf;
}

function encryptGcalCredentials(plain) {
  const key = _getGcalKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return (
    _GCAL_ENC_PREFIX +
    iv.toString('base64') +
    ':' +
    authTag.toString('base64') +
    ':' +
    encrypted.toString('base64')
  );
}

function decryptGcalCredentials(stored) {
  if (!stored.startsWith(_GCAL_ENC_PREFIX)) {
    // Dado legado em texto claro — aceitar durante janela de migração.
    return stored;
  }
  const rest = stored.slice(_GCAL_ENC_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('gcal: formato enc:v1 inválido — esperado 3 partes após prefixo');
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const key = _getGcalKey();
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(authTagB64, 'base64');
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('gcal: falha na descriptografia — authTag inválido ou dado corrompido');
  }
}
// ─────────────────────────────────────────────────────────────────────────────
const TS_API_URL = process.env.TS_API_URL || 'http://startap-api:3040';
const TS_WEBHOOK_URL = process.env.TS_WEBHOOK_URL || `${TS_API_URL}/webhooks/waha`;

// Bots da plataforma TypeScript.
const TS_BOTS = [
  {
    id: '0ni38aSspWwhooHd',
    name: 'teste_barbearia',
    active: true,
    webhook_url: TS_WEBHOOK_URL,
    source: 'ts',
    routable: true,
    category: 'teste',
    tags: ['barbearia', 'agenda'],
    description: 'Teste de atendimento para barbearia com consulta de agenda e Google Calendar.',
  },
  {
    id: 'dlpKXM3gvX2joC1b',
    name: 'teste_vendas',
    active: true,
    webhook_url: TS_WEBHOOK_URL,
    source: 'ts',
    routable: true,
    category: 'teste',
    tags: ['vendas', 'curso'],
    description: 'Teste de vendas do curso de barbeiro com captura de lead e midias.',
  },
  {
    id: 'teste_vendas_barbearia',
    name: 'teste_vendas_barbearia',
    active: true,
    webhook_url: TS_WEBHOOK_URL,
    source: 'ts',
    routable: true,
    category: 'teste',
    tags: ['vendas', 'barbearia', 'proposta-mista'],
    description:
      'Projeto apartado de teste com proposta mista: vende curso e agenda servicos de barbearia.',
  },
  {
    id: 'uUS3Ux1cU2DquKxo',
    name: 'startap',
    active: true,
    webhook_url: TS_WEBHOOK_URL,
    source: 'ts',
    routable: false,
    category: 'interno',
    tags: ['startap', 'prospeccao', 'interno'],
    description: 'Fluxo interno da Startap. Nao aparece no roteamento de testes.',
  },
];

const BOT_MODEL_CONTEXT = {
  'barbearia-cirilo': {
    flow_id: '0ni38aSspWwhooHd',
    flow_name: 'TESTE_BARBEARIAS_AGENDAMENTOS',
    flow_label: 'Barbearia Cirilo',
    ai_role: 'Atendente de agendamento',
    runtime: 'BarbeariaCiriloBot',
    description: 'Conversa com clientes, consulta horários e cria agendamentos no Google Calendar.',
  },
  'elenildo-ricardo': {
    flow_id: 'dlpKXM3gvX2joC1b',
    flow_name: 'elenildo.ricardo',
    flow_label: 'Curso de Barbeiro Ricardo',
    ai_role: 'Vendedor do curso',
    runtime: 'RicardoBot',
    description: 'Qualifica interessados, responde objeções, envia materiais e salva leads.',
  },
  'startap-ai-lola': {
    flow_id: 'uUS3Ux1cU2DquKxo',
    flow_name: 'STARTAP_AI',
    flow_label: 'Startap AI',
    ai_role: 'Lola - prospecção comercial',
    runtime: 'StartapAiBot.processLola',
    description: 'Atende prospects da Startap e pausa quando há intervenção humana.',
  },
  'startap-ai-samuel': {
    flow_id: 'uUS3Ux1cU2DquKxo',
    flow_name: 'STARTAP_AI',
    flow_label: 'Startap AI',
    ai_role: 'Samuel - admin de pausas',
    runtime: 'StartapAiBot.processSamuel',
    description: 'Atende o número administrativo e gerencia consultas/remoções da pausa Samuel.',
  },
  teste_vendas_barbearia: {
    flow_id: 'teste_vendas_barbearia',
    flow_name: 'teste_vendas_barbearia',
    flow_label: 'Teste — Vendas + Barbearia',
    ai_role: 'Atendente hibrido de vendas e agenda',
    runtime: 'TesteVendasBarbeariaBot',
    description:
      'Projeto de teste apartado com proposta mista: vende curso e agenda servicos de barbearia.',
  },
};

// Mapeamento flow_id → tabela de leads (slots sem leads_table omitidos intencionalmente).
// Usado em GET /api/bots para popular leads_count sem hardcode inline.
const FLOW_LEADS_TABLE = {
  dlpKXM3gvX2joC1b: 'leads_ricardo',
  teste_vendas_barbearia: 'leads_vendas_barbearia',
};

const DEFAULT_PROJECT_DATABASES = [
  {
    project_id: 'teste_barbearia',
    display_name: 'Teste - Barbearia',
    workflow_id: '0ni38aSspWwhooHd',
    slot: 'teste_barbearia',
    source: 'ts',
    memory_table: 'chat_histories',
    status: 'active',
    metadata: {
      category: 'teste',
      tables: [
        'chat_memory',
        'routing',
        'flow_pauses',
        'flow_pause_keywords',
        'bot_prompt',
        'model_usage',
        'flow_logs',
        'agendamento_pendente',
      ],
    },
  },
  {
    project_id: 'teste_vendas',
    display_name: 'Teste - Vendas Curso',
    workflow_id: 'dlpKXM3gvX2joC1b',
    slot: 'teste_vendas',
    source: 'ts',
    memory_table: 'chat_histories_ricardo',
    status: 'active',
    metadata: {
      category: 'teste',
      tables: [
        'chat_memory',
        'routing',
        'flow_pauses',
        'flow_pause_keywords',
        'bot_prompt',
        'bot_media',
        'model_usage',
        'flow_logs',
        'leads_ricardo',
      ],
    },
  },
  {
    project_id: 'teste_vendas_barbearia',
    display_name: 'Teste - Vendas + Barbearia',
    workflow_id: 'teste_vendas_barbearia',
    slot: 'teste_vendas_barbearia',
    source: 'ts',
    memory_table: 'chat_histories_vendas_barbearia',
    status: 'active',
    metadata: {
      category: 'teste',
      tables: [
        'chat_memory',
        'routing',
        'flow_pauses',
        'flow_pause_keywords',
        'bot_prompt',
        'bot_media',
        'model_usage',
        'flow_logs',
        'leads_vendas_barbearia',
      ],
    },
  },
  {
    project_id: 'startap',
    display_name: 'Startap - Prospeccao',
    workflow_id: 'uUS3Ux1cU2DquKxo',
    slot: 'startap',
    source: 'ts',
    memory_table: 'chat_histories_startap',
    status: 'active',
    metadata: {
      category: 'interno',
      tables: [
        'chat_memory',
        'flow_pauses',
        'flow_pause_keywords',
        'bot_prompt',
        'model_usage',
        'flow_logs',
        'pause_startap',
      ],
    },
  },
];

// Mapeia o slot do bot para o flow_id usado em flow_pause_keywords / flow_pauses.
// Matrizes têm flow_id legado (n8n) registrado em DEFAULT_PROJECT_DATABASES;
// clones usam o próprio slot como flow_id.
function resolveSlotToFlowId(slot) {
  const entry = DEFAULT_PROJECT_DATABASES.find((p) => p.slot === slot);
  return entry?.workflow_id || slot;
}

const DATABASE_TABLES = {
  chat_memory: { label: 'Historico de conversa', type: 'memoria' },
  routing: { label: 'Roteamento', type: 'operacao' },
  flow_pauses: { label: 'Pausas por fluxo', type: 'operacao' },
  flow_pause_keywords: { label: 'Palavras-chave de pausa', type: 'config' },
  bot_prompt: { label: 'Prompt', type: 'config' },
  bot_media: { label: 'Midias', type: 'config' },
  model_usage: { label: 'Uso de modelo', type: 'metricas' },
  flow_logs: { label: 'Logs de fluxo', type: 'operacao' },
  agendamento_pendente: { label: 'Agendamentos pendentes', type: 'negocio' },
  leads_ricardo: { label: 'Leads Ricardo', type: 'negocio' },
  leads_vendas_barbearia: { label: 'Leads Vendas + Barbearia', type: 'negocio' },
  pause_startap: { label: 'Pausa Startap', type: 'operacao' },
};

const pool = new pg.Pool({
  host: PG_HOST,
  port: Number(PG_PORT),
  user: PG_USER,
  password: PG_PASS,
  database: PG_DB,
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 3000),
});

const app = express();

// ── Trust proxy ───────────────────────────────────────────────────────────────
// O painel está atrás do Nginx Proxy Manager. Sem trust proxy o express-rate-limit
// lança "ValidationError: The 'X-Forwarded-For' header is set but the Express
// 'trust proxy' setting is false" a cada requisição, e req.ip sempre devolve
// o IP interno do proxy em vez do IP real do operador.
// Valor 1 = confiar exatamente 1 nível de proxy (NPM) — nunca colocar true em prod.
app.set('trust proxy', 1);

app.use(express.json());

// ── Access log estruturado (Morgan) ──────────────────────────────────────────
// Registra todas as requisições HTTP do painel para auditoria do operador.
// Formato custom: ISO timestamp + método + path + status + duração + IP real.
// IP real só fica correto após trust proxy acima.
morgan.token('iso', () => new Date().toISOString());
app.use(morgan(':iso :method :url :status :response-time ms - :remote-addr'));
// ─────────────────────────────────────────────────────────────────────────────

// Wrapper para repassar erros assincronos ao error handler global do Express.
// Express 4 nao captura promises rejeitadas em async handlers; isso fazia
// endpoints sem try/catch derrubarem o processo. Use asyncHandler(async (req,res) => ...).
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// ── Rate limiters ─────────────────────────────────────────────────────────────
// authLimiter: protege a camada de Basic-Auth contra brute-force.
// Conta apenas requisições que resultaram em 401 (skipSuccessfulRequests: true).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // janela de 15 minutos
  max: 5,                      // 5 tentativas com falha por IP nessa janela
  skipSuccessfulRequests: true,
  message: 'Muitas tentativas. Aguarde 15 minutos.',
  standardHeaders: true,
  legacyHeaders: false,
});

// apiLimiter: limite geral de throughput em todas as rotas /api/*
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,    // janela de 1 minuto
  max: 100,                    // 100 requisições por IP por minuto
  message: 'Rate limit excedido.',
  standardHeaders: true,
  legacyHeaders: false,
});
// ─────────────────────────────────────────────────────────────────────────────

// ── CSRF — double-submit cookie pattern ──────────────────────────────────────
// Sem dependência externa. Geração por crypto.randomBytes + validação manual.
// O cookie csrf_token NÃO é HttpOnly para que o JS do frontend possa lê-lo.
// SameSite=Strict + Secure: protege contra envio cross-site em produção.
const CSRF_COOKIE = 'csrf_token';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function setCsrfToken(req, res, next) {
  if (!req.cookies?.[CSRF_COOKIE]) {
    const token = crypto.randomBytes(24).toString('hex');
    res.cookie(CSRF_COOKIE, token, {
      httpOnly: false,       // precisa ser lido pelo JS para injetar no header
      sameSite: 'strict',
      secure: IS_PRODUCTION, // HTTPS em prod; desligado em dev local
    });
    // Expõe o token na resposta para que o HTML inicial possa embutir na meta tag
    res.locals.csrfToken = token;
  } else {
    res.locals.csrfToken = req.cookies[CSRF_COOKIE];
  }
  next();
}

function csrfProtection(req, res, next) {
  // Métodos idempotentes: sem verificação
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get('X-CSRF-Token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF token inválido' });
  }
  next();
}
// ─────────────────────────────────────────────────────────────────────────────

fs.mkdirSync(MEDIA_STORAGE_DIR, { recursive: true });

const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, MEDIA_STORAGE_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = /^[a-z0-9.]{1,12}$/.test(ext) ? ext : '';
      cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
    },
  }),
  limits: { fileSize: Number(MEDIA_UPLOAD_MAX_MB) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mimetype = String(file.mimetype || '').toLowerCase();
    const ext = path.extname(file.originalname || '').toLowerCase();
    const allowedExt = new Set([
      '.mp4',
      '.mov',
      '.m4v',
      '.webm',
      '.mpeg',
      '.mpg',
      '.avi',
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.gif',
      '.pdf',
      '.doc',
      '.docx',
      '.txt',
      '.odt',
      '.mp3',
      '.ogg',
      '.opus',
      '.aac',
      '.wav',
    ]);
    if (
      mimetype.startsWith('video/') ||
      mimetype.startsWith('image/') ||
      mimetype.startsWith('audio/') ||
      mimetype === 'application/pdf' ||
      mimetype === 'application/msword' ||
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mimetype === 'text/plain' ||
      allowedExt.has(ext)
    ) {
      cb(null, true);
      return;
    }
    cb(new Error('tipo de arquivo nao permitido'));
  },
});

// Parseia cookies para uso nos middlewares CSRF, session e outros
app.use(cookieParser());

// ── Session middleware ────────────────────────────────────────────────────────
// Store em memória (MemoryStore padrão do express-session) — OK para single-container.
// Se SESSION_SECRET não estiver definida, gera um segredo aleatório por processo
// (logout automático em restart — aceitável, avisar Bruno no deploy note).
const _sessionSecret = SESSION_SECRET || crypto.randomBytes(48).toString('hex');
if (!SESSION_SECRET) {
  // eslint-disable-next-line no-console
  console.warn(
    '[boot] SESSION_SECRET nao definida — usando segredo efemero. ' +
    'Sessoes sao invalidadas a cada restart. Defina SESSION_SECRET no .env.',
  );
}
app.use(
  session({
    secret: _sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'startap.sid',
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: IS_PRODUCTION,
      maxAge: 24 * 60 * 60 * 1000, // 24 horas
    },
  }),
);
// ─────────────────────────────────────────────────────────────────────────────

// Injeta (ou renova) o cookie CSRF em toda resposta — deve vir antes do authLimiter
// para que até respostas 401 já incluam o token (front precisa dele para o próximo POST)
app.use(setCsrfToken);

// ── POST /api/login — autenticação session-based ──────────────────────────────
// Rota pública (antes do requireAuth). authLimiter protege contra brute-force.
// CSRF não é exigido aqui: usuário ainda não tem cookie de sessão válido.
app.post('/api/login', authLimiter, express.json(), (req, res) => {
  const { username, password } = req.body ?? {};
  if (
    typeof username === 'string' &&
    typeof password === 'string' &&
    username === ADMIN_USER &&
    password === ADMIN_PASS
  ) {
    // Regenera session ID após login bem-sucedido (session fixation protection).
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: 'falha ao criar sessao' });
      req.session.userId = 'admin';
      req.session.loggedAt = Date.now();
      res.json({ ok: true });
    });
  } else {
    res.status(401).json({ error: 'credenciais invalidas' });
  }
});

// ── POST /api/logout — encerra sessao ────────────────────────────────────────
// CSRF exigido (usuário autenticado fazendo ação mutativa).
app.post('/api/logout', csrfProtection, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      // Mesmo com erro, limpa o cookie e retorna ok — usuário sai de qualquer forma.
      // eslint-disable-next-line no-console
      console.warn('[logout] session.destroy error:', err.message);
    }
    res.clearCookie('startap.sid');
    res.json({ ok: true });
  });
});

// ── requireAuth — middleware de autenticação session-based ───────────────────
// Substitui o antigo Basic Auth.
// - Rotas excluídas: /api/login, /api/logout, /login.html, /uploads/*, /media-proxy
// - Requisições HTML não autenticadas → redirect /login.html
// - Requisições API não autenticadas → 401 JSON
function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  const acceptsHtml = (req.get('Accept') || '').includes('text/html');
  if (acceptsHtml) return res.redirect('/login.html');
  return res.status(401).json({ error: 'nao autenticado' });
}

// Aplica requireAuth em todas as rotas exceto as públicas declaradas acima e estáticos
app.use((req, res, next) => {
  const publicPaths = ['/api/login', '/api/logout', '/login.html'];
  // Permite também assets sem extensão de rota (ex: /favicon.ico via static)
  // e o endpoint de proxy de mídia (acessado pelo browser sem autenticação no fluxo normal).
  // O requireAuth protege todas as outras rotas.
  if (publicPaths.includes(req.path)) return next();
  return requireAuth(req, res, next);
});

// Limiter geral de throughput em /api/* — após auth para não penalizar tentativas 401
app.use('/api', apiLimiter);

// CSRF protection em todas as rotas mutativas /api/* (exceto /api/login — pré-sessão)
app.use('/api', (req, res, next) => {
  if (req.path === '/login') return next(); // já tratado sem CSRF acima
  return csrfProtection(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  },
}));
app.use('/uploads', express.static(MEDIA_STORAGE_DIR));

// Proxy HTTPS-friendly para midias HTTP internas (resolve mixed-content).
// O painel roda em HTTPS; mídias servidas via HTTP dentro dos containers seriam bloqueadas
// pelo browser por política de mixed-content. Esta rota faz o proxy server-side.
const ALLOWED_PROXY_HOSTS = ['187.77.242.220', 'localhost', '127.0.0.1', 'nginx-videos'];
app.get('/media-proxy', async (req, res) => {
  try {
    const target = String(req.query.u || '');
    if (!target) return res.status(400).send('missing u');
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      return res.status(400).send('invalid url');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).send('Unsupported protocol');
    }
    if (!ALLOWED_PROXY_HOSTS.includes(parsed.hostname)) {
      return res.status(403).send('host nao permitido');
    }
    const upstream = await fetch(target, {
      headers: req.headers.range ? { Range: req.headers.range } : {},
    });
    res.status(upstream.status);
    const passHeaders = [
      'content-type',
      'content-length',
      'accept-ranges',
      'content-range',
      'cache-control',
    ];
    for (const h of passHeaders) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();
    upstream.body.pipe(res);
    upstream.body.on('error', () => res.end());
  } catch (e) {
    res.status(502).send(`proxy error: ${e.message}`);
  }
});

app.post('/api/uploads/media', mediaUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'arquivo obrigatorio' });
    const base = String(MEDIA_PUBLIC_BASE_URL || '/uploads').replace(/\/$/, '');
    const url = `${base}/${encodeURIComponent(req.file.filename)}`;
    // file_id = nome do arquivo salvo em disco (usado pelo POST /api/bots/:slot/media)
    res.json({
      ok: true,
      file_id: req.file.filename,
      filename: req.file.filename,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
      url,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const wahaFetch = (p) =>
  fetch(`${WAHA_URL}${p}`, {
    headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
  }).then((r) => r.json());

// ---------- ROUTING CRUD ----------
app.get('/api/routing', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, telefone, nome_cliente, workflow_id, workflow_name, webhook_url,
             ativo, criado_em, atualizado_em
      FROM routing_clientes ORDER BY workflow_name, telefone
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/routing', async (req, res) => {
  try {
    const { telefone, workflow_id, nome_cliente, ativo = true, move = false } = req.body;
    if (!telefone || !workflow_id)
      return res.status(400).json({ error: 'telefone e workflow_id obrigatorios' });
    const tel = String(telefone).replace(/\D/g, '');
    if (tel.length < 10) return res.status(400).json({ error: 'telefone invalido' });

    const wf = await resolveWorkflow(workflow_id);
    if (!wf) return res.status(400).json({ error: 'workflow nao encontrado' });
    if (!wf.webhook_url) return res.status(400).json({ error: 'workflow sem webhook publico' });

    const existing = await pool.query(
      'SELECT id, workflow_name FROM routing_clientes WHERE telefone = $1',
      [tel],
    );
    if (existing.rows.length && !move) {
      return res.status(409).json({
        error: 'duplicate',
        message: `Telefone ja vinculado ao fluxo "${existing.rows[0].workflow_name}"`,
        existing_id: existing.rows[0].id,
        existing_workflow: existing.rows[0].workflow_name,
      });
    }

    await pool.query(
      `INSERT INTO routing_clientes (telefone, workflow_id, workflow_name, webhook_url, nome_cliente, ativo, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,NOW())
       ON CONFLICT (telefone) DO UPDATE SET
         workflow_id=EXCLUDED.workflow_id,
         workflow_name=EXCLUDED.workflow_name,
         webhook_url=EXCLUDED.webhook_url,
         nome_cliente=COALESCE(EXCLUDED.nome_cliente, routing_clientes.nome_cliente),
         ativo=EXCLUDED.ativo,
         atualizado_em=NOW()`,
      [tel, wf.id, wf.name, wf.webhook_url, nome_cliente || null, ativo],
    );
    res.json({ ok: true, moved: existing.rows.length > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/routing/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // PATCH semantics: lê o registro atual, faz merge com os campos enviados.
    // Permite toggles parciais (ex: só `ativo`, só `workflow_id`) sem precisar
    // mandar o objeto inteiro do front.
    const cur = await pool.query(
      `SELECT telefone, workflow_id, workflow_name, webhook_url, nome_cliente, ativo
       FROM routing_clientes WHERE id = $1`,
      [id],
    );
    if (cur.rowCount === 0) return res.status(404).json({ error: 'rota nao encontrada' });
    const row = cur.rows[0];

    const telefoneRaw =
      req.body.telefone !== undefined ? String(req.body.telefone).replace(/\D/g, '') : row.telefone;
    const wfIdNovo = req.body.workflow_id !== undefined ? req.body.workflow_id : row.workflow_id;

    let wfId = row.workflow_id;
    let wfName = row.workflow_name;
    let webhookUrl = row.webhook_url;
    if (wfIdNovo !== row.workflow_id) {
      const wf = await resolveWorkflow(wfIdNovo);
      if (!wf) return res.status(400).json({ error: 'workflow nao encontrado' });
      wfId = wf.id;
      wfName = wf.name;
      webhookUrl = wf.webhook_url;
    }

    const nomeCliente =
      req.body.nome_cliente !== undefined ? req.body.nome_cliente || null : row.nome_cliente;
    const ativo = req.body.ativo !== undefined ? !!req.body.ativo : row.ativo;

    await pool.query(
      `UPDATE routing_clientes SET
         telefone=$1, workflow_id=$2, workflow_name=$3, webhook_url=$4,
         nome_cliente=$5, ativo=$6, atualizado_em=NOW()
       WHERE id=$7`,
      [telefoneRaw, wfId, wfName, webhookUrl, nomeCliente, ativo, id],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/routing/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM routing_clientes WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- BOT CONFIG (modelos por slot) ----------
app.get(
  '/api/bots',
  asyncHandler(async (_req, res) => {
    const r = await pool.query(`
    SELECT slot, display_name, provider, model, temperature::float AS temperature, updated_at, waha_sessao
    FROM bot_config ORDER BY slot
  `);

    const slots = r.rows.map((row) => row.slot);

    // Agrega KPIs em parallel: messages_today via model_usage (indexed), leads_count via leads_*
    // model_usage é o proxy correto para mensagens processadas hoje — chat_histories não tem created_at.
    const [msgRows, leadsRicardoRows, leadsVendasBarbeariaRows] = await Promise.all([
      pool
        .query(
          `SELECT slot, COUNT(*)::int AS cnt
           FROM model_usage
           WHERE slot = ANY($1)
             AND created_at AT TIME ZONE 'America/Sao_Paulo' >= CURRENT_DATE AT TIME ZONE 'America/Sao_Paulo'
           GROUP BY slot`,
          [slots],
        )
        .catch(() => ({ rows: [] })),
      pool
        .query(`SELECT slot, COUNT(*)::int AS cnt FROM leads_ricardo GROUP BY slot`)
        .catch(() => ({ rows: [] })),
      pool
        .query(`SELECT slot, COUNT(*)::int AS cnt FROM leads_vendas_barbearia GROUP BY slot`)
        .catch(() => ({ rows: [] })),
    ]);

    // Mapeia slot → messages_today
    const msgBySlot = Object.fromEntries(msgRows.rows.map((row) => [row.slot, row.cnt]));

    // Consolida contagens de leads por flow_id (cada tabela usa slot do bot_config como valor da coluna slot)
    const leadsByLeadsTable = {
      leads_ricardo: Object.fromEntries(leadsRicardoRows.rows.map((row) => [row.slot, row.cnt])),
      leads_vendas_barbearia: Object.fromEntries(
        leadsVendasBarbeariaRows.rows.map((row) => [row.slot, row.cnt]),
      ),
    };

    const flowCounts = r.rows.reduce((acc, row) => {
      const flowId = BOT_MODEL_CONTEXT[row.slot]?.flow_id || row.slot;
      acc[flowId] = (acc[flowId] || 0) + 1;
      return acc;
    }, {});

    // Busca status das sessões WAHA para enriquecer cada bot com waha_status/waha_me.
    // Promise.allSettled garante que falha do WAHA não bloqueia a resposta.
    const wahaSessionsResult = await Promise.allSettled([wahaFetch('/api/sessions')]);
    let sessionsByName = {};
    if (wahaSessionsResult[0].status === 'fulfilled') {
      const sessions = Array.isArray(wahaSessionsResult[0].value)
        ? wahaSessionsResult[0].value
        : [];
      sessionsByName = Object.fromEntries(sessions.map((s) => [s.name, s]));
    } else {
      console.error('wahaFetch /api/sessions falhou:', wahaSessionsResult[0].reason);
    }

    res.json(
      r.rows.map((row) => {
        const context = BOT_MODEL_CONTEXT[row.slot] || {
          flow_id: row.slot,
          flow_name: row.slot,
          flow_label: row.display_name,
          ai_role: row.display_name,
          runtime: row.slot,
          description: 'Configuração de modelo cadastrada no banco.',
        };

        const flowId = context.flow_id;
        const leadsTable = FLOW_LEADS_TABLE[flowId];
        // Filtra leads apenas do slot deste bot — Object.values somava todos os slots
        // da tabela (bug: matrizes com clones inflavam o count do bot original).
        const leadsCount = leadsTable ? leadsByLeadsTable[leadsTable][row.slot] || 0 : 0;

        // waha_sessao tem precedência sobre slot — fallback garante compatibilidade
        // com linhas antigas onde a coluna ainda é NULL (antes de rodar a migration 021).
        const wahaKey = row.waha_sessao || row.slot;
        const wahaSession = sessionsByName[wahaKey];

        return {
          ...row,
          ...context,
          models_in_flow: flowCounts[flowId] || 1,
          messages_today: msgBySlot[row.slot] ?? 0,
          leads_count: leadsCount,
          waha_sessao: row.waha_sessao || null,
          waha_status: wahaSession?.status || null,
          waha_me: wahaSession?.me?.id || null,
        };
      }),
    );
  }),
);

app.get('/api/bots/:slot', async (req, res) => {
  try {
    const { slot } = req.params;
    const [cfgR, promptR] = await Promise.all([
      pool.query(
        `SELECT slot, display_name, provider, model, temperature::float AS temperature,
                horarios_funcionamento, servicos, updated_at
         FROM bot_config WHERE slot = $1`,
        [slot],
      ),
      pool.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [slot]),
    ]);
    if (!cfgR.rows.length) return res.status(404).json({ error: 'bot nao encontrado' });
    res.json({
      ...cfgR.rows[0],
      prompt: promptR.rows[0]?.prompt ?? '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/bots/:slot', async (req, res) => {
  try {
    const { slot } = req.params;
    const {
      provider,
      model,
      temperature,
      display_name,
      name,
      horarios_funcionamento,
      servicos,
    } = req.body;

    // Validacao leve dos novos campos (paridade com PATCH /api/clones/:id).
    if (horarios_funcionamento !== undefined) {
      if (
        !horarios_funcionamento ||
        typeof horarios_funcionamento !== 'object' ||
        Array.isArray(horarios_funcionamento)
      ) {
        return res.status(400).json({ error: 'horarios_funcionamento deve ser objeto' });
      }
    }
    if (servicos !== undefined) {
      if (!Array.isArray(servicos)) {
        return res.status(400).json({ error: 'servicos deve ser array' });
      }
      for (const s of servicos) {
        if (!s || typeof s !== 'object' || !s.nome) {
          return res.status(400).json({ error: 'cada servico precisa de { nome }' });
        }
      }
    }

    const sets = [];
    const vals = [];
    let i = 1;
    const newDisplayName = display_name || name;
    if (newDisplayName) {
      sets.push(`display_name = $${i++}`);
      vals.push(String(newDisplayName).trim());
    }
    if (provider) {
      sets.push(`provider = $${i++}`);
      vals.push(provider);
    }
    if (model) {
      sets.push(`model = $${i++}`);
      vals.push(model);
    }
    if (temperature !== undefined) {
      sets.push(`temperature = $${i++}`);
      vals.push(Number(temperature));
    }
    if (horarios_funcionamento !== undefined) {
      sets.push(`horarios_funcionamento = $${i++}::jsonb`);
      vals.push(JSON.stringify(horarios_funcionamento));
    }
    if (servicos !== undefined) {
      sets.push(`servicos = $${i++}::jsonb`);
      vals.push(JSON.stringify(servicos));
    }
    if (sets.length === 0) return res.status(400).json({ error: 'nada para atualizar' });
    sets.push('updated_at = NOW()');
    vals.push(slot);
    const r = await pool.query(
      `UPDATE bot_config SET ${sets.join(', ')} WHERE slot = $${i} RETURNING *`,
      vals,
    );
    if (!r.rows.length) return res.status(404).json({ error: 'slot nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- USAGE (tokens consumidos) ----------
app.get(
  '/api/usage/summary',
  asyncHandler(async (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 7));
    const r = await pool.query(
      `
    SELECT slot, provider, model,
           COUNT(*)::int AS calls,
           SUM(prompt_tokens)::int AS prompt_tokens,
           SUM(completion_tokens)::int AS completion_tokens,
           SUM(total_tokens)::int AS total_tokens,
           ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
    FROM model_usage
    WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
    GROUP BY slot, provider, model
    ORDER BY SUM(total_tokens) DESC
  `,
      [String(days)],
    );
    res.json({ days, rows: r.rows });
  }),
);

app.get(
  '/api/usage/daily',
  asyncHandler(async (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    const r = await pool.query(
      `
    SELECT TO_CHAR(DATE_TRUNC('day', created_at), 'YYYY-MM-DD') AS day,
           SUM(total_tokens)::int AS total_tokens,
           ROUND(SUM(cost_usd)::numeric, 4) AS cost_usd
    FROM model_usage
    WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
    GROUP BY 1 ORDER BY 1
  `,
      [String(days)],
    );
    res.json({ days, rows: r.rows });
  }),
);

app.get(
  '/api/usage/recent',
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const r = await pool.query(
      `
    SELECT id, slot, provider, model, total_tokens,
           ROUND(cost_usd::numeric, 4) AS cost_usd, telefone, created_at
    FROM model_usage ORDER BY id DESC LIMIT $1
  `,
      [limit],
    );
    res.json(r.rows);
  }),
);

/**
 * Mapa de pricing por modelo — espelho de packages/db/src/queries/model-usage.ts:PRICING.
 * Manter em sync manualmente ao adicionar/atualizar modelos.
 * isEstimate: true indica ausência de pricing oficial publicado pelo provedor;
 * frontend deve exibir aviso "~ valor estimado".
 */
const MODEL_PRICING = {
  'gpt-4o':            { in: 2.5,  out: 10.0 },
  'gpt-4o-mini':       { in: 0.15, out: 0.6  },
  'gpt-4-turbo':       { in: 10.0, out: 30.0 },
  'gpt-3.5-turbo':     { in: 0.5,  out: 1.5  },
  // Pricing nao publicado pela OpenAI. Placeholder proporcional ao gpt-4o.
  // Remover isEstimate quando OpenAI publicar oficial.
  'gpt-5.4':           { in: 5.0,  out: 20.0, isEstimate: true },
  'deepseek-chat':     { in: 0.27, out: 1.1  },
  'deepseek-reasoner': { in: 0.55, out: 2.19 },
};

app.get(
  '/api/usage/pricing-info',
  asyncHandler(async (_req, res) => {
    res.json(MODEL_PRICING);
  }),
);

// ---------- MODELOS DISPONÍVEIS ----------
// Allowlist de modelos que o painel expõe para seleção.
// TODO: puxar lista dinamicamente da OpenAI API quando disponível.
const MODEL_ALLOWLIST = ['gpt-5.4', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo', 'deepseek-chat'];

app.get(
  '/api/models',
  asyncHandler(async (_req, res) => {
    const models = MODEL_ALLOWLIST.map((id) => {
      const pricing = MODEL_PRICING[id] ?? { in: null, out: null };
      return {
        id,
        label: id === 'gpt-5.4' ? 'GPT-5.4 (mais inteligente, ~estimado)' : id,
        isEstimate: pricing.isEstimate ?? false,
        in: pricing.in,
        out: pricing.out,
      };
    });
    res.json(models);
  }),
);

app.put('/api/bots/:slot/model', async (req, res) => {
  try {
    const { slot } = req.params;
    const { model } = req.body ?? {};
    if (!model || !MODEL_ALLOWLIST.includes(model)) {
      return res.status(400).json({ error: 'modelo inválido', allowlist: MODEL_ALLOWLIST });
    }
    const prev = await pool.query('SELECT model FROM bot_config WHERE slot = $1', [slot]);
    if (!prev.rows.length) return res.status(404).json({ error: 'slot não encontrado' });
    const from = prev.rows[0].model;
    const r = await pool.query(
      `UPDATE bot_config SET model = $1, updated_at = NOW() WHERE slot = $2 RETURNING *`,
      [model, slot],
    );
    console.log(`[modelChange] slot=${slot} from=${from} to=${model}`);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- PROMPT ----------
app.get('/api/bots/:slot/prompt', async (req, res) => {
  try {
    const r = await pool.query('SELECT slot, prompt, updated_at FROM bot_prompt WHERE slot = $1', [
      req.params.slot,
    ]);
    if (!r.rows.length) return res.status(404).json({ error: 'prompt nao definido' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/bots/:slot/prompt', async (req, res) => {
  const client = await pool.connect();
  try {
    const { prompt: newPrompt, comment: editComment } = req.body;
    if (typeof newPrompt !== 'string' || !newPrompt.length) {
      return res.status(400).json({ error: 'prompt obrigatorio' });
    }
    const { slot } = req.params;
    const editedBy = req.headers['x-admin'] || 'admin';

    await client.query('BEGIN');

    // Auto-snapshot: grava versão da cópia ATUAL antes de sobrescrever.
    // Só cria snapshot se o prompt de fato mudou (evita versões duplicadas).
    // Usa INSERT ... RETURNING para detectar colisão de (slot, version):
    //   - ON CONFLICT DO NOTHING + rowCount === 0 significa race condition → reloga e continua.
    // Se a tabela bot_prompt_versions não existir (42P01), o erro sobe para o catch
    // principal e faz ROLLBACK — nunca salva prompt sem versioning.
    let versionSaved = null;
    const cur = await client.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [slot]);
    if (cur.rows.length && cur.rows[0].prompt !== newPrompt) {
      const maxRes = await client.query(
        'SELECT COALESCE(MAX(version), 0) AS m FROM bot_prompt_versions WHERE slot = $1',
        [slot],
      );
      const nextVersion = Number(maxRes.rows[0].m) + 1;
      const insRes = await client.query(
        `INSERT INTO bot_prompt_versions (slot, version, prompt, edited_by, comment)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slot, version) DO NOTHING
         RETURNING version`,
        [
          slot,
          nextVersion,
          cur.rows[0].prompt,
          editedBy,
          editComment || 'auto-snapshot pre-edit',
        ],
      );
      if (insRes.rowCount === 0) {
        // Colisão de versão: registra aviso mas não bloqueia a edição do prompt.
        // Ocorre em raros casos de race condition (dois PUTs simultâneos no mesmo slot).
        console.warn(
          `[PUT /api/bots/${slot}/prompt] versioning: conflito na versao ${nextVersion} — ON CONFLICT DO NOTHING ativado. Prompt salvo sem snapshot desta edicao.`,
        );
      } else {
        versionSaved = insRes.rows[0].version;
      }
    }

    const r = await client.query(
      `INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()
       RETURNING slot, prompt, updated_at`,
      [slot, newPrompt],
    );
    await client.query('COMMIT');
    // Inclui version_saved na resposta para que o frontend possa confirmar que o snapshot foi criado.
    res.json({ ...r.rows[0], version_saved: versionSaved });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[PUT /api/bots/${req.params.slot}/prompt] erro transacional: ${e.message}`);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- VERSOES DE PROMPT ----------
app.get('/api/bots/:slot/prompt/versions', async (req, res) => {
  try {
    const { slot } = req.params;
    const r = await pool.query(
      `SELECT version, length(prompt) AS len, edited_by, edited_at, comment
       FROM bot_prompt_versions WHERE slot = $1 ORDER BY version DESC LIMIT 50`,
      [slot],
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/bots/:slot/prompt/versions/:version', async (req, res) => {
  try {
    const { slot } = req.params;
    const version = Number(req.params.version);
    const r = await pool.query(
      `SELECT version, prompt, edited_by, edited_at, comment
       FROM bot_prompt_versions WHERE slot = $1 AND version = $2`,
      [slot, version],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'versao nao encontrada' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bots/:slot/prompt/rollback/:version', async (req, res) => {
  const client = await pool.connect();
  try {
    const { slot } = req.params;
    const version = Number(req.params.version);
    await client.query('BEGIN');

    const v = await client.query(
      'SELECT prompt FROM bot_prompt_versions WHERE slot = $1 AND version = $2',
      [slot, version],
    );
    if (!v.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'versao nao encontrada' });
    }

    const next = await client.query(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM bot_prompt_versions WHERE slot = $1',
      [slot],
    );
    const nextVersion = Number(next.rows[0].next);

    // Salva versao atual antes de sobrescrever (rollback e undoable)
    const current = await client.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [slot]);
    if (current.rows.length) {
      await client.query(
        `INSERT INTO bot_prompt_versions (slot, version, prompt, edited_by, comment)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slot, version) DO NOTHING`,
        [slot, nextVersion, current.rows[0].prompt, 'rollback-from-v' + version, 'snapshot antes do rollback'],
      );
    }

    await client.query(
      'UPDATE bot_prompt SET prompt = $1, updated_at = NOW() WHERE slot = $2',
      [v.rows[0].prompt, slot],
    );

    // Registra a versao restaurada como nova entrada
    await client.query(
      `INSERT INTO bot_prompt_versions (slot, version, prompt, edited_by, comment)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slot, version) DO NOTHING`,
      [slot, nextVersion + 1, v.rows[0].prompt, 'rollback', 'rollback de v' + version],
    );

    await client.query('COMMIT');
    res.json({ ok: true, restored_version: version, new_version: nextVersion + 1 });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ---------- PALAVRAS-CHAVE DE PAUSA POR FLUXO ----------
app.get('/api/workflows/:workflowId/pause-keywords', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT flow_id, command, keyword, keyword_norm, enabled, updated_at
       FROM flow_pause_keywords
       WHERE flow_id = $1
       ORDER BY command, keyword`,
      [req.params.workflowId],
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/workflows/:workflowId/pause-keywords', async (req, res) => {
  const client = await pool.connect();
  try {
    const rows = normalizePauseKeywordPayload(req.body);
    await client.query('BEGIN');
    await client.query('DELETE FROM flow_pause_keywords WHERE flow_id = $1', [
      req.params.workflowId,
    ]);
    for (const row of rows) {
      await client.query(
        `INSERT INTO flow_pause_keywords
           (flow_id, command, keyword, keyword_norm, enabled, updated_at)
         VALUES ($1,$2,$3,$4,$5,NOW())
         ON CONFLICT (flow_id, command, keyword_norm) DO UPDATE SET
           keyword = EXCLUDED.keyword,
           enabled = EXCLUDED.enabled,
           updated_at = NOW()`,
        [req.params.workflowId, row.command, row.keyword, row.keyword_norm, row.enabled],
      );
    }
    await client.query('COMMIT');
    const saved = await pool.query(
      `SELECT flow_id, command, keyword, keyword_norm, enabled, updated_at
       FROM flow_pause_keywords
       WHERE flow_id = $1
       ORDER BY command, keyword`,
      [req.params.workflowId],
    );
    res.json(saved.rows);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- PALAVRAS-CHAVE DE PAUSA POR SLOT ----------
// Atalho que resolve slot → flow_id internamente, evitando que o frontend
// precise conhecer os flow_ids legados das matrizes.

app.get('/api/bots/:slot/pause-keywords', async (req, res) => {
  try {
    const { slot } = req.params;
    const flowId = resolveSlotToFlowId(slot);
    const result = await pool.query(
      `SELECT command, keyword
       FROM flow_pause_keywords
       WHERE flow_id = $1 AND enabled = TRUE
       ORDER BY command, keyword`,
      [flowId],
    );
    const pause = result.rows.filter((r) => r.command === 'pause').map((r) => r.keyword);
    const resume = result.rows.filter((r) => r.command === 'resume').map((r) => r.keyword);
    res.json({ slot, flow_id: flowId, pause, resume });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/bots/:slot/pause-keywords', async (req, res) => {
  const { slot } = req.params;
  const flowId = resolveSlotToFlowId(slot);
  const rows = normalizePauseKeywordPayload(req.body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM flow_pause_keywords WHERE flow_id = $1', [flowId]);
    for (const row of rows) {
      await client.query(
        `INSERT INTO flow_pause_keywords (flow_id, command, keyword, keyword_norm, enabled, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, NOW())
         ON CONFLICT (flow_id, command, keyword_norm) DO UPDATE
           SET keyword = EXCLUDED.keyword, enabled = TRUE, updated_at = NOW()`,
        [flowId, row.command, row.keyword, row.keyword_norm],
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, slot, flow_id: flowId, saved: rows.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- PAUSAS ATIVAS POR FLUXO ----------
// flow_pauses guarda quem está pausado pra cada flow_id (matriz, clone ou bot
// interno). Pausas vêm de comando manual (fromMe), antibot (flood) ou regra.
// Esses endpoints permitem ao operador ver e despausar pelo painel.
//
// LGPD: o GET omite a coluna `session` (operador não precisa) e trunca `reason`
// a 200 chars pra evitar vazar contexto de conversa em log/proxy. O DELETE
// registra audit trail em stdout (log estruturado) com telefone mascarado, pra
// rastreabilidade enquanto não existe tabela pii_access_log dedicada.

function _maskPhoneForLog(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length < 6) return d;
  return d.slice(0, 4) + '***' + d.slice(-2);
}

app.get('/api/flows/pauses/summary', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT flow_id, COUNT(*)::int AS active_count
       FROM flow_pauses
       WHERE active = true
       GROUP BY flow_id`,
    );
    const map = {};
    for (const row of r.rows) map[row.flow_id] = row.active_count;
    res.json(map);
  } catch (e) {
    console.error('[flow-pauses-summary]', e);
    res.status(500).json({ error: 'erro ao consultar pausas' });
  }
});

app.get('/api/flows/:flowId/pauses', async (req, res) => {
  try {
    const flowId = String(req.params.flowId || '').trim();
    if (!flowId) return res.status(400).json({ error: 'flowId inválido' });
    const includeInactive =
      req.query.includeInactive === 'true' || req.query.includeInactive === '1';
    const r = await pool.query(
      `SELECT flow_id, flow_name, telefone, active, source,
              LEFT(reason, 200) AS reason,
              created_at, updated_at
       FROM flow_pauses
       WHERE flow_id = $1 ${includeInactive ? '' : 'AND active = true'}
       ORDER BY active DESC, updated_at DESC, created_at DESC
       LIMIT 500`,
      [flowId],
    );
    res.json({ flow_id: flowId, count: r.rows.length, pauses: r.rows });
  } catch (e) {
    console.error('[flow-pauses-list]', e);
    res.status(500).json({ error: 'erro ao consultar pausas' });
  }
});

app.delete('/api/flows/:flowId/pauses/:telefone', async (req, res) => {
  try {
    const flowId = String(req.params.flowId || '').trim();
    if (!flowId) return res.status(400).json({ error: 'flowId inválido' });
    const phone = String(req.params.telefone || '').replace(/\D/g, '');
    if (!phone) return res.status(400).json({ error: 'telefone inválido' });
    const operator = req.session?.userId || 'unknown';
    const r = await pool.query(
      `UPDATE flow_pauses
         SET active = false,
             updated_at = NOW(),
             reason = CASE
               WHEN reason IS NULL OR reason = '' THEN 'despausado via painel'
               ELSE reason || ' | despausado via painel'
             END
       WHERE flow_id = $1 AND telefone = $2 AND active = true
       RETURNING flow_id, telefone, active, source,
                 LEFT(reason, 200) AS reason, updated_at`,
      [flowId, phone],
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'pausa ativa não encontrada' });
    }
    console.log(JSON.stringify({
      audit: 'flow-pause-deactivated',
      operator,
      flow_id: flowId,
      phone_masked: _maskPhoneForLog(phone),
      source: r.rows[0].source,
      at: new Date().toISOString(),
    }));
    res.json({ ok: true, pause: r.rows[0] });
  } catch (e) {
    console.error('[flow-pauses-delete]', e);
    res.status(500).json({ error: 'erro ao despausar' });
  }
});

// ---------- MIDIAS ----------
app.get('/api/bots/:slot/media', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, slot, position, title, media_type, url, caption, context, position_order, enabled,
              course_slug, is_course_intro, updated_at
       FROM bot_media WHERE slot = $1 ORDER BY position_order, id`,
      [req.params.slot],
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[media-get]', e);
    res.status(500).json({ error: 'erro ao listar midias' });
  }
});

app.post('/api/bots/:slot/media', async (req, res) => {
  try {
    const {
      position,
      title = null,
      media_type = 'image',
      url = null,
      caption = null,
      context = null,
      position_order = 0,
      enabled = true,
    } = req.body;
    if (!url)
      return res.status(400).json({
        error:
          'url obrigatoria: faca upload antes via POST /api/uploads/media e passe o campo url retornado',
      });
    if (title !== null && title !== undefined) {
      if (typeof title !== 'string') return res.status(400).json({ error: 'title deve ser string' });
      if (title.length > 200) return res.status(400).json({ error: 'title excede 200 caracteres' });
    }
    // position nao fornecido: usa timestamp como chave unica
    const pos = position || `media_${Date.now()}`;
    // title nao fornecido: usa position como fallback legivel
    const effectiveTitle = (title !== null && title !== undefined) ? title.trim() || null : pos;
    const r = await pool.query(
      `INSERT INTO bot_media (slot, position, title, media_type, url, caption, context, position_order, enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
       ON CONFLICT (slot, position) DO UPDATE SET
         title = COALESCE(EXCLUDED.title, bot_media.title),
         media_type = EXCLUDED.media_type,
         url = EXCLUDED.url,
         caption = EXCLUDED.caption,
         context = EXCLUDED.context,
         position_order = EXCLUDED.position_order,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING *`,
      [
        req.params.slot,
        pos,
        effectiveTitle,
        media_type,
        url,
        caption,
        context,
        Number(position_order) || 0,
        !!enabled,
      ],
    );
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[media-post]', e);
    res.status(500).json({ error: 'erro ao criar midia' });
  }
});

app.put('/api/bots/:slot/media/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { slot } = req.params;
    const mediaId = Number(req.params.id);
    const { caption, context, position_order, enabled, course_slug, is_course_intro, title } = req.body;

    // Validação de title (opcional, máx 200 chars)
    if (title !== undefined && title !== null) {
      if (typeof title !== 'string') return res.status(400).json({ error: 'title deve ser string' });
      if (title.length > 200) return res.status(400).json({ error: 'title excede 200 caracteres' });
    }

    // Validações dos novos campos de curso (ADR 0008 / fix decisão #14 — imagens também aceitas)
    if (course_slug !== undefined && course_slug !== null) {
      // Confirmar que a mídia existe (independente de tipo)
      const mediaCheck = await pool.query(
        `SELECT media_type FROM bot_media WHERE slot = $1 AND id = $2`,
        [slot, mediaId],
      );
      if (!mediaCheck.rows.length) return res.status(404).json({ error: 'midia nao encontrada' });
      // Validar que o curso existe neste slot
      const courseCheck = await pool.query(
        `SELECT id FROM bot_courses WHERE slot = $1 AND course_slug = $2`,
        [slot, course_slug],
      );
      if (!courseCheck.rows.length) {
        return res
          .status(400)
          .json({ error: `curso '${course_slug}' nao encontrado no slot '${slot}'` });
      }
      // Limite de 5 mídias por curso (exclui a própria mídia)
      const countCheck = await pool.query(
        `SELECT COUNT(*) AS total FROM bot_media WHERE slot = $1 AND course_slug = $2 AND id != $3`,
        [slot, course_slug, mediaId],
      );
      if (Number(countCheck.rows[0].total) >= 5) {
        return res
          .status(400)
          .json({ error: `limite de 5 midias por curso atingido para '${course_slug}'` });
      }
    }

    if (is_course_intro === true) {
      // is_course_intro=true exige course_slug setado (na requisição ou já no banco)
      let effectiveCourseSlug = course_slug;
      if (effectiveCourseSlug === undefined || effectiveCourseSlug === null) {
        const cur = await pool.query(
          `SELECT course_slug FROM bot_media WHERE slot = $1 AND id = $2`,
          [slot, mediaId],
        );
        effectiveCourseSlug = cur.rows[0]?.course_slug ?? null;
      }
      if (!effectiveCourseSlug) {
        return res.status(400).json({ error: 'is_course_intro=true exige course_slug definido' });
      }
    }

    const fields = [];
    const vals = [];
    let idx = 1;
    if (title !== undefined) {
      fields.push(`title = $${idx++}`);
      vals.push(title !== null ? String(title).trim() || null : null);
    }
    if (caption !== undefined) {
      fields.push(`caption = $${idx++}`);
      vals.push(caption);
    }
    if (context !== undefined) {
      fields.push(`context = $${idx++}`);
      vals.push(context);
    }
    if (position_order !== undefined) {
      fields.push(`position_order = $${idx++}`);
      vals.push(Number(position_order) || 0);
    }
    if (enabled !== undefined) {
      fields.push(`enabled = $${idx++}`);
      vals.push(!!enabled);
    }
    if (course_slug !== undefined) {
      fields.push(`course_slug = $${idx++}`);
      vals.push(course_slug ?? null);
    }
    if (is_course_intro !== undefined) {
      fields.push(`is_course_intro = $${idx++}`);
      vals.push(!!is_course_intro);
    }
    if (!fields.length) return res.status(400).json({ error: 'nenhum campo editavel fornecido' });
    fields.push(`updated_at = NOW()`);
    vals.push(slot, mediaId);

    await client.query('BEGIN');

    // Se promovendo como intro, zera intro das outras mídias do mesmo curso primeiro (atomic)
    if (is_course_intro === true) {
      const effectiveCourseSlug =
        course_slug !== undefined
          ? course_slug
          : (
              await client.query(`SELECT course_slug FROM bot_media WHERE slot = $1 AND id = $2`, [
                slot,
                mediaId,
              ])
            ).rows[0]?.course_slug;
      if (effectiveCourseSlug) {
        await client.query(
          `UPDATE bot_media SET is_course_intro = false WHERE slot = $1 AND course_slug = $2 AND id != $3`,
          [slot, effectiveCourseSlug, mediaId],
        );
      }
    }

    const r = await client.query(
      `UPDATE bot_media SET ${fields.join(', ')} WHERE slot = $${idx++} AND id = $${idx} RETURNING *`,
      vals,
    );
    if (!r.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'midia nao encontrada' });
    }
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[media-put]', e);
    res.status(500).json({ error: 'erro ao atualizar midia' });
  } finally {
    client.release();
  }
});

app.delete('/api/media/:id', async (req, res) => {
  // TODO(frontend-pr): remover fallback sem slot quando index.html enviar ?slot=X.
  // Atualmente o frontend não passa slot; quando passar, a verificação de ownership
  // garante que um slot não apague mídia de outro.
  const { slot } = req.query;
  try {
    let r;
    if (slot && typeof slot === 'string') {
      r = await pool.query(
        'DELETE FROM bot_media WHERE id = $1 AND slot = $2 RETURNING id',
        [req.params.id, slot],
      );
      if (!r.rowCount) return res.status(404).json({ error: 'mídia não encontrada ou slot incorreto' });
    } else {
      r = await pool.query('DELETE FROM bot_media WHERE id = $1 RETURNING id', [req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'mídia não encontrada' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- GALERIA DE MÍDIA (Fase 1 — Migration 036) ----------
// Endpoints novos que operam sobre bot_media_courses (N:N).
// Os endpoints legados /api/bots/:slot/media e /api/media/:id continuam intactos
// para retrocompatibilidade até a fase 2 fazer o cutover.

// GET /api/bots/:slot/gallery
// Lista todas as mídias do clone com contagem de cursos vinculados.
app.get('/api/bots/:slot/gallery', async (req, res) => {
  try {
    const { slot } = req.params;
    const r = await pool.query(
      `SELECT
         bm.id,
         bm.slot,
         bm.position,
         bm.title,
         bm.media_type,
         bm.url,
         bm.caption,
         bm.context,
         bm.position_order,
         bm.enabled,
         bm.updated_at,
         COUNT(bmc.id)::int AS courses_count
       FROM bot_media bm
       LEFT JOIN bot_media_courses bmc ON bmc.media_id = bm.id AND bmc.slot = bm.slot
       WHERE bm.slot = $1
       GROUP BY bm.id
       ORDER BY bm.position_order, bm.id`,
      [slot],
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/bots/:slot/gallery/:id/rename
// Atualiza o título (campo title) de uma mídia da galeria.
app.put('/api/bots/:slot/gallery/:id/rename', async (req, res) => {
  try {
    const { slot } = req.params;
    const mediaId = Number(req.params.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { title } = req.body ?? {};
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title obrigatório e não pode ser vazio' });
    }
    if (title.length > 200) {
      return res.status(400).json({ error: 'title excede 200 caracteres' });
    }
    const r = await pool.query(
      `UPDATE bot_media SET title = $1, updated_at = NOW()
       WHERE slot = $2 AND id = $3
       RETURNING id, slot, position, title, media_type, url, position_order, enabled, updated_at`,
      [title.trim(), slot, mediaId],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'mídia não encontrada' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/bots/:slot/gallery/:id/replace
// Substitui o arquivo de uma mídia mantendo ID, title e vínculos de curso.
// Multipart: campo "file" (mesmos filtros do mediaUpload).
app.put('/api/bots/:slot/gallery/:id/replace', mediaUpload.single('file'), async (req, res) => {
  try {
    const { slot } = req.params;
    const mediaId = Number(req.params.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    if (!req.file) return res.status(400).json({ error: 'arquivo obrigatório (campo "file")' });

    // Deriva media_type a partir do mimetype do novo arquivo
    const mime = String(req.file.mimetype || '').toLowerCase();
    let media_type = 'file';
    if (mime.startsWith('video/')) media_type = 'video';
    else if (mime.startsWith('image/')) media_type = 'image';
    else if (mime.startsWith('audio/')) media_type = 'audio';

    const base = String(MEDIA_PUBLIC_BASE_URL || '/uploads').replace(/\/$/, '');
    const url = `${base}/${encodeURIComponent(req.file.filename)}`;

    const r = await pool.query(
      `UPDATE bot_media
          SET url = $1, media_type = $2, updated_at = NOW()
        WHERE slot = $3 AND id = $4
        RETURNING id, slot, position, title, media_type, url, position_order, enabled, updated_at`,
      [url, media_type, slot, mediaId],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'mídia não encontrada' });
    res.json({ ...r.rows[0], size: req.file.size, original_name: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/bots/:slot/gallery/:id
// Exclui mídia apenas se não houver vínculos em bot_media_courses.
// Retorna 409 com lista de cursos vinculados se houver bloqueio.
app.delete('/api/bots/:slot/gallery/:id', async (req, res) => {
  try {
    const { slot } = req.params;
    const mediaId = Number(req.params.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }

    // Verifica vínculos ativos em bot_media_courses
    const linkCheck = await pool.query(
      `SELECT bmc.course_slug, bc.name AS course_name
         FROM bot_media_courses bmc
         LEFT JOIN bot_courses bc ON bc.slot = bmc.slot AND bc.course_slug = bmc.course_slug
        WHERE bmc.slot = $1 AND bmc.media_id = $2`,
      [slot, mediaId],
    );
    if (linkCheck.rows.length > 0) {
      return res.status(409).json({
        error: `mídia vinculada a ${linkCheck.rows.length} curso(s). Remova os vínculos antes de excluir.`,
        cursos_vinculados: linkCheck.rows,
      });
    }

    const r = await pool.query(
      'DELETE FROM bot_media WHERE slot = $1 AND id = $2 RETURNING id',
      [slot, mediaId],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'mídia não encontrada' });
    res.json({ ok: true, id: mediaId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bots/:slot/gallery/:id/usage
// Lista cursos onde a mídia está vinculada via bot_media_courses.
app.get('/api/bots/:slot/gallery/:id/usage', async (req, res) => {
  try {
    const { slot } = req.params;
    const mediaId = Number(req.params.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }

    // Confirma existência da mídia no slot
    const mediaCheck = await pool.query(
      'SELECT id, title, position, media_type FROM bot_media WHERE slot = $1 AND id = $2',
      [slot, mediaId],
    );
    if (!mediaCheck.rows.length) return res.status(404).json({ error: 'mídia não encontrada' });

    const r = await pool.query(
      `SELECT
         bmc.id AS link_id,
         bmc.course_slug,
         bc.name AS course_name,
         bmc.is_intro,
         bmc.position_order,
         bmc.created_at AS linked_at
       FROM bot_media_courses bmc
       LEFT JOIN bot_courses bc ON bc.slot = bmc.slot AND bc.course_slug = bmc.course_slug
       WHERE bmc.slot = $1 AND bmc.media_id = $2
       ORDER BY bmc.position_order, bmc.created_at`,
      [slot, mediaId],
    );
    res.json({
      media: mediaCheck.rows[0],
      courses: r.rows,
      total: r.rows.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bots/:slot/gallery/:id/link
// Cria vínculo entre mídia e curso em bot_media_courses.
// Body: { course_slug, is_intro?: bool, position_order?: int }
app.post('/api/bots/:slot/gallery/:id/link', async (req, res) => {
  try {
    const { slot } = req.params;
    const mediaId = Number(req.params.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }
    const { course_slug, is_intro = false, position_order = 0 } = req.body ?? {};
    if (!course_slug || typeof course_slug !== 'string' || !course_slug.trim()) {
      return res.status(400).json({ error: 'course_slug obrigatório' });
    }

    // Valida existência da mídia no slot
    const mediaCheck = await pool.query(
      'SELECT id FROM bot_media WHERE slot = $1 AND id = $2',
      [slot, mediaId],
    );
    if (!mediaCheck.rows.length) return res.status(404).json({ error: 'mídia não encontrada' });

    // Valida existência do curso no slot
    const courseCheck = await pool.query(
      'SELECT id FROM bot_courses WHERE slot = $1 AND course_slug = $2',
      [slot, course_slug.trim()],
    );
    if (!courseCheck.rows.length) {
      return res.status(404).json({ error: `curso '${course_slug}' não encontrado no slot '${slot}'` });
    }

    // Se is_intro=true, zera outros intros deste curso antes (transação)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      if (is_intro === true) {
        await client.query(
          `UPDATE bot_media_courses SET is_intro = FALSE
           WHERE slot = $1 AND course_slug = $2 AND is_intro = TRUE`,
          [slot, course_slug.trim()],
        );
      }

      const r = await client.query(
        `INSERT INTO bot_media_courses (slot, media_id, course_slug, is_intro, position_order, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [slot, mediaId, course_slug.trim(), !!is_intro, Number(position_order) || 0],
      );

      await client.query('COMMIT');
      res.status(201).json(r.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      if (e.code === '23505') {
        return res.status(409).json({
          error: `vínculo já existe: mídia ${mediaId} já está vinculada ao curso '${course_slug}'`,
        });
      }
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/bots/:slot/gallery/:id/link/:course_slug
// Remove vínculo específico entre mídia e curso.
app.delete('/api/bots/:slot/gallery/:id/link/:course_slug', async (req, res) => {
  try {
    const { slot, course_slug } = req.params;
    const mediaId = Number(req.params.id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return res.status(400).json({ error: 'id inválido' });
    }

    const r = await pool.query(
      `DELETE FROM bot_media_courses
       WHERE slot = $1 AND media_id = $2 AND course_slug = $3
       RETURNING id`,
      [slot, mediaId, course_slug],
    );
    if (!r.rowCount) {
      return res.status(404).json({ error: 'vínculo não encontrado' });
    }
    res.json({ ok: true, link_id: r.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/bots/:slot/courses/:course_slug/media
// Sincroniza atomicamente a lista completa de mídias de um curso.
// Body: { media_ids: number[], intro_media_id?: number }
// Substitui todos os vínculos existentes do curso pelos fornecidos.
app.put('/api/bots/:slot/courses/:course_slug/media', async (req, res) => {
  const client = await pool.connect();
  try {
    const { slot, course_slug } = req.params;
    const { media_ids, intro_media_id } = req.body ?? {};

    if (!Array.isArray(media_ids)) {
      return res.status(400).json({ error: 'media_ids deve ser um array de inteiros' });
    }
    for (const id of media_ids) {
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: `media_ids contém valor inválido: ${id}` });
      }
    }
    if (intro_media_id !== undefined && intro_media_id !== null) {
      if (!Number.isInteger(intro_media_id) || intro_media_id <= 0) {
        return res.status(400).json({ error: 'intro_media_id inválido' });
      }
      if (media_ids.length > 0 && !media_ids.includes(intro_media_id)) {
        return res.status(400).json({ error: 'intro_media_id deve estar presente em media_ids' });
      }
    }

    // Valida existência do curso
    const courseCheck = await pool.query(
      'SELECT id FROM bot_courses WHERE slot = $1 AND course_slug = $2',
      [slot, course_slug],
    );
    if (!courseCheck.rows.length) {
      return res.status(404).json({ error: `curso '${course_slug}' não encontrado no slot '${slot}'` });
    }

    // Valida que todas as mídias fornecidas pertencem ao slot
    if (media_ids.length > 0) {
      const mediaCheck = await pool.query(
        'SELECT id FROM bot_media WHERE slot = $1 AND id = ANY($2::int[])',
        [slot, media_ids],
      );
      if (mediaCheck.rows.length !== media_ids.length) {
        const found = new Set(mediaCheck.rows.map((r) => r.id));
        const missing = media_ids.filter((id) => !found.has(id));
        return res.status(400).json({
          error: `mídia(s) não encontrada(s) no slot '${slot}': ${missing.join(', ')}`,
        });
      }
    }

    await client.query('BEGIN');

    // Remove todos os vínculos atuais do curso
    await client.query(
      'DELETE FROM bot_media_courses WHERE slot = $1 AND course_slug = $2',
      [slot, course_slug],
    );

    // Insere novos vínculos preservando position_order pela posição no array
    const inserted = [];
    for (let i = 0; i < media_ids.length; i++) {
      const mid = media_ids[i];
      const isIntro = intro_media_id != null ? mid === intro_media_id : false;
      const r = await client.query(
        `INSERT INTO bot_media_courses (slot, media_id, course_slug, is_intro, position_order, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [slot, mid, course_slug, isIntro, i],
      );
      inserted.push(r.rows[0]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, course_slug, total: inserted.length, links: inserted });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- CURSOS ----------

app.get('/api/bots/:slot/courses', async (req, res) => {
  try {
    // Inclui linked_media_count e linked_media_ids via bot_media_courses (N:N, Migration 036).
    // Usa UNION com bot_media legado para cobrir período de transição entre as tabelas.
    // linked_media_ids: array de IDs únicos (sem duplicatas entre as duas fontes).
    const r = await pool.query(
      `SELECT
         bc.id,
         bc.slot,
         bc.course_slug,
         bc.name,
         bc.description,
         bc.price,
         bc.duration,
         bc.position_order,
         bc.enabled,
         bc.details_for_llm,
         bc.created_at,
         bc.updated_at,
         COUNT(DISTINCT combined.mid)::int    AS linked_media_count,
         COALESCE(
           ARRAY_AGG(DISTINCT combined.mid) FILTER (WHERE combined.mid IS NOT NULL),
           ARRAY[]::int[]
         )                                    AS linked_media_ids
       FROM bot_courses bc
       LEFT JOIN (
         SELECT course_slug, media_id AS mid FROM bot_media_courses WHERE slot = $1
         UNION
         SELECT course_slug, id        AS mid FROM bot_media          WHERE slot = $1 AND course_slug IS NOT NULL
       ) AS combined ON combined.course_slug = bc.course_slug
       WHERE bc.slot = $1
       GROUP BY bc.id
       ORDER BY bc.position_order, bc.id`,
      [req.params.slot],
    );
    res.json(r.rows);
  } catch (e) {
    console.error('[courses-get]', e);
    res.status(500).json({ error: 'erro ao listar cursos' });
  }
});

app.post('/api/bots/:slot/courses', async (req, res) => {
  try {
    const { slot } = req.params;
    const {
      course_slug,
      name,
      description = null,
      price = 0,
      duration = null,
      position_order = 0,
      enabled = true,
      details_for_llm = null,
    } = req.body;
    if (!course_slug || typeof course_slug !== 'string' || !course_slug.trim()) {
      return res.status(400).json({ error: 'course_slug e obrigatorio' });
    }
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name e obrigatorio' });
    }
    if (typeof price !== 'number' || !Number.isInteger(price) || price < 0) {
      return res.status(400).json({ error: 'price deve ser inteiro >= 0 (centavos)' });
    }
    const r = await pool.query(
      `INSERT INTO bot_courses
         (slot, course_slug, name, description, price, duration, position_order, enabled, details_for_llm, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
       RETURNING *`,
      [
        slot,
        course_slug.trim(),
        name.trim(),
        description,
        price,
        duration,
        Number(position_order) || 0,
        !!enabled,
        details_for_llm ?? null,
      ],
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === '23505') {
      return res
        .status(409)
        .json({ error: `course_slug '${req.body.course_slug}' ja existe neste slot` });
    }
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/bots/:slot/courses/:id', async (req, res) => {
  try {
    const { slot } = req.params;
    const rawId = req.params.id;
    // Aceita ID numérico ou course_slug como identificador
    const byId = /^\d+$/.test(rawId);
    const whereVal = byId ? Number(rawId) : rawId;

    const { name, description, price, duration, position_order, enabled, details_for_llm } =
      req.body;

    if (
      price !== undefined &&
      (typeof price !== 'number' || !Number.isInteger(price) || price < 0)
    ) {
      return res.status(400).json({ error: 'price deve ser inteiro >= 0 (centavos)' });
    }

    const fields = [];
    const vals = [];
    let idx = 1;
    if (name !== undefined) {
      fields.push(`name = $${idx++}`);
      vals.push(String(name).trim());
    }
    if (description !== undefined) {
      fields.push(`description = $${idx++}`);
      vals.push(description ?? null);
    }
    if (price !== undefined) {
      fields.push(`price = $${idx++}`);
      vals.push(price);
    }
    if (duration !== undefined) {
      fields.push(`duration = $${idx++}`);
      vals.push(duration ?? null);
    }
    if (position_order !== undefined) {
      fields.push(`position_order = $${idx++}`);
      vals.push(Number(position_order) || 0);
    }
    if (enabled !== undefined) {
      fields.push(`enabled = $${idx++}`);
      vals.push(!!enabled);
    }
    if (details_for_llm !== undefined) {
      fields.push(`details_for_llm = $${idx++}`);
      vals.push(details_for_llm ?? null);
    }
    if (!fields.length) return res.status(400).json({ error: 'nenhum campo editavel fornecido' });
    fields.push(`updated_at = NOW()`);

    // whereClause construído DEPOIS dos campos do SET para que os índices $N
    // não colidam com os placeholders dinâmicos do SET (Bug: whereClause usava
    // $1/$2 fixos enquanto o SET também começava em $1).
    const slotIdx = idx++;
    const whereIdx = idx++;
    const whereClause = byId
      ? `slot = $${slotIdx} AND id = $${whereIdx}`
      : `slot = $${slotIdx} AND course_slug = $${whereIdx}`;
    vals.push(slot, whereVal);

    const r = await pool.query(
      `UPDATE bot_courses SET ${fields.join(', ')} WHERE ${whereClause} RETURNING *`,
      vals,
    );
    if (!r.rows.length) return res.status(404).json({ error: 'curso nao encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/bots/:slot/courses/:id', async (req, res) => {
  try {
    const { slot } = req.params;
    const rawId = req.params.id;
    // Aceita ID numérico ou course_slug como identificador
    const byId = /^\d+$/.test(rawId);
    const whereClause = byId ? 'slot = $1 AND id = $2' : 'slot = $1 AND course_slug = $2';
    const whereVal = byId ? Number(rawId) : rawId;

    // Busca o curso para obter o course_slug e validar existência
    const courseCheck = await pool.query(
      `SELECT id, course_slug FROM bot_courses WHERE ${whereClause}`,
      [slot, whereVal],
    );
    if (!courseCheck.rows.length) return res.status(404).json({ error: 'curso nao encontrado' });
    const { id: courseId, course_slug } = courseCheck.rows[0];

    // Conta vínculos em bot_media_courses (tabela N:N, Migration 036) E em bot_media legado.
    // Ambas as fontes coexistem durante fase de transição — bloqueio em qualquer uma delas.
    const linkCountResult = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM (
           SELECT media_id AS mid FROM bot_media_courses WHERE slot = $1 AND course_slug = $2
           UNION
           SELECT id        AS mid FROM bot_media          WHERE slot = $1 AND course_slug = $2
         ) AS combined`,
      [slot, course_slug],
    );
    const linked_media_count = linkCountResult.rows[0].total;
    if (linked_media_count > 0) {
      return res.status(409).json({
        error: `Nao e possivel excluir o curso`,
        linked_media_count,
        message: `Curso tem ${linked_media_count} midia(s) vinculada(s). Desvincule antes de excluir.`,
      });
    }

    await pool.query(`DELETE FROM bot_courses WHERE slot = $1 AND id = $2`, [slot, courseId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[courses-delete]', e);
    res.status(500).json({ error: 'erro ao excluir curso' });
  }
});

// Endpoint dedicado para promover vídeo como apresentação do curso (DoD 006-Fase3)
// PUT /api/bots/:slot/courses/:course_slug/intro/:media_id
app.put('/api/bots/:slot/courses/:course_slug/intro/:media_id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { slot, course_slug, media_id } = req.params;
    const mediaId = Number(media_id);
    if (!Number.isInteger(mediaId) || mediaId <= 0) {
      return res.status(400).json({ error: 'media_id invalido' });
    }

    // Valida que o curso existe neste slot
    const courseCheck = await pool.query(
      `SELECT id FROM bot_courses WHERE slot = $1 AND course_slug = $2`,
      [slot, course_slug],
    );
    if (!courseCheck.rows.length) {
      return res
        .status(404)
        .json({ error: `curso '${course_slug}' nao encontrado no slot '${slot}'` });
    }

    // Valida que a mídia pertence ao curso e é do tipo video
    const mediaCheck = await pool.query(
      `SELECT id, media_type, course_slug FROM bot_media WHERE slot = $1 AND id = $2`,
      [slot, mediaId],
    );
    if (!mediaCheck.rows.length) {
      return res.status(404).json({ error: 'midia nao encontrada' });
    }
    const media = mediaCheck.rows[0];
    if (media.media_type !== 'video') {
      return res
        .status(400)
        .json({ error: 'apenas midias do tipo video podem ser definidas como apresentacao' });
    }
    if (media.course_slug !== course_slug) {
      return res.status(400).json({ error: `midia nao esta vinculada ao curso '${course_slug}'` });
    }

    await client.query('BEGIN');
    // Zera intro de todas as mídias do curso atomicamente
    await client.query(
      `UPDATE bot_media SET is_course_intro = false WHERE slot = $1 AND course_slug = $2`,
      [slot, course_slug],
    );
    // Promove a mídia selecionada
    const r = await client.query(
      `UPDATE bot_media SET is_course_intro = true, updated_at = NOW() WHERE slot = $1 AND id = $2 RETURNING *`,
      [slot, mediaId],
    );
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- FLUXOS COM WEBHOOK ----------
// Retorna os fluxos da plataforma utilizáveis pelo roteador.
app.get('/api/workflows', async (req, res) => {
  try {
    const workflows = await fetchAllWorkflows();
    const slim = workflows.map((w) => {
      return {
        id: w.id,
        name: w.name,
        active: w.active,
        nodes: w.nodes?.length || 0,
        has_webhook: true,
        routable: !!w._routable,
        source: 'ts',
        category: w._category || 'teste',
        tags: w._tags || [],
        description: w._description || '',
        webhook_url: w._webhook_url,
      };
    });
    res.json(slim);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/workflows/:id/active', async (req, res) => {
  try {
    const { id } = req.params;
    const active = !!req.body?.active;
    const workflows = await fetchAllWorkflows();
    const wf = workflows.find((w) => w.id === id);
    if (!wf) return res.status(404).json({ error: 'fluxo nao encontrado' });

    const saved = await setFlowControl({
      flow_id: id,
      flow_name: wf.name,
      source: 'ts',
      active,
    });
    res.json({ ok: true, flow: saved });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fetchAllWorkflows() {
  const tsAsWorkflow = TS_BOTS.map((b) => ({
    id: b.id,
    name: b.name,
    active: b.active,
    nodes: [
      {
        type: 'startap.webhook',
        webhookId: `ts-${b.id}`,
        parameters: { path: 'webhooks/waha' },
      },
    ],
    _tsBot: true,
    _webhook_url: b.webhook_url,
    _routable: b.routable,
    _category: b.category,
    _tags: b.tags,
    _description: b.description,
  }));
  const controls = await getFlowControlMap();
  return tsAsWorkflow.map((w) => {
    const control = controls.get(w.id);
    if (!control) return w;
    return {
      ...w,
      active: control.active,
      _flow_controlled: true,
      _flow_control_updated_at: control.updated_at,
    };
  });
}

async function resolveWorkflow(workflow_id) {
  const tsBot = TS_BOTS.find((b) => b.id === workflow_id);
  if (tsBot) {
    if (!tsBot.routable) return null;
    return { id: tsBot.id, name: tsBot.name, active: tsBot.active, webhook_url: tsBot.webhook_url };
  }
  return null;
}

async function getFlowControlMap() {
  try {
    const r = await pool.query(
      'SELECT flow_id, flow_name, source, active, updated_at FROM flow_controls',
    );
    return new Map(r.rows.map((row) => [row.flow_id, row]));
  } catch (e) {
    if (isRecoverableDbError(e)) return new Map();
    throw e;
  }
}

async function setFlowControl(input) {
  const r = await pool.query(
    `INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (flow_id) DO UPDATE SET
       flow_name = EXCLUDED.flow_name,
       source = EXCLUDED.source,
       active = EXCLUDED.active,
       updated_at = NOW()
     RETURNING flow_id, flow_name, source, active, updated_at`,
    [input.flow_id, input.flow_name, input.source, input.active],
  );
  return r.rows[0];
}

// ---------- SYSTEM STATUS ----------
app.get('/api/status', async (req, res) => {
  try {
    const [workflows, sessions, recentLogs] = await Promise.all([
      fetchAllWorkflows(),
      wahaFetch('/api/sessions').catch(() => []),
      pool
        .query(
          'SELECT id::text, flow_id, flow_name, bot, telefone_masked, session, event_type, status, message, duration_ms, error_summary, created_at FROM flow_execution_logs ORDER BY id DESC LIMIT 15',
        )
        .then((r) => r.rows)
        .catch(() => []),
    ]);
    res.json({
      flows: {
        total: workflows.length,
        ativos: workflows.filter((w) => w.active).length,
        workflows: workflows.map((w) => ({ id: w.id, name: w.name, active: w.active })),
      },
      waha: (Array.isArray(sessions) ? sessions : []).map((s) => ({
        name: s.name,
        status: s.status,
        me: s.me?.id || null,
        updatedAt: s.updatedAt || s.updated_at || null,
        webhook: s.config?.webhooks?.[0]?.url,
      })),
      execucoes: recentLogs,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- FLOW LOGS ----------
const FLOW_LOG_STATUSES = new Set(['running', 'success', 'error', 'ignored']);

app.get('/api/flow-logs', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const { where, vals, nextIndex } = buildFlowLogFilters(req.query);
    vals.push(limit);

    const r = await pool.query(
      `SELECT id::text, execution_id::text, flow_id, flow_name, bot, telefone_masked, session,
              event_type, status, message, metadata, duration_ms, error_summary, created_at
       FROM flow_execution_logs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY id DESC
       LIMIT $${nextIndex}`,
      vals,
    );
    res.json(r.rows.map(normalizeFlowLogRow));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flow-logs/summary', async (req, res) => {
  try {
    const { where, vals } = buildFlowLogFilters(req.query, { ignoreStatus: true });
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await pool.query(
      `WITH filtered AS (
         SELECT id, execution_id, status, created_at
         FROM flow_execution_logs
         ${whereSql}
       ),
       latest AS (
         SELECT DISTINCT ON (execution_id) execution_id, status, id, created_at
         FROM filtered
         ORDER BY execution_id, id DESC
       ),
       event_counts AS (
         SELECT
           COUNT(*)::int AS events,
           COUNT(*) FILTER (WHERE status = 'running')::int AS running_events,
           COUNT(*) FILTER (WHERE status = 'success')::int AS success_events,
           COUNT(*) FILTER (WHERE status = 'error')::int AS error_events,
           COUNT(*) FILTER (WHERE status = 'ignored')::int AS ignored_events,
           MAX(created_at) AS last_event_at
         FROM filtered
       ),
       execution_counts AS (
         SELECT
           COUNT(*)::int AS executions,
           COUNT(*) FILTER (WHERE status = 'running')::int AS running_executions,
           COUNT(*) FILTER (WHERE status = 'success')::int AS success_executions,
           COUNT(*) FILTER (WHERE status = 'error')::int AS error_executions,
           COUNT(*) FILTER (WHERE status = 'ignored')::int AS ignored_executions
         FROM latest
       )
       SELECT * FROM event_counts CROSS JOIN execution_counts`,
      vals,
    );
    const row = r.rows[0] || {};
    const success = Number(row.success_executions || 0);
    const errors = Number(row.error_executions || 0);
    const attempted = success + errors;
    res.json({
      events: Number(row.events || 0),
      running_events: Number(row.running_events || 0),
      success_events: Number(row.success_events || 0),
      error_events: Number(row.error_events || 0),
      ignored_events: Number(row.ignored_events || 0),
      executions: Number(row.executions || 0),
      running_executions: Number(row.running_executions || 0),
      success_executions: success,
      error_executions: errors,
      ignored_executions: Number(row.ignored_executions || 0),
      success_rate: attempted ? Math.round((success / attempted) * 1000) / 10 : 0,
      error_rate: attempted ? Math.round((errors / attempted) * 1000) / 10 : 0,
      last_event_at: row.last_event_at || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/flow-logs/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('event: connected\ndata: {"ok":true}\n\n');

  const client = await pool.connect();
  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: {}\n\n');
  }, 25000);
  let closed = false;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    client.removeAllListeners('notification');
    client.query('UNLISTEN flow_execution_logs').catch(() => {});
    client.release();
  };

  req.on('close', cleanup);

  try {
    await client.query('LISTEN flow_execution_logs');
    client.on('notification', (msg) => {
      if (!msg.payload) return;
      res.write(`event: log\ndata: ${msg.payload}\n\n`);
    });
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    cleanup();
    res.end();
  }
});

app.post('/api/flow-logs/prune', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.body?.days) || 14));
    const r = await pool.query(
      `DELETE FROM flow_execution_logs
       WHERE created_at < NOW() - ($1 || ' days')::INTERVAL`,
      [String(days)],
    );
    res.json({ ok: true, deleted: r.rowCount ?? 0, days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- EXECUTIONS (agrupado por execution_id) ----------
// flow_execution_logs registra eventos individuais de uma mesma conversa
// sob o mesmo execution_id (UUID gerado pelo worker TS no início do processamento).
// Estes endpoints agrupam os eventos para alimentar a tela de fluxograma do painel.

/**
 * Mascara telefone para exibição no painel.
 * Entrada: qualquer string (ex: "5511999887766", "+5511999887766", "11999887766")
 * Saída:   "+55 XX XXXXX-XXXX" ou a string original se não reconhecer o padrão.
 */
function maskPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  // Formato BR: 55 + DDD (2) + número (8 ou 9)
  if (digits.length === 13 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const num = digits.slice(4);
    const formatted = num.length === 9
      ? `${num.slice(0, 5)}-${num.slice(5)}`
      : `${num.slice(0, 4)}-${num.slice(4)}`;
    return `+55 ${ddd} ${formatted}`;
  }
  if (digits.length === 11) {
    const ddd = digits.slice(0, 2);
    const num = digits.slice(2);
    const formatted = num.length === 9
      ? `${num.slice(0, 5)}-${num.slice(5)}`
      : `${num.slice(0, 4)}-${num.slice(4)}`;
    return `+55 ${ddd} ${formatted}`;
  }
  // Fallback: retorna como veio (já pode estar mascarado por telefone_masked)
  return raw;
}

/**
 * Determina status final de uma execução a partir do array de eventos ordenados.
 * Lógica: último evento com status definido tem precedência.
 * Se algum evento é 'error' → 'error'; se todos success → 'success'; senão 'running'.
 */
function resolveExecutionStatus(events) {
  if (!events || events.length === 0) return 'running';
  // Percorre do mais recente ao mais antigo
  for (let i = events.length - 1; i >= 0; i--) {
    const s = events[i].status;
    if (s === 'error') return 'error';
    if (s === 'ignored') return 'ignored';
    if (s === 'success') return 'success';
  }
  return 'running';
}

// GET /api/executions — lista execuções agrupadas por execution_id
// Filtros: ?slot=, ?from=, ?to=, ?status=error|success|running|ignored, ?limit=50
// Retorna: array de { id, slot, telefone_mascarado, started_at, duration_ms, status_final, events_count }
app.get(
  '/api/executions',
  asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const slot = req.query.slot ? String(req.query.slot) : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const statusFilter = ['error', 'success', 'running', 'ignored'].includes(req.query.status)
      ? req.query.status
      : null;

    const where = ['execution_id IS NOT NULL'];
    const vals = [];
    let idx = 1;

    if (slot) {
      where.push(`bot = $${idx++}`);
      vals.push(slot);
    }
    if (from) {
      where.push(`created_at >= $${idx++}`);
      vals.push(from);
    }
    if (to) {
      where.push(`created_at <= $${idx++}`);
      vals.push(to);
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    // Agrupa por execution_id:
    // - started_at = MIN(created_at) do grupo
    // - finished_at = MAX(created_at) do grupo
    // - duration_ms = diferença entre os dois em ms
    // - status_final: determinado pelo último evento não-null do grupo
    // - telefone_masked: primeiro valor não-null do grupo
    // - bot: slot do bot
    // - events_count: total de eventos no grupo
    const r = await pool.query(
      `SELECT
         (ARRAY_AGG(execution_id::text ORDER BY id ASC))[1] AS id,
         (ARRAY_AGG(bot ORDER BY id ASC))[1]                AS slot,
         (ARRAY_AGG(telefone_masked ORDER BY
           CASE WHEN telefone_masked IS NOT NULL THEN 0 ELSE 1 END, id ASC))[1] AS telefone_masked,
         MIN(created_at)                                     AS started_at,
         MAX(created_at)                                     AS finished_at,
         EXTRACT(EPOCH FROM (MAX(created_at) - MIN(created_at)) * 1000)::int AS duration_ms,
         COUNT(*)::int                                       AS events_count,
         (ARRAY_AGG(status ORDER BY id DESC))[1]             AS status_final
       FROM flow_execution_logs
       ${whereSql}
       GROUP BY execution_id
       ORDER BY MIN(created_at) DESC
       LIMIT $${idx}`,
      [...vals, limit],
    );

    // Aplica filtro de status_final em memória (evita subquery correlacionada pesada)
    // e mascara telefone.
    const rows = r.rows
      .filter((row) => !statusFilter || row.status_final === statusFilter)
      .map((row) => ({
        id: row.id,
        slot: row.slot,
        telefone_mascarado: maskPhone(row.telefone_masked),
        started_at: row.started_at,
        finished_at: row.finished_at,
        duration_ms: row.duration_ms ?? 0,
        status_final: row.status_final ?? 'running',
        events_count: row.events_count,
      }));

    res.json(rows);
  }),
);

// GET /api/executions/:id — detalhe de uma execução com todos os eventos
// :id = execution_id (UUID como string)
// Retorna: { id, slot, telefone_mascarado, started_at, finished_at, duration_ms,
//            status_final, events: [{ event_type, status, duration_ms, message, created_at }] }
app.get(
  '/api/executions/:id',
  asyncHandler(async (req, res) => {
    const execId = String(req.params.id);
    // Valida formato UUID básico (evita SQL injection mesmo com query parametrizada)
    if (!/^[0-9a-f-]{8,64}$/i.test(execId)) {
      return res.status(400).json({ error: 'execution_id inválido' });
    }

    const r = await pool.query(
      `SELECT id::text, execution_id::text, flow_id, flow_name, bot,
              telefone_masked, session, event_type, status,
              message, metadata, duration_ms, error_summary, created_at
       FROM flow_execution_logs
       WHERE execution_id::text = $1
       ORDER BY id ASC`,
      [execId],
    );

    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'execução não encontrada' });
    }

    const events = r.rows;
    const first = events[0];
    const last = events[events.length - 1];
    const startedAt = first.created_at;
    const finishedAt = last.created_at;
    const durationMs =
      finishedAt && startedAt
        ? Math.round((new Date(finishedAt) - new Date(startedAt)))
        : null;
    const statusFinal = resolveExecutionStatus(events);

    // Trunca payload de metadata para não explodir a resposta (máx 500 chars por evento)
    const eventsOut = events.map((e) => {
      let payloadStr = null;
      if (e.metadata && typeof e.metadata === 'object' && Object.keys(e.metadata).length > 0) {
        payloadStr = JSON.stringify(e.metadata).slice(0, 500);
      }
      return {
        id: Number(e.id),
        event_type: e.event_type,
        status: e.status,
        message: e.message ?? null,
        error_summary: e.error_summary ?? null,
        duration_ms: e.duration_ms ?? null,
        payload: payloadStr,
        created_at: e.created_at,
      };
    });

    res.json({
      id: execId,
      slot: first.bot,
      flow_id: first.flow_id,
      flow_name: first.flow_name,
      session: first.session,
      telefone_mascarado: maskPhone(first.telefone_masked),
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: durationMs,
      status_final: statusFinal,
      events: eventsOut,
    });
  }),
);

// ---------- DATABASE BROWSER ----------
app.get('/api/database/projects', async (req, res) => {
  try {
    const dbOnline = await isDatabaseOnline();
    const [projects, controls] = dbOnline
      ? await Promise.all([loadProjectDatabases(), getFlowControlMap()])
      : [DEFAULT_PROJECT_DATABASES.map(normalizeProjectDatabase), new Map()];
    const rows = await Promise.all(
      projects.map(async (project) => {
        const tableKeys = getProjectTableKeys(project);
        const tables = dbOnline
          ? await Promise.all(tableKeys.map(async (key) => summarizeProjectTable(project, key)))
          : tableKeys.map((key) => summarizeUnavailableProjectTable(project, key));
        const active = controls.get(project.workflow_id)?.active ?? true;
        return {
          ...project,
          active,
          tables,
          totals: tables.reduce(
            (acc, table) => {
              acc.rows += Number(table.rows || 0);
              acc.sessions += Number(table.sessions || 0);
              if (table.available) acc.available_tables += 1;
              return acc;
            },
            { rows: 0, sessions: 0, available_tables: 0 },
          ),
        };
      }),
    );
    res.json({ projects: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/database/projects/:projectId/tables/:tableKey', async (req, res) => {
  try {
    const project = (await loadProjectDatabases()).find(
      (p) => p.project_id === req.params.projectId,
    );
    if (!project) return res.status(404).json({ error: 'projeto nao encontrado' });
    if (!getProjectTableKeys(project).includes(req.params.tableKey)) {
      return res.status(404).json({ error: 'tabela nao pertence ao projeto' });
    }

    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    const result = await loadProjectTableRows(project, req.params.tableKey, limit);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function loadProjectDatabases() {
  try {
    const r = await pool.query(
      `SELECT project_id, display_name, workflow_id, slot, source, memory_table,
              status, metadata, created_at, updated_at
       FROM project_databases
       ORDER BY display_name`,
    );
    return r.rows.map(normalizeProjectDatabase);
  } catch (e) {
    if (isRecoverableDbError(e)) return DEFAULT_PROJECT_DATABASES.map(normalizeProjectDatabase);
    throw e;
  }
}

function normalizeProjectDatabase(row) {
  return {
    project_id: row.project_id,
    display_name: row.display_name,
    workflow_id: row.workflow_id,
    slot: row.slot,
    source: row.source || 'ts',
    memory_table: row.memory_table,
    status: row.status || 'active',
    metadata: row.metadata || {},
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
}

function getProjectTableKeys(project) {
  const keys = Array.isArray(project.metadata?.tables) ? project.metadata.tables : [];
  return keys.filter((key) => DATABASE_TABLES[key]);
}

async function summarizeProjectTable(project, key) {
  const plan = getProjectTablePlan(project, key);
  const base = {
    key,
    label: DATABASE_TABLES[key].label,
    type: DATABASE_TABLES[key].type,
    table_name: plan.tableName,
    rows: 0,
    sessions: 0,
    last_id: null,
    last_at: null,
    available: true,
  };

  try {
    const r = await pool.query(plan.countSql, plan.countVals);
    const row = r.rows[0] || {};
    return {
      ...base,
      rows: Number(row.rows || 0),
      sessions: Number(row.sessions || 0),
      last_id: row.last_id || null,
      last_at: row.last_at || null,
    };
  } catch (e) {
    if (isRecoverableDbError(e)) return { ...base, available: false };
    throw e;
  }
}

async function loadProjectTableRows(project, key, limit) {
  if (!(await isDatabaseOnline())) {
    const summary = summarizeUnavailableProjectTable(project, key);
    return { project, table: summary, rows: [], limit };
  }
  const plan = getProjectTablePlan(project, key);
  const summary = await summarizeProjectTable(project, key);
  if (!summary.available) {
    return { project, table: summary, rows: [], limit };
  }

  const r = await pool.query(plan.rowsSql, [...plan.rowsVals, limit]);
  return { project, table: summary, rows: r.rows, limit };
}

function summarizeUnavailableProjectTable(project, key) {
  const plan = getProjectTablePlan(project, key);
  return {
    key,
    label: DATABASE_TABLES[key].label,
    type: DATABASE_TABLES[key].type,
    table_name: plan.tableName,
    rows: 0,
    sessions: 0,
    last_id: null,
    last_at: null,
    available: false,
  };
}

function getProjectTablePlan(project, key) {
  switch (key) {
    case 'chat_memory': {
      const table = safeTableName(project.memory_table);
      return {
        tableName: table,
        countSql: `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT session_id)::int AS sessions, MAX(id)::text AS last_id FROM ${table}`,
        countVals: [],
        rowsSql: `SELECT id, session_id, message FROM ${table} ORDER BY id DESC LIMIT $1`,
        rowsVals: [],
      };
    }
    case 'routing':
      return {
        tableName: 'routing_clientes',
        countSql:
          'SELECT COUNT(*)::int AS rows, MAX(atualizado_em) AS last_at FROM routing_clientes WHERE workflow_id = $1',
        countVals: [project.workflow_id],
        rowsSql:
          'SELECT id, telefone, nome_cliente, workflow_id, workflow_name, ativo, criado_em, atualizado_em FROM routing_clientes WHERE workflow_id = $1 ORDER BY atualizado_em DESC LIMIT $2',
        rowsVals: [project.workflow_id],
      };
    case 'flow_pauses':
      return {
        tableName: 'flow_pauses',
        countSql:
          'SELECT COUNT(*)::int AS rows, MAX(updated_at) AS last_at FROM flow_pauses WHERE flow_id = $1 AND active = TRUE',
        countVals: [project.workflow_id],
        rowsSql:
          'SELECT flow_id, flow_name, telefone, session, active, source, reason, created_at, updated_at FROM flow_pauses WHERE flow_id = $1 AND active = TRUE ORDER BY updated_at DESC LIMIT $2',
        rowsVals: [project.workflow_id],
      };
    case 'flow_pause_keywords':
      return {
        tableName: 'flow_pause_keywords',
        countSql:
          'SELECT COUNT(*)::int AS rows, MAX(updated_at) AS last_at FROM flow_pause_keywords WHERE flow_id = $1',
        countVals: [project.workflow_id],
        rowsSql:
          'SELECT flow_id, command, keyword, keyword_norm, enabled, created_at, updated_at FROM flow_pause_keywords WHERE flow_id = $1 ORDER BY command, keyword LIMIT $2',
        rowsVals: [project.workflow_id],
      };
    case 'bot_prompt':
      return {
        tableName: 'bot_prompt',
        countSql:
          'SELECT COUNT(*)::int AS rows, MAX(updated_at) AS last_at FROM bot_prompt WHERE slot = $1',
        countVals: [project.slot],
        rowsSql:
          'SELECT slot, prompt, updated_at FROM bot_prompt WHERE slot = $1 ORDER BY updated_at DESC LIMIT $2',
        rowsVals: [project.slot],
      };
    case 'bot_media':
      return {
        tableName: 'bot_media',
        countSql:
          'SELECT COUNT(*)::int AS rows, MAX(updated_at) AS last_at FROM bot_media WHERE slot = $1',
        countVals: [project.slot],
        rowsSql:
          'SELECT id, slot, position, media_type, url, caption, context, position_order, enabled, updated_at FROM bot_media WHERE slot = $1 ORDER BY position_order, id LIMIT $2',
        rowsVals: [project.slot],
      };
    case 'model_usage':
      return {
        tableName: 'model_usage',
        countSql:
          'SELECT COUNT(*)::int AS rows, MAX(created_at) AS last_at FROM model_usage WHERE slot = $1',
        countVals: [project.slot],
        rowsSql:
          'SELECT id, slot, provider, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, telefone, created_at FROM model_usage WHERE slot = $1 ORDER BY id DESC LIMIT $2',
        rowsVals: [project.slot],
      };
    case 'flow_logs':
      // Filtra por bot (slot) que é o campo indexado e mais preciso.
      // workflow_id nem sempre coincide com o valor gravado em flow_id para clones.
      return {
        tableName: 'flow_execution_logs',
        countSql:
          'SELECT COUNT(*)::int AS rows, MAX(created_at) AS last_at FROM flow_execution_logs WHERE bot = $1',
        countVals: [project.slot],
        rowsSql:
          'SELECT id::text, execution_id::text, flow_id, flow_name, bot, telefone_masked, session, event_type, status, message, metadata, duration_ms, error_summary, created_at FROM flow_execution_logs WHERE bot = $1 ORDER BY id DESC LIMIT $2',
        rowsVals: [project.slot],
      };
    case 'agendamento_pendente':
      return directProjectTablePlan('agendamento_pendente');
    case 'leads_ricardo':
      return directProjectTablePlan('leads_ricardo');
    case 'leads_vendas_barbearia':
      return directProjectTablePlan('leads_vendas_barbearia');
    case 'pause_startap':
      return directProjectTablePlan('pause_startap');
    default:
      throw new Error('tabela invalida');
  }
}

function directProjectTablePlan(tableName) {
  const table = safeTableName(tableName);
  return {
    tableName: table,
    countSql: `SELECT COUNT(*)::int AS rows FROM ${table}`,
    countVals: [],
    rowsSql: `SELECT * FROM ${table} ORDER BY 1 DESC LIMIT $1`,
    rowsVals: [],
  };
}

function normalizePauseKeywordPayload(body) {
  // Aceita três formatos:
  // 1. { keywords: [{ command, keyword, enabled? }, ...] }
  // 2. { pause: string[], resume: string[] }              — matching o output do GET
  // 3. { pauseKeywords: "linha\nlinha", resumeKeywords: "..." }  — legado
  let rows;
  if (Array.isArray(body?.keywords)) {
    rows = body.keywords;
  } else if (Array.isArray(body?.pause) || Array.isArray(body?.resume)) {
    rows = [
      ...(Array.isArray(body.pause) ? body.pause : []).map((keyword) => ({ command: 'pause', keyword })),
      ...(Array.isArray(body.resume) ? body.resume : []).map((keyword) => ({ command: 'resume', keyword })),
    ];
  } else {
    rows = [
      ...String(body?.pauseKeywords || '')
        .split(/\r?\n/)
        .map((keyword) => ({ command: 'pause', keyword })),
      ...String(body?.resumeKeywords || '')
        .split(/\r?\n/)
        .map((keyword) => ({ command: 'resume', keyword })),
    ];
  }
  const seen = new Set();
  const normalized = [];
  for (const row of rows) {
    const command = row.command === 'resume' ? 'resume' : 'pause';
    const keyword = String(row.keyword || '').trim();
    if (!keyword) continue;
    const keyword_norm = normalizePauseKeyword(keyword);
    if (!keyword_norm) continue;
    const key = `${command}:${keyword_norm}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      command,
      keyword,
      keyword_norm,
      enabled: row.enabled !== false,
    });
  }
  return normalized;
}

function normalizePauseKeyword(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, '');
}

function safeTableName(tableName) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) throw new Error('nome de tabela invalido');
  return tableName;
}

async function isDatabaseOnline() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (e) {
    if (isRecoverableDbError(e)) return false;
    throw e;
  }
}

function isRecoverableDbError(e) {
  const message = String(e?.message || '');
  return (
    ['42P01', '42703', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT'].includes(e?.code) ||
    /connection terminated|connection timeout|getaddrinfo|econnrefused|etimedout/i.test(message)
  );
}

function normalizeFlowLogRow(row) {
  return {
    ...row,
    id: Number(row.id),
    metadata: row.metadata || {},
  };
}

function buildFlowLogFilters(query, options = {}) {
  const status = FLOW_LOG_STATUSES.has(query.status) ? query.status : null;
  const flowId = query.flow_id ? String(query.flow_id) : null;
  const eventType = query.event_type ? String(query.event_type) : null;
  const bot = query.bot ? String(query.bot) : null;
  const session = query.session ? String(query.session) : null;
  const executionId = query.execution_id ? String(query.execution_id) : null;
  const q = query.q ? String(query.q).trim() : null;
  const hours = Math.max(1, Math.min(24 * 14, Number(query.hours) || 24));
  const where = [`created_at > NOW() - ($1 || ' hours')::INTERVAL`];
  const vals = [String(hours)];
  let i = 2;

  if (status && !options.ignoreStatus) {
    where.push(`status = $${i++}`);
    vals.push(status);
  }
  if (flowId) {
    where.push(`flow_id = $${i++}`);
    vals.push(flowId);
  }
  if (eventType) {
    where.push(`event_type = $${i++}`);
    vals.push(eventType);
  }
  if (bot) {
    where.push(`bot = $${i++}`);
    vals.push(bot);
  }
  if (session) {
    where.push(`session = $${i++}`);
    vals.push(session);
  }
  if (executionId) {
    where.push(`execution_id::text = $${i++}`);
    vals.push(executionId);
  }
  if (q) {
    where.push(
      `(telefone_masked ILIKE $${i} OR message ILIKE $${i} OR flow_name ILIKE $${i} OR event_type ILIKE $${i} OR execution_id::text ILIKE $${i})`,
    );
    vals.push(`%${q}%`);
    i++;
  }

  return { where, vals, nextIndex: i };
}

// ---------- LEADS & RELATORIOS ----------
app.get('/api/leads', async (req, res) => {
  try {
    const slot =
      typeof req.query.slot === 'string' && req.query.slot.trim() ? req.query.slot.trim() : null;

    const rawLimit = Number.parseInt(req.query.limit, 10);
    const rawOffset = Number.parseInt(req.query.offset, 10);
    // Garante valores seguros sem expor input do usuário no SQL — usa parâmetros
    const limit = !isNaN(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
    const offset = !isNaN(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    let rows = [];
    let total = 0;
    if (slot) {
      // UNION ALL no SQL garante ORDER BY/LIMIT/OFFSET globais — sem merge em memória.
      // leads_ricardo tem 'interesse' (sem 'mensagem_inicial') e não tem coluna 'origem'.
      // Aliases normalizam para os nomes que o frontend já consome.
      const [rData, rCount] = await Promise.all([
        pool.query(
          `SELECT id::text, nome, telefone, interesse AS mensagem_inicial, NULL::text AS origem, criado_em, slot,
                  'leads_ricardo'::text AS _table
             FROM leads_ricardo WHERE slot = $1
           UNION ALL
           SELECT id::text, nome, telefone, mensagem_inicial, origem, criado_em, slot,
                  'leads_vendas_barbearia'::text AS _table
             FROM leads_vendas_barbearia WHERE slot = $1
           ORDER BY criado_em DESC
           LIMIT $2 OFFSET $3`,
          [slot, limit, offset],
        ),
        pool.query(
          `SELECT (SELECT COUNT(*)::int FROM leads_ricardo WHERE slot = $1)
                + (SELECT COUNT(*)::int FROM leads_vendas_barbearia WHERE slot = $1) AS n`,
          [slot],
        ),
      ]);
      rows = rData.rows;
      total = rCount.rows[0]?.n ?? 0;
    } else {
      // UNION ALL no SQL garante ORDER BY/LIMIT/OFFSET globais — sem merge em memória.
      // leads_ricardo tem 'interesse' (sem 'mensagem_inicial') e não tem coluna 'origem'.
      // Aliases normalizam para os nomes que o frontend já consome.
      const [rData, rCount] = await Promise.all([
        pool.query(
          `SELECT id::text, nome, telefone, interesse AS mensagem_inicial, NULL::text AS origem, criado_em, slot,
                  'leads_ricardo'::text AS _table
             FROM leads_ricardo
           UNION ALL
           SELECT id::text, nome, telefone, mensagem_inicial, origem, criado_em, slot,
                  'leads_vendas_barbearia'::text AS _table
             FROM leads_vendas_barbearia
           ORDER BY criado_em DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        pool.query(
          `SELECT (SELECT COUNT(*)::int FROM leads_ricardo)
                + (SELECT COUNT(*)::int FROM leads_vendas_barbearia) AS n`,
        ),
      ]);
      rows = rData.rows;
      total = rCount.rows[0]?.n ?? 0;
    }

    // Mantém array no body pra retrocompat com front; metadados de paginação vão no header
    res.setHeader('X-Total-Count', total);
    res.setHeader('X-Limit', limit);
    res.setHeader('X-Offset', offset);
    res.json(rows);
  } catch (err) {
    console.error('[painel] GET /api/leads ->', err.message);
    res.status(500).json({ error: 'falha ao carregar leads', detail: err.message });
  }
});

app.get('/api/agendamentos-pendentes', async (req, res) => {
  try {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const rawOffset = Number.parseInt(req.query.offset, 10);
    const limit = !isNaN(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 50;
    const offset = !isNaN(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    const [r, c] = await Promise.all([
      pool.query('SELECT * FROM agendamento_pendente ORDER BY 1 DESC LIMIT $1 OFFSET $2', [
        limit,
        offset,
      ]),
      pool.query('SELECT COUNT(*)::int AS n FROM agendamento_pendente'),
    ]);

    res.setHeader('X-Total-Count', c.rows[0]?.n ?? 0);
    res.setHeader('X-Limit', limit);
    res.setHeader('X-Offset', offset);
    res.json(r.rows);
  } catch (err) {
    console.error('[painel] GET /api/agendamentos-pendentes ->', err.message);
    res
      .status(500)
      .json({ error: 'falha ao carregar agendamentos pendentes', detail: err.message });
  }
});

app.get('/api/message-stats', async (req, res) => {
  // Lê de flow_execution_logs (event_type='bot.reply-sent') porque message_log
  // é zerada a cada hora pelo limpar_historicos.sh (uso anti-bot). flow_execution_logs
  // preserva 14+ dias e tem índice idx_flow_logs_created.
  // webhook.received inclui session.status e outros eventos não-mensagem; bot.reply-sent
  // reflete apenas respostas reais enviadas ao usuário.
  try {
    const r = await pool.query(`
      SELECT DATE(created_at AT TIME ZONE 'America/Sao_Paulo') AS dia, COUNT(*) AS total
      FROM flow_execution_logs
      WHERE event_type = 'bot.reply-sent'
        AND created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1 DESC
    `);
    res.json(r.rows);
  } catch {
    res.json([]);
  }
});

// ---------- METRICS (003-I) ----------

/**
 * Retorna um intervalo de datas ISO a partir do query param period (24h|7d|30d).
 * Default: 24h.
 */
function parsePeriodInterval(period) {
  if (period === '7d') return '7 days';
  if (period === '30d') return '30 days';
  return '1 day'; // default 24h
}

/**
 * Granularidade automática: hora para 24h, dia para 7d/30d.
 */
function periodTrunc(period) {
  return period === '24h' || !period ? 'hour' : 'day';
}

app.get('/api/metrics/by-bot', async (req, res) => {
  try {
    const period = ['24h', '7d', '30d'].includes(req.query.period) ? req.query.period : '24h';
    const interval = parsePeriodInterval(period);

    // execuções e latência vêm de flow_execution_logs (bot, status, duration_ms)
    // tokens/custo vêm de model_usage (slot)
    // bot_config fornece display_name; LEFT JOIN pois pode haver bots sem config
    const r = await pool.query(
      `
      WITH exec_stats AS (
        SELECT
          bot AS slot,
          -- denominador: só eventos 'bot.finished' representam execuções completas
          COUNT(*) FILTER (WHERE event_type = 'bot.finished')::int  AS executions,
          -- numerador: execuções finalizadas com status success
          COUNT(*) FILTER (WHERE event_type = 'bot.finished' AND status = 'success')::int AS success_count,
          ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS avg_latency_ms,
          -- mensagens: bot.reply-sent ocorre após roteamento, reflete respostas reais
          COUNT(*) FILTER (WHERE event_type = 'bot.reply-sent')::int AS messages
        FROM flow_execution_logs
        WHERE created_at > NOW() - ($1::text || ' day')::INTERVAL
          AND bot IS NOT NULL
        GROUP BY bot
      ),
      usage_stats AS (
        SELECT
          slot,
          SUM(prompt_tokens)::int      AS tokens_in,
          SUM(completion_tokens)::int  AS tokens_out,
          ROUND(SUM(cost_usd)::numeric, 6) AS cost_usd
        FROM model_usage
        WHERE created_at > NOW() - ($1::text || ' day')::INTERVAL
        GROUP BY slot
      )
      SELECT
        COALESCE(e.slot, u.slot)                AS slot,
        COALESCE(bc.display_name, e.slot, u.slot) AS display_name,
        COALESCE(e.messages, 0)                 AS messages,
        COALESCE(e.executions, 0)               AS executions,
        CASE
          WHEN COALESCE(e.executions, 0) = 0 THEN NULL
          ELSE ROUND((e.success_count::numeric / e.executions) * 100, 1)
        END                                     AS success_rate,
        e.avg_latency_ms,
        COALESCE(u.tokens_in, 0)               AS tokens_in,
        COALESCE(u.tokens_out, 0)              AS tokens_out,
        COALESCE(u.cost_usd, 0)               AS cost_usd
      FROM exec_stats e
      FULL OUTER JOIN usage_stats u ON e.slot = u.slot
      LEFT JOIN bot_config bc ON COALESCE(e.slot, u.slot) = bc.slot
      ORDER BY COALESCE(e.executions, 0) DESC
      `,
      // interval multiplier: parsePeriodInterval retorna "1 day"/"7 days"/"30 days"
      // usamos só o número aqui para evitar cast duplo
      [interval === '1 day' ? '1' : interval === '7 days' ? '7' : '30'],
    );
    res.json({ period, rows: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/metrics/timeseries', async (req, res) => {
  try {
    const period = ['24h', '7d', '30d'].includes(req.query.period) ? req.query.period : '24h';
    const metric = ['messages', 'cost', 'latency', 'success_rate'].includes(req.query.metric)
      ? req.query.metric
      : 'messages';
    const botParam = req.query.bot && req.query.bot !== 'all' ? req.query.bot : null;
    const trunc = periodTrunc(period);
    const days = period === '24h' ? '1' : period === '7d' ? '7' : '30';
    // DEBT: criar índice em flow_execution_logs(bot) quando volume crescer
    // (hoje seq scan na coluna; volume atual é baixo, sem impacto perceptível)
    const botFilter = botParam ? 'AND bot = $2' : '';
    const params = botParam ? [days, botParam] : [days];

    let sql;
    if (metric === 'messages') {
      // bot.reply-sent = respostas reais enviadas; webhook.received incluía session.status
      // e outros eventos não-mensagem que inflavam o gráfico (bug Missao 013 B2).
      sql = `
        SELECT DATE_TRUNC(${trunc === 'hour' ? "'hour'" : "'day'"}, created_at) AS t,
               COUNT(*)::int AS value
        FROM flow_execution_logs
        WHERE event_type = 'bot.reply-sent'
          AND created_at > NOW() - ($1::text || ' day')::INTERVAL
          ${botFilter}
        GROUP BY 1 ORDER BY 1
      `;
    } else if (metric === 'cost') {
      const botCol = botParam ? 'AND slot = $2' : '';
      const p2 = botParam ? [days, botParam] : [days];
      const r2 = await pool.query(
        `
        SELECT DATE_TRUNC(${trunc === 'hour' ? "'hour'" : "'day'"}, created_at) AS t,
               ROUND(SUM(cost_usd)::numeric, 6) AS value
        FROM model_usage
        WHERE created_at > NOW() - ($1::text || ' day')::INTERVAL
          ${botCol}
        GROUP BY 1 ORDER BY 1
        `,
        p2,
      );
      return res.json({ period, metric, bot: req.query.bot || 'all', points: r2.rows });
    } else if (metric === 'latency') {
      sql = `
        SELECT DATE_TRUNC(${trunc === 'hour' ? "'hour'" : "'day'"}, created_at) AS t,
               ROUND(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL))::int AS value
        FROM flow_execution_logs
        WHERE created_at > NOW() - ($1::text || ' day')::INTERVAL
          ${botFilter}
        GROUP BY 1 ORDER BY 1
      `;
    } else {
      // success_rate
      sql = `
        SELECT DATE_TRUNC(${trunc === 'hour' ? "'hour'" : "'day'"}, created_at) AS t,
               ROUND(
                 COUNT(*) FILTER (WHERE status = 'success')::numeric / NULLIF(COUNT(*), 0) * 100,
                 1
               ) AS value
        FROM flow_execution_logs
        WHERE created_at > NOW() - ($1::text || ' day')::INTERVAL
          ${botFilter}
        GROUP BY 1 ORDER BY 1
      `;
    }
    const r = await pool.query(sql, params);
    res.json({ period, metric, bot: req.query.bot || 'all', points: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/metrics/top-errors', async (req, res) => {
  try {
    const period = ['24h', '7d', '30d'].includes(req.query.period) ? req.query.period : '24h';
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    const days = period === '24h' ? '1' : period === '7d' ? '7' : '30';
    const r = await pool.query(
      `
      SELECT
        error_summary                             AS error_message,
        COUNT(*)::int                             AS count,
        MAX(created_at)                           AS last_seen,
        (ARRAY_AGG(bot ORDER BY created_at DESC))[1] AS sample_bot
      FROM flow_execution_logs
      WHERE status = 'error'
        AND error_summary IS NOT NULL
        AND error_summary <> ''
        AND created_at > NOW() - ($1::text || ' day')::INTERVAL
      GROUP BY error_summary
      ORDER BY COUNT(*) DESC
      LIMIT $2
      `,
      [days, limit],
    );
    res.json({ period, rows: r.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- CLEANUP STATUS ----------
// Nota: cleanup_log era a tabela do n8n (legado). O worker TS (startap-worker) escreve em
// flow_execution_logs com flow_id='worker:cleanup-chat' e event_type='worker.job-finished'.
// A tabela cleanup_log parou de ser atualizada em 2026-05-15 quando o n8n foi aposentado.
app.get('/api/cleanup/status', async (req, res) => {
  try {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setMinutes(0, 0, 0);
    nextRun.setHours(nextRun.getHours() + 1);

    // Lê último job-finished do worker TS (substitui cleanup_log do n8n legado).
    const [lastRunRes, tablesRes] = await Promise.all([
      pool
        .query(
          `SELECT created_at AS last_run, metadata
           FROM flow_execution_logs
           WHERE flow_id = 'worker:cleanup-chat'
             AND event_type = 'worker.job-finished'
             AND status = 'success'
           ORDER BY id DESC LIMIT 1`,
        )
        .catch(() => ({ rows: [] })),
      pool
        .query('SELECT table_name, description FROM cleanup_historicos ORDER BY table_name')
        .catch(() => ({ rows: [] })),
    ]);

    const lastRow = lastRunRes.rows[0] || null;
    const meta = lastRow?.metadata || {};
    res.json({
      last_run: lastRow?.last_run || null,
      last_tables_cleaned: meta.tables ?? 0,
      last_total_deleted: meta.total_deleted ?? 0,
      next_run: nextRun.toISOString(),
      cron: '0 * * * *',
      interval_minutes: 60,
      source: 'flow_execution_logs', // indica que usa worker TS, não n8n legado
      tables: tablesRes.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- DEFAULTS POR MATRIZ AO CRIAR CLONE ----------
// Quando um clone novo nasce, ja vem com horarios e servicos pre-cadastrados
// para a matriz correspondente. Cliente edita pelo painel quando precisar.
// Evita que o bot diga "Nenhum servico cadastrado" logo apos a criacao.

const _CLONE_DEFAULTS_BARBEARIA = {
  horarios_funcionamento: {
    segunda: { abre: null, fecha: null, fechado: true },
    terca: { abre: '09:00', fecha: '18:00', fechado: false },
    quarta: { abre: '09:00', fecha: '18:00', fechado: false },
    quinta: { abre: '09:00', fecha: '18:00', fechado: false },
    sexta: { abre: '09:00', fecha: '18:00', fechado: false },
    sabado: { abre: '09:00', fecha: '18:00', fechado: false },
    domingo: { abre: null, fecha: null, fechado: true },
  },
  servicos: [
    { nome: 'Corte', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Barba', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Sobrancelha', preco_cents: 5000, duracao_min: 30 },
    { nome: 'Pezinho', preco_cents: 5000, duracao_min: 30 },
  ],
};

/**
 * Defaults para clone novo. Hierarquia:
 *   1) bot_config.horarios_funcionamento + bot_config.servicos da MATRIZ
 *      (admin edita pelo painel — fonte de verdade quando preenchida).
 *   2) Hardcoded por matriz (_CLONE_DEFAULTS_BARBEARIA para teste_barbearia).
 *   3) null/null (outras matrizes — clone nasce com abas em branco).
 *
 * Async porque consulta bot_config. Callers precisam awaitar.
 */
async function getCloneDefaults(matrizSlot) {
  try {
    const r = await pool.query(
      `SELECT horarios_funcionamento, servicos FROM bot_config WHERE slot = $1`,
      [matrizSlot],
    );
    const row = r.rows[0];
    if (row && (row.horarios_funcionamento || row.servicos)) {
      // Falha parcial (so um dos campos): completa com hardcoded da matriz.
      const fallback = matrizSlot === 'teste_barbearia'
        ? _CLONE_DEFAULTS_BARBEARIA
        : { horarios_funcionamento: null, servicos: null };
      return {
        horarios_funcionamento: row.horarios_funcionamento ?? fallback.horarios_funcionamento,
        servicos: row.servicos ?? fallback.servicos,
      };
    }
  } catch (e) {
    console.warn(`[getCloneDefaults] falha ao ler bot_config da matriz: ${e.message}`);
  }
  if (matrizSlot === 'teste_barbearia') return _CLONE_DEFAULTS_BARBEARIA;
  return { horarios_funcionamento: null, servicos: null };
}

// ---------- RENDER DE PROMPT POR CLONE ----------
// Helpers para gerar blocos {{horarios_funcionamento_render}} e {{servicos_precos_render}}
// a partir dos jsonbs flow_clones.horarios_funcionamento e flow_clones.servicos.
// Mantemos PT-BR e formato espelhando o prompt legado da matriz teste_barbearia.

const _DIAS_SEMANA = [
  ['segunda',  'Segunda'],
  ['terca',    'Terca'],
  ['quarta',   'Quarta'],
  ['quinta',   'Quinta'],
  ['sexta',    'Sexta'],
  ['sabado',   'Sabado'],
  ['domingo',  'Domingo'],
];

function renderHorariosFuncionamento(horarios) {
  if (!horarios || typeof horarios !== 'object') return 'Nao configurado.';
  const linhas = [];
  for (const [key, label] of _DIAS_SEMANA) {
    const dia = horarios[key];
    if (!dia || dia.fechado) {
      linhas.push(`${label}: fechado`);
    } else if (dia.abre && dia.fecha) {
      linhas.push(`${label}: ${dia.abre} as ${dia.fecha}`);
    } else {
      linhas.push(`${label}: nao configurado`);
    }
  }
  return linhas.join('\n');
}

function renderServicosPrecos(servicos) {
  if (!Array.isArray(servicos) || servicos.length === 0) return 'Nenhum servico cadastrado.';
  return servicos
    .filter((s) => s && typeof s === 'object' && s.nome)
    .map((s) => {
      const nome = String(s.nome).trim();
      const preco = Number(s.preco_cents);
      const dur = Number(s.duracao_min);
      const precoStr = Number.isFinite(preco) && preco > 0
        ? `R$${(preco / 100).toFixed(2).replace('.', ',')}`
        : 'a combinar';
      const durStr = Number.isFinite(dur) && dur > 0 ? `${dur} min` : 'duracao a combinar';
      return `${nome}: ${precoStr} (${durStr})`;
    })
    .join('\n') || 'Nenhum servico cadastrado.';
}

/**
 * Aplica os 3 grupos de placeholders {{double_brace}} sobre o template da matriz:
 *  - personalizacao: { nome_negocio, endereco, instagram, ... }
 *  - horarios:       jsonb com chaves segunda..domingo
 *  - servicos:       array [{ nome, preco_cents, duracao_min }]
 *
 * Placeholders nao resolvidos sao preservados (formato {{key}}) para nao perder
 * dado em caso de campo ausente.
 */
function renderClonePrompt(matrizPrompt, personalizacao, horarios, servicos) {
  const pers = personalizacao && typeof personalizacao === 'object' ? personalizacao : {};
  const ctx = {
    ...pers,
    horarios_funcionamento_render: renderHorariosFuncionamento(horarios),
    servicos_precos_render: renderServicosPrecos(servicos),
  };
  let out = matrizPrompt.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k] ?? '') : `{{${k}}}`,
  );
  if (pers['cliente_nome']) {
    out = out.replace(/\[Ricardo\]/g, `[${pers['cliente_nome']}]`);
  }
  return out;
}

/**
 * Re-renderiza o prompt do clone com base no estado atual de flow_clones e
 * sobrescreve bot_prompt do slot do clone. Idempotente. Usa o prompt da MATRIZ
 * como template (nao o prompt previamente salvo do clone), porque queremos que
 * mudancas estruturais na matriz se propaguem para clones quando o usuario
 * mexer em personalizacao/horarios/servicos.
 *
 * Retorna { ok: true, prompt } ou { ok: false, error }.
 */
async function regerarPromptClone(cloneRow) {
  try {
    const matrizPrompt = await pool.query(`SELECT prompt FROM bot_prompt WHERE slot = $1`, [
      cloneRow.matriz_slot,
    ]);
    if (!matrizPrompt.rows[0]) {
      return { ok: false, error: `Matriz ${cloneRow.matriz_slot} sem prompt em bot_prompt` };
    }
    const prompt = renderClonePrompt(
      matrizPrompt.rows[0].prompt,
      cloneRow.personalizacao,
      cloneRow.horarios_funcionamento,
      cloneRow.servicos,
    );
    await pool.query(
      `INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()`,
      [cloneRow.slot, prompt],
    );
    return { ok: true, prompt };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- CLONES DE FLUXO MATRIZ ----------

// GET /api/clones — lista todos os clones
app.get('/api/clones', async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome,
             fc.cliente_telefone, fc.personalizacao, fc.waha_sessao, fc.status,
             fc.horarios_funcionamento, fc.servicos,
             fc.created_at, fc.updated_at,
             bc.display_name AS matriz_display_name
      FROM flow_clones fc
      LEFT JOIN bot_config bc ON bc.slot = fc.matriz_slot
      ORDER BY fc.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clones — cria clone
app.post('/api/clones', async (req, res) => {
  const { matriz_slot, display_name, cliente_nome, cliente_telefone, personalizacao } =
    req.body ?? {};
  if (!matriz_slot || typeof matriz_slot !== 'string') {
    return res.status(400).json({ error: 'matriz_slot obrigatório' });
  }
  if (!display_name || typeof display_name !== 'string') {
    return res.status(400).json({ error: 'display_name obrigatório' });
  }

  // Gera slug único
  const slug = `clone_${display_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, 40)}_${Math.random().toString(36).slice(2, 8)}`;
  const pers = personalizacao && typeof personalizacao === 'object' ? personalizacao : {};

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Valida matriz
    const cfgR = await client.query(
      `SELECT provider, model, temperature FROM bot_config WHERE slot = $1`,
      [matriz_slot],
    );
    if (!cfgR.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `matriz_slot "${matriz_slot}" não encontrado` });
    }
    const { provider, model, temperature } = cfgR.rows[0];

    // Insere bot_config do clone
    await client.query(
      `INSERT INTO bot_config (slot, display_name, provider, model, temperature, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, NOW())`,
      [slug, display_name, provider, model, temperature],
    );

    // Copia e personaliza bot_prompt
    const promptR = await client.query(`SELECT prompt FROM bot_prompt WHERE slot = $1`, [
      matriz_slot,
    ]);
    if (promptR.rows[0]) {
      let prompt = promptR.rows[0].prompt;
      prompt = prompt.replace(/\{\{(\w+)\}\}/g, (_, k) => pers[k] ?? `{{${k}}}`);
      if (pers['cliente_nome'])
        prompt = prompt.replace(/\[Ricardo\]/g, `[${pers['cliente_nome']}]`);
      await client.query(
        `INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())`,
        [slug, prompt],
      );
    }

    // Copia bot_media (inclui course_slug e is_course_intro para preservar vínculos de curso)
    const mediaR = await client.query(
      `SELECT position, media_type, url, caption, context, position_order, enabled,
              course_slug, is_course_intro
       FROM bot_media WHERE slot = $1`,
      [matriz_slot],
    );
    for (const m of mediaR.rows) {
      await client.query(
        `INSERT INTO bot_media
           (slot, position, media_type, url, caption, context, position_order, enabled,
            course_slug, is_course_intro, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          slug,
          m.position,
          m.media_type,
          m.url,
          m.caption,
          m.context,
          m.position_order,
          m.enabled,
          m.course_slug ?? null,
          m.is_course_intro ?? false,
        ],
      );
    }

    // Copia bot_courses (catálogo de cursos da matriz para o clone)
    const coursesR = await client.query(
      `SELECT course_slug, name, description, price, duration, position_order, enabled, details_for_llm
       FROM bot_courses WHERE slot = $1`,
      [matriz_slot],
    );
    for (const c of coursesR.rows) {
      await client.query(
        `INSERT INTO bot_courses
           (slot, course_slug, name, description, price, duration, position_order, enabled, details_for_llm, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
         ON CONFLICT (slot, course_slug) DO NOTHING`,
        [
          slug,
          c.course_slug,
          c.name,
          c.description,
          c.price,
          c.duration,
          c.position_order,
          c.enabled,
          c.details_for_llm ?? null,
        ],
      );
    }

    // flow_controls
    await client.query(
      `INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at)
       VALUES ($1, $2, 'clone', TRUE, NOW())
       ON CONFLICT (flow_id) DO UPDATE SET active = TRUE, updated_at = NOW()`,
      [slug, display_name],
    );

    // flow_clones — popula horarios e servicos default conforme a matriz.
    const defaults = await getCloneDefaults(matriz_slot);
    const cloneR = await client.query(
      `INSERT INTO flow_clones
         (slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
          personalizacao, horarios_funcionamento, servicos,
          status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,'rascunho',NOW(),NOW())
       RETURNING *`,
      [
        slug,
        matriz_slot,
        display_name,
        cliente_nome ?? null,
        cliente_telefone ?? null,
        JSON.stringify(pers),
        defaults.horarios_funcionamento ? JSON.stringify(defaults.horarios_funcionamento) : null,
        defaults.servicos ? JSON.stringify(defaults.servicos) : null,
      ],
    );

    await client.query('COMMIT');

    // Re-renderiza bot_prompt do clone aplicando defaults + personalizacao.
    // Sem isso o prompt fica com {{horarios_funcionamento_render}} literal.
    const rendered = await regerarPromptClone(cloneR.rows[0]);
    if (!rendered.ok) {
      console.warn(`[POST /api/clones] regerarPromptClone falhou: ${rendered.error}`);
    }
    res.status(201).json(cloneR.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ---------- CLONES COM WAHA ----------

const MATRIZES_ROUTAVEIS = ['teste_barbearia', 'teste_vendas', 'teste_vendas_barbearia'];

/**
 * Deriva o nome da sessão WAHA a partir do slot do clone.
 * WAHA aceita apenas [a-zA-Z0-9_-], então substitui hífens por underscores
 * e prefixa com "clone_" para namespacing.
 */
function wahaSessionName(slot) {
  return `clone_${slot.replace(/-/g, '_')}`;
}

/**
 * Cria sessão WAHA com webhook configurado. Retorna { ok, status, error }.
 * Nunca lança — encapsula falha pra o caller decidir.
 */
async function createWahaSession(name) {
  try {
    const webhookUrl = TS_WEBHOOK_URL;
    const r = await fetch(`${WAHA_URL}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: JSON.stringify({
        name,
        start: true,
        // events MUST include 'message.any' — engine NOWEB do WAHA so manda
        // audio/video/imagem sob 'message.any', nao 'message' (que so cobre
        // texto). Sem isso o bot fica surdo pra audio. Bruno 2026-05-21.
        config: { webhooks: [{ url: webhookUrl, events: ['message', 'message.any', 'session.status'] }] },
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = body?.message ?? body?.error ?? `HTTP ${r.status}`;
      return { ok: false, status: 'failed', error: `WAHA: ${msg}` };
    }
    return { ok: true, status: body?.status ?? 'STARTING', error: undefined };
  } catch (e) {
    return { ok: false, status: 'failed', error: `Falha ao contatar WAHA: ${e.message}` };
  }
}

// POST /api/clones/with-waha — orquestra clone + sessão WAHA em único request.
// Clone sempre fica em 'rascunho'. Transição para 'active' via POST /api/clones/:id/activate
// quando UI confirmar QR scan (implementado em 005-D).
app.post('/api/clones/with-waha', async (req, res) => {
  const { matriz_slot, novo_slot, display_name, telefone_contato, personalizacao } = req.body ?? {};

  // --- validações ---
  if (!matriz_slot || typeof matriz_slot !== 'string' || !MATRIZES_ROUTAVEIS.includes(matriz_slot))
    return res
      .status(400)
      .json({ error: `matriz_slot inválido. Valores aceitos: ${MATRIZES_ROUTAVEIS.join(', ')}` });

  if (!novo_slot || typeof novo_slot !== 'string' || !/^[a-z0-9-]{3,50}$/.test(novo_slot))
    return res
      .status(400)
      .json({ error: 'novo_slot obrigatório: lowercase, hífens e números, 3-50 chars' });

  if (
    !display_name ||
    typeof display_name !== 'string' ||
    display_name.trim().length === 0 ||
    display_name.length > 100
  )
    return res.status(400).json({ error: 'display_name obrigatório (1-100 chars)' });

  // verifica unicidade do slot em bot_config e flow_clones
  let bcCheck, fcCheck;
  try {
    [bcCheck, fcCheck] = await Promise.all([
      pool.query('SELECT 1 FROM bot_config WHERE slot = $1', [novo_slot]),
      pool.query('SELECT 1 FROM flow_clones WHERE slot = $1', [novo_slot]),
    ]);
  } catch (e) {
    return res.status(500).json({ error: `clones/with-waha: unicidade: ${e.message}` });
  }

  if (bcCheck.rows.length > 0 || fcCheck.rows.length > 0)
    return res.status(409).json({ error: `slot "${novo_slot}" já existe` });

  const pers =
    personalizacao && typeof personalizacao === 'object' && !Array.isArray(personalizacao)
      ? personalizacao
      : {};

  // --- 1. Cria clone via transação ---
  const cloneClient = await pool.connect();
  let cloneRow;
  try {
    await cloneClient.query('BEGIN');

    const cfgR = await cloneClient.query(
      'SELECT provider, model, temperature FROM bot_config WHERE slot = $1',
      [matriz_slot],
    );
    if (!cfgR.rows[0]) {
      await cloneClient.query('ROLLBACK');
      return res
        .status(400)
        .json({ error: `matriz_slot "${matriz_slot}" não encontrado em bot_config` });
    }
    const { provider, model, temperature } = cfgR.rows[0];

    // Campos de bot_config podem ser sobrescritos por personalizacao
    const finalProvider = pers.provider ?? provider;
    const finalModel = pers.model ?? model;
    const finalTemperature = pers.temperature ?? temperature;

    await cloneClient.query(
      `INSERT INTO bot_config (slot, display_name, provider, model, temperature, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, NOW())`,
      [novo_slot, display_name, finalProvider, finalModel, finalTemperature],
    );

    const promptR = await cloneClient.query('SELECT prompt FROM bot_prompt WHERE slot = $1', [
      matriz_slot,
    ]);
    if (promptR.rows[0]) {
      let prompt = promptR.rows[0].prompt;
      prompt = prompt.replace(/\{\{(\w+)\}\}/g, (_, k) => pers[k] ?? `{{${k}}}`);
      if (pers['cliente_nome'])
        prompt = prompt.replace(/\[Ricardo\]/g, `[${pers['cliente_nome']}]`);
      await cloneClient.query(
        'INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())',
        [novo_slot, prompt],
      );
    }

    // bot_media herdado da matriz (inclui course_slug e is_course_intro)
    const mediaR = await cloneClient.query(
      `SELECT position, media_type, url, caption, context, position_order, enabled,
              course_slug, is_course_intro
       FROM bot_media WHERE slot = $1`,
      [matriz_slot],
    );
    for (const m of mediaR.rows) {
      await cloneClient.query(
        `INSERT INTO bot_media
           (slot, position, media_type, url, caption, context, position_order, enabled,
            course_slug, is_course_intro, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
        [
          novo_slot,
          m.position,
          m.media_type,
          m.url,
          m.caption,
          m.context,
          m.position_order,
          m.enabled,
          m.course_slug ?? null,
          m.is_course_intro ?? false,
        ],
      );
    }

    // Copia bot_courses (catálogo de cursos da matriz para o clone)
    const coursesR = await cloneClient.query(
      `SELECT course_slug, name, description, price, duration, position_order, enabled, details_for_llm
       FROM bot_courses WHERE slot = $1`,
      [matriz_slot],
    );
    for (const c of coursesR.rows) {
      await cloneClient.query(
        `INSERT INTO bot_courses
           (slot, course_slug, name, description, price, duration, position_order, enabled, details_for_llm, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
         ON CONFLICT (slot, course_slug) DO NOTHING`,
        [
          novo_slot,
          c.course_slug,
          c.name,
          c.description,
          c.price,
          c.duration,
          c.position_order,
          c.enabled,
          c.details_for_llm ?? null,
        ],
      );
    }

    await cloneClient.query(
      `INSERT INTO flow_controls (flow_id, flow_name, source, active, updated_at)
       VALUES ($1, $2, 'clone', TRUE, NOW())
       ON CONFLICT (flow_id) DO UPDATE SET active = TRUE, updated_at = NOW()`,
      [novo_slot, display_name],
    );

    // Defaults de horarios/servicos conforme a matriz (memoria: clone novo
    // ja sai oferecendo servicos comuns, evita "Nenhum servico cadastrado").
    const defaults = await getCloneDefaults(matriz_slot);
    const cloneR = await cloneClient.query(
      `INSERT INTO flow_clones
         (slot, matriz_slot, display_name, cliente_nome, cliente_telefone,
          personalizacao, horarios_funcionamento, servicos,
          status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, 'rascunho', NOW(), NOW())
       RETURNING *`,
      [
        novo_slot,
        matriz_slot,
        display_name,
        null,
        telefone_contato ?? null,
        JSON.stringify(pers),
        defaults.horarios_funcionamento ? JSON.stringify(defaults.horarios_funcionamento) : null,
        defaults.servicos ? JSON.stringify(defaults.servicos) : null,
      ],
    );

    await cloneClient.query('COMMIT');
    cloneRow = cloneR.rows[0];
  } catch (e) {
    await cloneClient.query('ROLLBACK');
    console.error(`[clones/with-waha] falha ao criar clone: ${e.message}`);
    return res.status(500).json({ error: `clones/with-waha: ${e.message}` });
  } finally {
    cloneClient.release();
  }

  // Re-renderiza bot_prompt aplicando horarios+servicos default e personalizacao.
  // Roda fora da transacao porque flow_clones ja foi commitado e
  // regerarPromptClone faz seu proprio UPSERT em bot_prompt (idempotente).
  const renderedPrompt = await regerarPromptClone(cloneRow);
  if (!renderedPrompt.ok) {
    console.warn(`[clones/with-waha] regerarPromptClone falhou: ${renderedPrompt.error}`);
  }

  // --- 2. Cria sessão WAHA (falha não reverte o clone — decisão Bruno 005-B) ---
  const sessaoName = wahaSessionName(novo_slot);
  const waha = await createWahaSession(sessaoName);

  if (!waha.ok) {
    console.warn(
      `[clones/with-waha] clone ${novo_slot} (id=${cloneRow.id}) criado mas WAHA falhou: ${waha.error}`,
    );
    return res.json({
      clone_id: cloneRow.id,
      novo_slot,
      waha_session_name: sessaoName,
      waha_status: 'failed',
      waha_error: waha.error,
      clone_status: 'rascunho',
    });
  }

  // --- 3. Vincula sessão ao clone ---
  // Espelha o nome em bot_config.waha_sessao tambem — sem isso /api/bots
  // resolve slot como nome de sessao WAHA (404) e mostra status furado
  // (memoria mapping_slot_waha_sessao).
  await Promise.all([
    pool
      .query(
        `UPDATE flow_clones SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW() WHERE id = $2`,
        [sessaoName, cloneRow.id],
      )
      .catch((e) => console.error(`[clones/with-waha] falha ao vincular sessão no DB: ${e.message}`)),
    pool
      .query(
        `UPDATE bot_config SET waha_sessao = $1, updated_at = NOW() WHERE slot = $2`,
        [sessaoName, cloneRow.slot],
      )
      .catch((e) => console.error(`[clones/with-waha] falha ao espelhar waha_sessao em bot_config: ${e.message}`)),
  ]);

  console.log(
    `[clones/with-waha] clone ${novo_slot} (id=${cloneRow.id}) criado, sessão WAHA ${sessaoName} iniciada`,
  );

  res.json({
    clone_id: cloneRow.id,
    novo_slot,
    waha_session_name: sessaoName,
    waha_status: waha.status,
    clone_status: 'rascunho',
  });
});

// POST /api/clones/:id/retry-waha — retenta sessão WAHA para clone em rascunho.
// Usado quando WAHA falhou na criação original (005-B). 502 se falhar de novo.
app.post('/api/clones/:id/retry-waha', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  let cloneRow;
  try {
    const r = await pool.query(
      'SELECT id, slot, status, waha_sessao FROM flow_clones WHERE id = $1',
      [id],
    );
    cloneRow = r.rows[0];
  } catch (e) {
    return res.status(500).json({ error: `retry-waha: DB: ${e.message}` });
  }

  if (!cloneRow) return res.status(404).json({ error: 'Clone não encontrado' });
  if (cloneRow.status !== 'rascunho')
    return res.status(409).json({
      error: `Clone em status "${cloneRow.status}"; retry-waha só permitido para rascunho`,
    });

  const sessaoName = cloneRow.waha_sessao ?? wahaSessionName(cloneRow.slot);
  const waha = await createWahaSession(sessaoName);

  if (!waha.ok) {
    console.warn(`[retry-waha] clone ${cloneRow.slot} (id=${id}) falhou de novo: ${waha.error}`);
    return res.status(502).json({ error: waha.error });
  }

  // Espelha em bot_config.waha_sessao tambem (memoria mapping_slot_waha_sessao).
  await Promise.all([
    pool
      .query(
        `UPDATE flow_clones SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW() WHERE id = $2`,
        [sessaoName, id],
      )
      .catch((e) => console.error(`[retry-waha] falha ao vincular sessão no DB: ${e.message}`)),
    pool
      .query(
        `UPDATE bot_config SET waha_sessao = $1, updated_at = NOW() WHERE slot = $2`,
        [sessaoName, cloneRow.slot],
      )
      .catch((e) => console.error(`[retry-waha] falha ao espelhar waha_sessao em bot_config: ${e.message}`)),
  ]);

  console.log(`[retry-waha] clone ${cloneRow.slot} (id=${id}) sessão WAHA ${sessaoName} iniciada`);
  res.json({ waha_session_name: sessaoName, waha_status: waha.status });
});

// GET /api/clones/:id
app.get('/api/clones/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await pool.query(
      `SELECT fc.*, bc.display_name AS matriz_display_name
       FROM flow_clones fc
       LEFT JOIN bot_config bc ON bc.slot = fc.matriz_slot
       WHERE fc.id = $1`,
      [id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/clones/:id
app.patch('/api/clones/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  const {
    display_name,
    cliente_nome,
    cliente_telefone,
    personalizacao,
    horarios_funcionamento,
    servicos,
    status: newStatus,
  } = req.body ?? {};

  // Validacao leve dos novos campos.
  if (horarios_funcionamento !== undefined) {
    if (!horarios_funcionamento || typeof horarios_funcionamento !== 'object' || Array.isArray(horarios_funcionamento)) {
      return res.status(400).json({ error: 'horarios_funcionamento deve ser objeto' });
    }
  }
  if (servicos !== undefined) {
    if (!Array.isArray(servicos)) {
      return res.status(400).json({ error: 'servicos deve ser array' });
    }
    for (const s of servicos) {
      if (!s || typeof s !== 'object' || !s.nome) {
        return res.status(400).json({ error: 'cada servico precisa de { nome }' });
      }
    }
  }

  const sets = [];
  const vals = [];
  let i = 1;

  if (display_name !== undefined) {
    sets.push(`display_name = $${i++}`);
    vals.push(display_name);
  }
  if (cliente_nome !== undefined) {
    sets.push(`cliente_nome = $${i++}`);
    vals.push(cliente_nome);
  }
  if (cliente_telefone !== undefined) {
    sets.push(`cliente_telefone = $${i++}`);
    vals.push(cliente_telefone);
  }
  if (personalizacao !== undefined) {
    sets.push(`personalizacao = $${i++}::jsonb`);
    vals.push(JSON.stringify(personalizacao));
  }
  if (horarios_funcionamento !== undefined) {
    sets.push(`horarios_funcionamento = $${i++}::jsonb`);
    vals.push(JSON.stringify(horarios_funcionamento));
  }
  if (servicos !== undefined) {
    sets.push(`servicos = $${i++}::jsonb`);
    vals.push(JSON.stringify(servicos));
  }
  if (newStatus !== undefined) {
    sets.push(`status = $${i++}`);
    vals.push(newStatus);
  }

  if (sets.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar' });
  sets.push('updated_at = NOW()');
  vals.push(id);

  try {
    const r = await pool.query(
      `UPDATE flow_clones SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      vals,
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });

    // NAO regera prompt automaticamente. Bruno 2026-05-21: depois das Missoes
    // 024/025, horarios+servicos+personalizacao sao lidos de flow_clones em
    // runtime via buildContextBlock — bot_prompt do clone contem APENAS
    // persona+regras+fluxo+cartao (parte editavel pelo painel). Auto-regerar
    // aqui atropelava edicoes manuais do prompt feitas pelo usuario na aba
    // Prompt do modal (bug: salvava prompt, mexia em horarios, refresh
    // mostrava prompt revertido pra matriz). Quem quiser ressincronizar da
    // matriz usa o botao "Regerar Prompt" -> POST /api/clones/:id/regerar-prompt.

    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clones/:id/regerar-prompt — re-renderiza bot_prompt do clone a partir
// da matriz e do estado atual de personalizacao/horarios/servicos. Idempotente.
// Util quando o template da matriz muda e o cliente quer "ressincronizar".
app.post('/api/clones/:id/regerar-prompt', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await pool.query('SELECT * FROM flow_clones WHERE id = $1', [id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    const result = await regerarPromptClone(r.rows[0]);
    if (!result.ok) return res.status(500).json({ error: result.error });
    res.json({ ok: true, slot: r.rows[0].slot, length: result.prompt.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/clones/:id
app.delete('/api/clones/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const existing = await pool.query(`SELECT slot, waha_sessao FROM flow_clones WHERE id = $1`, [
      id,
    ]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    const { slot: cloneSlot, waha_sessao } = existing.rows[0];

    // Tenta logout WAHA se tinha sessão vinculada (erro não bloqueia delete)
    if (waha_sessao) {
      await fetch(`${WAHA_URL}/api/sessions/${waha_sessao}/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
        },
      }).catch(() => {});
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Remove todos os dados do clone na mesma transação para evitar órfãos
      await client.query(`DELETE FROM flow_clones WHERE id = $1`, [id]);
      await client.query(`DELETE FROM flow_controls WHERE flow_id = $1`, [cloneSlot]);
      await client.query(`DELETE FROM bot_prompt WHERE slot = $1`, [cloneSlot]);
      await client.query(`DELETE FROM bot_media WHERE slot = $1`, [cloneSlot]);
      await client.query(`DELETE FROM bot_courses WHERE slot = $1`, [cloneSlot]).catch(() => {});
      await client.query(`DELETE FROM bot_config WHERE slot = $1`, [cloneSlot]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ ok: true, slot: cloneSlot });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/clones/:id/bind-session — vincula sessão WAHA ao clone
app.post('/api/clones/:id/bind-session', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  const { sessao_name, telefone } = req.body ?? {};
  if (!sessao_name || typeof sessao_name !== 'string') {
    return res.status(400).json({ error: 'sessao_name obrigatório' });
  }
  try {
    const r = await pool.query(
      `UPDATE flow_clones SET waha_sessao = $1, status = 'aguardando_qr', updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [sessao_name, id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });

    // Espelha em bot_config.waha_sessao tambem (memoria mapping_slot_waha_sessao).
    await pool
      .query(
        `UPDATE bot_config SET waha_sessao = $1, updated_at = NOW() WHERE slot = $2`,
        [sessao_name, r.rows[0].slot],
      )
      .catch((e) =>
        console.error(`[bind-session] falha ao espelhar waha_sessao em bot_config: ${e.message}`),
      );

    // telefone é apenas informativo: atualiza cliente_telefone no clone, sem tocar routing_clientes.
    // Roteamento de clones é feito por sessão WAHA (waha_sessao), não por telefone do cliente final.
    if (telefone && typeof telefone === 'string') {
      await pool.query(
        `UPDATE flow_clones SET cliente_telefone = $1, updated_at = NOW() WHERE id = $2`,
        [telefone, id],
      );
    }

    console.log(
      `[bind-session] Sessão ${r.rows[0].waha_sessao} vinculada ao clone ${r.rows[0].slot} (routing por sessão)`,
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- GOOGLE CALENDAR POR CLONE ----------

// PUT /api/clones/:id/gcal — grava credenciais Service Account
app.put('/api/clones/:id/gcal', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  const { credentials_json, calendar_id } = req.body ?? {};
  if (!credentials_json || typeof credentials_json !== 'string') {
    return res.status(400).json({ error: 'credentials_json obrigatório' });
  }
  if (!calendar_id || typeof calendar_id !== 'string') {
    return res.status(400).json({ error: 'calendar_id obrigatório' });
  }

  let parsed;
  try {
    parsed = JSON.parse(credentials_json);
  } catch {
    return res.status(400).json({ error: 'credentials_json: JSON malformado' });
  }
  if (parsed.type !== 'service_account') {
    return res.status(400).json({ error: 'credentials_json: deve ser do tipo service_account' });
  }

  const clientEmail = parsed.client_email ?? null;
  // Loga apenas o client_email — nunca a chave privada
  console.log(`[gcal] PUT clone ${id}: client_email=${clientEmail}`);

  try {
    const r = await pool.query(
      `UPDATE flow_clones
          SET gcal_credentials_json = $1,
              gcal_client_email     = $2,
              gcal_calendar_id      = $3,
              gcal_status           = 'pending',
              gcal_connected_at     = NULL,
              gcal_last_check_at    = NULL,
              updated_at            = NOW()
        WHERE id = $4
        RETURNING id, slot, gcal_client_email, gcal_calendar_id, gcal_status`,
      [encryptGcalCredentials(credentials_json), clientEmail, calendar_id.trim(), id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clones/:id/gcal/status — retorna metadados sem expor o JSON
app.get('/api/clones/:id/gcal/status', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  try {
    const r = await pool.query(
      `SELECT gcal_client_email, gcal_calendar_id, gcal_status, gcal_connected_at, gcal_last_check_at
         FROM flow_clones WHERE id = $1`,
      [id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/clones/:id/gcal — remove credenciais
app.delete('/api/clones/:id/gcal', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  try {
    const r = await pool.query(
      `UPDATE flow_clones
          SET gcal_credentials_json = NULL,
              gcal_client_email     = NULL,
              gcal_calendar_id      = NULL,
              gcal_status           = NULL,
              gcal_connected_at     = NULL,
              gcal_last_check_at    = NULL,
              updated_at            = NOW()
        WHERE id = $1
        RETURNING id`,
      [id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    console.log(`[gcal] DELETE clone ${id}: credenciais removidas`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Helper: traduz erros crus do Google Calendar em hints acionáveis pro painel.
// Detecta os 3 casos mais comuns que travam clientes novos.
function enrichGcalError(rawError, credentialsJson) {
  if (!rawError) return null;
  const msg = String(rawError);
  // Extrai numeric_project_id do JSON da SA quando possível, pra montar link direto.
  let projectId = null;
  try {
    const parsed = typeof credentialsJson === 'string' ? JSON.parse(credentialsJson) : credentialsJson;
    if (parsed && parsed.project_id) projectId = parsed.project_id;
  } catch { /* ignore */ }
  const enableLink = projectId
    ? `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${encodeURIComponent(projectId)}`
    : 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com';

  if (/accessNotConfigured|SERVICE_DISABLED|Calendar API has not been used/i.test(msg)) {
    return {
      code: 'API_DISABLED',
      hint: `A Google Calendar API está DESABILITADA no projeto do cliente${projectId ? ` (${projectId})` : ''}. Habilite aqui: ${enableLink} — espere ~1min e teste de novo.`,
      link: enableLink,
    };
  }
  if (/Not Found|notFound|HTTP 404|calendar.*not.*found/i.test(msg)) {
    return {
      code: 'CALENDAR_NOT_SHARED',
      hint: 'A agenda não foi compartilhada com o client_email da Service Account. Vá em calendar.google.com → Configurações da agenda → Compartilhar com pessoas e grupos → cole o client_email com permissão "Fazer alterações em eventos".',
      link: 'https://calendar.google.com',
    };
  }
  if (/invalid_grant|invalid.{0,5}credentials|unauthorized_client/i.test(msg)) {
    return {
      code: 'INVALID_JSON',
      hint: 'JSON inválido ou expirado. Gere uma nova chave em IAM → Contas de serviço → sua SA → Chaves → Adicionar chave (JSON).',
      link: 'https://console.cloud.google.com/iam-admin/serviceaccounts',
    };
  }
  if (/403|Forbidden|insufficient/i.test(msg)) {
    return {
      code: 'INSUFFICIENT_PERMISSIONS',
      hint: 'Permissões insuficientes. Verifique se a Service Account foi compartilhada com permissão "Fazer alterações em eventos" (não basta "Ver detalhes").',
      link: 'https://calendar.google.com',
    };
  }
  return null;
}

// POST /api/clones/:id/gcal/test — testa conexão e atualiza status
app.post('/api/clones/:id/gcal/test', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  try {
    const r = await pool.query(
      `SELECT gcal_credentials_json, gcal_calendar_id, gcal_client_email FROM flow_clones WHERE id = $1`,
      [id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });

    const { gcal_credentials_json, gcal_calendar_id, gcal_client_email } = r.rows[0];
    if (!gcal_credentials_json || !gcal_calendar_id) {
      return res.status(400).json({ error: 'Credenciais não configuradas' });
    }

    // Import dinâmico para evitar dependência circular no painel-admin legado
    // O client.ts compila para packages/integrations/dist/
    let testResult;
    try {
      const { GoogleCalendarClient } = await import(
        '../packages/integrations/dist/google-calendar/client.js'
      );
      const client = new GoogleCalendarClient({
        credentialsJson: decryptGcalCredentials(gcal_credentials_json),
        calendarId: gcal_calendar_id,
      });
      testResult = await client.testConnection();
    } catch (importErr) {
      testResult = { ok: false, error: `Falha ao carregar cliente GCal: ${importErr.message}` };
    }

    const newStatus = testResult.ok ? 'active' : 'invalid';
    console.log(`[gcal] TEST clone ${id} (${gcal_client_email}): ${newStatus}`);

    await pool.query(
      `UPDATE flow_clones
          SET gcal_status        = $1,
              gcal_last_check_at = NOW(),
              gcal_connected_at  = CASE WHEN $1 = 'active' AND gcal_connected_at IS NULL THEN NOW() ELSE gcal_connected_at END,
              updated_at         = NOW()
        WHERE id = $2`,
      [newStatus, id],
    );

    const enriched = testResult.ok ? null : enrichGcalError(testResult.error, decryptGcalCredentials(gcal_credentials_json));
    res.json({
      ok: testResult.ok,
      status: newStatus,
      error: testResult.ok ? undefined : testResult.error,
      errorCode: enriched?.code,
      errorHint: enriched?.hint,
      errorLink: enriched?.link,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/clones/:id/model — altera modelo de IA do clone
app.put('/api/clones/:id/model', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  const { model } = req.body ?? {};
  if (!model || !MODEL_ALLOWLIST.includes(model)) {
    return res.status(400).json({ error: 'modelo inválido', allowlist: MODEL_ALLOWLIST });
  }
  try {
    const prev = await pool.query(
      `SELECT slot, model, status FROM flow_clones WHERE id = $1`,
      [id],
    );
    if (!prev.rows[0]) return res.status(404).json({ error: 'clone não encontrado' });
    if (prev.rows[0].status !== 'active') {
      return res.status(409).json({ error: 'clone não está ativo', status: prev.rows[0].status });
    }
    const { slot, model: from } = prev.rows[0];
    // Atualiza em flow_clones e espelha em bot_config para consistência com runtime do bot
    await pool.query(`UPDATE flow_clones SET model = $1, updated_at = NOW() WHERE id = $2`, [model, id]);
    await pool.query(`UPDATE bot_config SET model = $1, updated_at = NOW() WHERE slot = $2`, [model, slot]);
    console.log(`[modelChange] clone=${id} slot=${slot} from=${from} to=${model}`);
    const updated = await pool.query(`SELECT * FROM flow_clones WHERE id = $1`, [id]);
    res.json(updated.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- GOOGLE CALENDAR POR MATRIZ (bot_config) ----------

// PUT /api/bots/:slot/gcal — grava credenciais Service Account na matriz
app.put('/api/bots/:slot/gcal', async (req, res) => {
  const { slot } = req.params;
  if (!slot || typeof slot !== 'string') return res.status(400).json({ error: 'slot inválido' });

  const { credentials_json, calendar_id } = req.body ?? {};
  if (!credentials_json || typeof credentials_json !== 'string') {
    return res.status(400).json({ error: 'credentials_json obrigatório' });
  }
  if (!calendar_id || typeof calendar_id !== 'string') {
    return res.status(400).json({ error: 'calendar_id obrigatório' });
  }

  let parsed;
  try {
    parsed = JSON.parse(credentials_json);
  } catch {
    return res.status(400).json({ error: 'credentials_json: JSON malformado' });
  }
  if (parsed.type !== 'service_account') {
    return res.status(400).json({ error: 'credentials_json: deve ser do tipo service_account' });
  }

  const clientEmail = parsed.client_email ?? null;
  // Loga apenas o client_email — nunca a chave privada
  console.log(`[gcal] PUT matriz ${slot}: client_email=${clientEmail}`);

  try {
    // Verificar que o slot existe em bot_config antes de gravar
    const exists = await pool.query(`SELECT 1 FROM bot_config WHERE slot = $1`, [slot]);
    if (!exists.rows[0]) return res.status(404).json({ error: 'Bot (slot) não encontrado' });

    const r = await pool.query(
      `UPDATE bot_config
          SET gcal_credentials_json = $1,
              gcal_client_email     = $2,
              gcal_calendar_id      = $3,
              gcal_status           = 'pending',
              gcal_connected_at     = NULL,
              gcal_last_check_at    = NULL
        WHERE slot = $4
        RETURNING slot, gcal_client_email, gcal_calendar_id, gcal_status`,
      [encryptGcalCredentials(credentials_json), clientEmail, calendar_id.trim(), slot],
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/bots/:slot/gcal/status — retorna metadados sem expor o JSON
app.get('/api/bots/:slot/gcal/status', async (req, res) => {
  const { slot } = req.params;
  if (!slot || typeof slot !== 'string') return res.status(400).json({ error: 'slot inválido' });

  try {
    const r = await pool.query(
      `SELECT gcal_status, gcal_client_email, gcal_calendar_id, gcal_connected_at, gcal_last_check_at
         FROM bot_config WHERE slot = $1`,
      [slot],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Bot (slot) não encontrado' });
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/bots/:slot/gcal — remove credenciais da matriz
app.delete('/api/bots/:slot/gcal', async (req, res) => {
  const { slot } = req.params;
  if (!slot || typeof slot !== 'string') return res.status(400).json({ error: 'slot inválido' });

  try {
    const r = await pool.query(
      `UPDATE bot_config
          SET gcal_credentials_json = NULL,
              gcal_client_email     = NULL,
              gcal_calendar_id      = NULL,
              gcal_status           = NULL,
              gcal_connected_at     = NULL,
              gcal_last_check_at    = NULL
        WHERE slot = $1
        RETURNING slot`,
      [slot],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Bot (slot) não encontrado' });
    console.log(`[gcal] DELETE matriz ${slot}: credenciais removidas`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bots/:slot/gcal/test — testa conexão SA da matriz e atualiza status
app.post('/api/bots/:slot/gcal/test', async (req, res) => {
  const { slot } = req.params;
  if (!slot || typeof slot !== 'string') return res.status(400).json({ error: 'slot inválido' });

  try {
    const r = await pool.query(
      `SELECT gcal_credentials_json, gcal_calendar_id, gcal_client_email FROM bot_config WHERE slot = $1`,
      [slot],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Bot (slot) não encontrado' });

    const { gcal_credentials_json, gcal_calendar_id, gcal_client_email } = r.rows[0];
    if (!gcal_credentials_json || !gcal_calendar_id) {
      return res.status(400).json({ error: 'Credenciais não configuradas' });
    }

    // Import dinâmico para evitar dependência circular no painel-admin legado
    let testResult;
    try {
      const { GoogleCalendarClient } = await import(
        '../packages/integrations/dist/google-calendar/client.js'
      );
      const client = new GoogleCalendarClient({
        credentialsJson: decryptGcalCredentials(gcal_credentials_json),
        calendarId: gcal_calendar_id,
      });
      testResult = await client.testConnection();
    } catch (importErr) {
      testResult = { ok: false, error: `Falha ao carregar cliente GCal: ${importErr.message}` };
    }

    const newStatus = testResult.ok ? 'active' : 'invalid';
    console.log(`[gcal] TEST matriz ${slot} (${gcal_client_email}): ${newStatus}`);

    await pool.query(
      `UPDATE bot_config
          SET gcal_status        = $1,
              gcal_last_check_at = NOW(),
              gcal_connected_at  = CASE WHEN $1 = 'active' AND gcal_connected_at IS NULL THEN NOW() ELSE gcal_connected_at END
        WHERE slot = $2`,
      [newStatus, slot],
    );

    const enriched = testResult.ok ? null : enrichGcalError(testResult.error, decryptGcalCredentials(gcal_credentials_json));
    res.json({
      ok: testResult.ok,
      status: newStatus,
      error: testResult.ok ? undefined : testResult.error,
      errorCode: enriched?.code,
      errorHint: enriched?.hint,
      errorLink: enriched?.link,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- SESSIONS WAHA ----------

// POST /api/sessions/create — REMOVIDO (criava sessão sem webhook, bot ficava surdo).
// Use POST /api/sessions que configura webhook automaticamente.

// GET /api/sessions/available — lista sessões WAHA disponíveis para vincular a um clone
// Exclui: sessões já vinculadas a clones, sessões das matrizes/sistema
// Query param opcional: ?excludeCloneId=<id> para ignorar a sessão atual do clone (ao reeditar)
const SYSTEM_SESSIONS = new Set([
  'startap',
  'teste_barbearia',
  'teste_vendas',
  'teste_vendas_barbearia',
]);

app.get('/api/sessions/available', async (req, res) => {
  try {
    const excludeCloneId = req.query.excludeCloneId ? Number(req.query.excludeCloneId) : null;

    // Busca sessões WAHA do servidor
    const wahaResp = await wahaFetch('/api/sessions').catch(() => []);
    const wahaSessions = Array.isArray(wahaResp) ? wahaResp : [];

    // Busca waha_sessao de todos os clones já vinculados
    const clonesResult = await pool.query(
      `SELECT id, waha_sessao FROM flow_clones WHERE waha_sessao IS NOT NULL`,
    );
    const boundSessions = new Set(
      clonesResult.rows
        .filter((r) => excludeCloneId === null || r.id !== excludeCloneId)
        .map((r) => r.waha_sessao),
    );

    const available = wahaSessions
      .filter((s) => !SYSTEM_SESSIONS.has(s.name) && !boundSessions.has(s.name))
      .map((s) => ({
        name: s.name,
        status: s.status,
        me: s.me?.id || null,
      }));

    res.json(available);
  } catch (e) {
    res.status(502).json({ error: `Falha ao buscar sessões: ${e.message}` });
  }
});

// POST /api/sessions/:name/start
app.post('/api/sessions/:name/start', async (req, res) => {
  const { name } = req.params;
  try {
    const r = await fetch(`${WAHA_URL}/api/sessions/${name}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: '{}',
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `WAHA: ${body?.message ?? r.status}` });
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: `Falha ao contatar WAHA: ${e.message}` });
  }
});

// POST /api/sessions/:name/stop
app.post('/api/sessions/:name/stop', async (req, res) => {
  const { name } = req.params;
  try {
    const r = await fetch(`${WAHA_URL}/api/sessions/${name}/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: '{}',
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      return res.status(502).json({ error: `WAHA: ${body?.message ?? r.status}` });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: `Falha ao contatar WAHA: ${e.message}` });
  }
});

// POST /api/sessions/:name/ensure-audio-webhook — adiciona 'message.any' aos
// events do webhook da sessao no WAHA, caso esteja faltando. Engine NOWEB so
// envia audio/video/imagem sob 'message.any'. Sessoes criadas antes da
// correcao deste bug (2026-05-21) tem apenas events:['message','session.status']
// e nunca recebiam audio. Idempotente.
app.post('/api/sessions/:name/ensure-audio-webhook', async (req, res) => {
  const { name } = req.params;
  try {
    // 1. Le config atual
    const getR = await fetch(`${WAHA_URL}/api/sessions/${name}`, {
      headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
    });
    const session = await getR.json().catch(() => null);
    if (!getR.ok || !session) {
      return res.status(502).json({ error: `WAHA GET falhou: ${getR.status}` });
    }
    const webhooks = Array.isArray(session?.config?.webhooks) ? session.config.webhooks : [];
    if (webhooks.length === 0) {
      return res.status(400).json({ error: 'Sessao sem webhooks configurados — recrie a sessao' });
    }

    // 2. Garante message.any em CADA webhook (caso haja mais de um)
    let changed = false;
    const newWebhooks = webhooks.map((w) => {
      const events = Array.isArray(w.events) ? [...w.events] : [];
      if (!events.includes('message.any')) {
        events.push('message.any');
        changed = true;
      }
      return { ...w, events };
    });

    if (!changed) {
      return res.json({ ok: true, changed: false, message: 'message.any ja presente em todos os webhooks' });
    }

    // 3. PUT no WAHA com config atualizado
    const putR = await fetch(`${WAHA_URL}/api/sessions/${name}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: JSON.stringify({ config: { ...session.config, webhooks: newWebhooks } }),
    });
    const putBody = await putR.json().catch(() => ({}));
    if (!putR.ok) {
      return res.status(502).json({ error: `WAHA PUT falhou: ${putBody?.message ?? putR.status}` });
    }
    res.json({ ok: true, changed: true, webhooks: newWebhooks });
  } catch (e) {
    res.status(502).json({ error: `Falha: ${e.message}` });
  }
});

// GET /api/sessions/:name/status — efeito colateral: atualiza clone se WORKING
app.get('/api/sessions/:name/status', async (req, res) => {
  const { name } = req.params;
  try {
    const r = await fetch(`${WAHA_URL}/api/sessions/${name}`, {
      headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: `WAHA: ${body?.message ?? r.status}` });

    // Efeito colateral controlado: se sessão WORKING, marca clone como conectado
    if (body.status === 'WORKING') {
      await pool
        .query(
          `UPDATE flow_clones SET status = 'conectado', updated_at = NOW() WHERE waha_sessao = $1 AND status != 'conectado'`,
          [name],
        )
        .catch(() => {});
    }

    res.json(body);
  } catch (e) {
    res.status(502).json({ error: `Falha ao contatar WAHA: ${e.message}` });
  }
});

// POST /api/sessions — body {name} — cria nova sessão com webhook padrão e inicia
app.post('/api/sessions', async (req, res) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name))
    return res
      .status(400)
      .json({ error: 'name obrigatório e deve conter apenas letras, números, _ e -' });
  try {
    const webhookUrl = `${TS_WEBHOOK_URL}`;
    const r = await fetch(`${WAHA_URL}/api/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: JSON.stringify({
        name,
        start: true,
        config: {
          webhooks: [{ url: webhookUrl, events: ['message', 'session.status'] }],
        },
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = body?.message ?? body?.error ?? `HTTP ${r.status}`;
      console.log(`[sessions] create ${name} -> WAHA erro: ${msg}`);
      return res
        .status(r.status >= 400 && r.status < 500 ? 400 : 502)
        .json({ error: `WAHA: ${msg}` });
    }
    console.log(`[sessions] criada sessão ${name}`);
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: `Falha ao contatar WAHA: ${e.message}` });
  }
});

// POST /api/sessions/:name/restart — stop + start sequencial
app.post('/api/sessions/:name/restart', async (req, res) => {
  const { name } = req.params;
  try {
    const stopR = await fetch(`${WAHA_URL}/api/sessions/${name}/stop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: '{}',
    });
    // Ignora erro de stop se a sessão já estava parada (404 é aceitável)
    if (!stopR.ok && stopR.status !== 404) {
      const body = await stopR.json().catch(() => ({}));
      console.log(`[sessions] restart ${name} stop -> WAHA ${stopR.status}: ${body?.message}`);
    }
    const startR = await fetch(`${WAHA_URL}/api/sessions/${name}/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: '{}',
    });
    const startBody = await startR.json().catch(() => ({}));
    if (!startR.ok) {
      const msg = startBody?.message ?? `HTTP ${startR.status}`;
      console.log(`[sessions] restart ${name} start -> WAHA erro: ${msg}`);
      return res.status(502).json({ error: `WAHA: ${msg}` });
    }
    console.log(`[sessions] sessão ${name} reiniciada`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: `Falha ao contatar WAHA: ${e.message}` });
  }
});

// DELETE /api/sessions/:name — apaga sessão completamente
app.delete('/api/sessions/:name', async (req, res) => {
  const { name } = req.params;
  try {
    const r = await fetch(`${WAHA_URL}/api/sessions/${name}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const msg = body?.message ?? `HTTP ${r.status}`;
      console.log(`[sessions] delete ${name} -> WAHA erro: ${msg}`);
      return res.status(502).json({ error: `WAHA: ${msg}` });
    }
    console.log(`[sessions] sessão ${name} deletada`);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: `Falha ao contatar WAHA: ${e.message}` });
  }
});

// GET /api/sessions/:name/qr — retorna {qr: "data:image/png;base64,..."} | {connected:true}
app.get('/api/sessions/:name/qr', async (req, res) => {
  const { name } = req.params;
  try {
    // Verifica status primeiro
    const statusR = await fetch(`${WAHA_URL}/api/sessions/${name}`, {
      headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
    });
    if (statusR.ok) {
      const st = await statusR.json().catch(() => ({}));
      if (st.status === 'WORKING') return res.json({ connected: true, qr: null });
    }

    // Tenta endpoint padrão
    const endpoints = [`/api/${name}/auth/qr`, `/api/sessions/${name}/auth/qr`];
    let qrRes = null;
    for (const ep of endpoints) {
      const r = await fetch(`${WAHA_URL}${ep}`, {
        headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
      });
      if (r.ok) {
        qrRes = r;
        break;
      }
    }
    if (!qrRes) return res.status(502).json({ error: 'Não foi possível obter QR da sessão' });

    const ct = qrRes.headers.get('content-type') ?? '';
    if (ct.includes('image/png')) {
      const buf = Buffer.from(await qrRes.arrayBuffer());
      return res.json({ qr: `data:image/png;base64,${buf.toString('base64')}`, connected: false });
    }
    const json = await qrRes.json().catch(() => ({}));
    const raw = json?.value ?? json?.imageBase64 ?? '';
    const qr = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
    res.json({ qr, connected: false });
  } catch (e) {
    res.status(502).json({ error: `Falha ao contatar WAHA: ${e.message}` });
  }
});

// POST /api/sessions/:name/pairing-code — solicita pairing code ao WAHA Plus
// Body: { phoneNumber: string } — E.164 com ou sem +
app.post('/api/sessions/:name/pairing-code', async (req, res) => {
  const { name } = req.params;
  const { phoneNumber } = req.body ?? {};

  // 1. Valida phoneNumber: mínimo 10 dígitos numéricos
  if (!phoneNumber || typeof phoneNumber !== 'string') {
    return res.status(400).json({ error: 'phoneNumber inválido' });
  }
  const digits = phoneNumber.replace(/[^\d]/g, '');
  if (digits.length < 10) {
    return res.status(400).json({ error: 'phoneNumber inválido' });
  }
  // 2. Normaliza pra E.164 com +
  const normalized = phoneNumber.trimStart().startsWith('+')
    ? phoneNumber.trim()
    : `+${digits}`;

  try {
    // 3. Checa status da sessão — deve estar em SCAN_QR_CODE.
    // Status check é obrigatório: sem confirmação do WAHA não prosseguimos.
    const statusR = await fetch(`${WAHA_URL}/api/sessions/${name}`, {
      headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
    });
    if (!statusR.ok) {
      const details = await statusR.text().catch(() => '');
      return res.status(502).json({ error: 'Falha ao verificar status da sessão no WAHA', details });
    }
    const st = await statusR.json().catch(() => ({}));
    if (st.status !== 'SCAN_QR_CODE') {
      return res.status(409).json({
        error: 'Sessão não está aguardando autenticação',
        currentStatus: st.status ?? 'UNKNOWN',
      });
    }

    // 4. Solicita pairing code ao WAHA Plus
    const codeR = await fetch(`${WAHA_URL}/api/${name}/auth/request-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: JSON.stringify({ phoneNumber: normalized }),
    });
    if (!codeR.ok) {
      const details = await codeR.text().catch(() => '');
      return res.status(codeR.status).json({ error: 'WAHA retornou erro', details });
    }

    // 5. Repassa código ao frontend
    const data = await codeR.json().catch(() => ({}));
    return res.json({ code: data.code ?? data, phoneNumber: normalized });
  } catch (e) {
    res.status(502).json({ error: `Falha ao contatar WAHA: ${e.message}` });
  }
});

// ---------- ADMIN: CLEANUP MANUAL ----------
// Lógica inline: replica runCleanupChat usando o pool local do painel.
// Mantém em sync com apps/worker/src/jobs/cleanup-chat.ts — qualquer mudança
// no job deve ser refletida aqui também.
app.post('/api/admin/cleanup/run-now', async (req, res) => {
  try {
    const keep = Math.max(1, Math.min(500, Number(req.query.keep) || 50));

    // Tabelas estáticas conhecidas
    const knownTables = [
      'chat_histories',
      'chat_histories_ricardo',
      'chat_histories_vendas_barbearia',
      'chat_histories_startap',
      'chat_histories_controle_de_pause',
      'chat_histories_controle_de_pausee',
      'chat_histories_controle_de_pauseee',
    ];

    // Tabelas dinâmicas de clones ativos
    const dynRes = await pool.query(
      `SELECT DISTINCT chat_table FROM flow_clones WHERE chat_table IS NOT NULL AND status = 'active'`,
    );
    const validTableRe = /^chat_histories(_[a-z0-9_]+)?$/;
    const dynTables = dynRes.rows.map((r) => r.chat_table).filter((t) => validTableRe.test(t));

    const allTables = [...new Set([...knownTables, ...dynTables])];
    let deleted = 0;
    const per_table = {};

    for (const table of allTables) {
      try {
        const safeTable = safeTableName(table);
        const r = await pool.query(
          `DELETE FROM ${safeTable}
           WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) AS rn
               FROM ${safeTable}
             ) ranked WHERE rn > $1
           )`,
          [keep],
        );
        const n = r.rowCount ?? 0;
        if (n > 0) {
          per_table[table] = n;
          deleted += n;
        }
      } catch (e) {
        console.warn(`[painel] cleanup/run-now: tabela ${table} ->`, e.message);
      }
    }

    console.log(`[painel] cleanup/run-now tables=${allTables.length} total_deleted=${deleted}`);
    res.json({ ok: true, deleted, tables: allTables.length, per_table });
  } catch (e) {
    console.error('[painel] cleanup/run-now ->', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'arquivo maior que o limite permitido' : err.message;
    return res.status(400).json({ error: message });
  }
  // Erros propagados por asyncHandler ou next(err): retorna 500 com a mensagem
  // ao inves de derrubar o processo. Loga no stderr pra investigacao.
  if (err) {
    console.error(`[painel] ${req.method} ${req.originalUrl} ->`, err.message);
    const status = Number(err.statusCode) || 500;
    return res.status(status).json({ error: err.message || 'erro inesperado' });
  }
  res.status(500).json({ error: 'erro inesperado' });
});

// ---------- SYNC PERIÓDICO WAHA → flow_clones.status ----------
// Roda a cada 60s pra manter status consistente mesmo sem uso ativo do painel.
// Só liga se WAHA_URL foi explicitamente configurado (evita ruído em dev local).
const WAHA_SYNC_INTERVAL_MS = 60_000;
// Status WAHA → vocabulário do DB. 'rascunho' mantém significado original de
// "clone criado mas sessão ainda não iniciada".
const WAHA_STATUS_MAP = {
  WORKING: 'conectado',
  FAILED: 'desconectado',
  STOPPED: 'desconectado',
  SCAN_QR_CODE: 'aguardando_qr',
};

let _wahaSyncing = false;

async function syncWahaStatus() {
  if (_wahaSyncing) return; // evita concurrent runs se WAHA estiver lento
  _wahaSyncing = true;
  try {
    const r = await fetch(`${WAHA_URL}/api/sessions`, {
      headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
    });
    if (!r.ok) {
      console.warn(`[waha-sync] /api/sessions retornou ${r.status} — pulando ciclo`);
      return;
    }
    const sessions = await r.json().catch(() => []);
    if (!Array.isArray(sessions)) return;

    for (const session of sessions) {
      const wahaStatus = session?.status ?? '';
      const novoStatus = WAHA_STATUS_MAP[wahaStatus];
      if (!novoStatus || !session?.name) continue;

      const upd = await pool.query(
        `UPDATE flow_clones
            SET status = $1, updated_at = NOW()
          WHERE waha_sessao = $2
            AND status IS DISTINCT FROM $1
          RETURNING id, waha_sessao, status`,
        [novoStatus, session.name],
      );

      for (const row of upd.rows) {
        // Loga transições pra auditoria via docker logs
        console.log(
          `[waha-sync] clone id=${row.id} sessao=${row.waha_sessao}: waha=${wahaStatus} → db=${novoStatus}`,
        );
      }
    }
  } catch (e) {
    console.warn('[waha-sync] falha no ciclo de sync:', e.message);
  } finally {
    _wahaSyncing = false;
  }
}

// WAHA_URL tem default 'http://waha:3000'; só inicia sync se foi sobrescrito via env
// ou se o default resolve (em prod via docker o hostname 'waha' existe).
// Checamos se a variável foi explicitamente definida no ambiente.
let _wahaIntervalHandle = null;
if (process.env.WAHA_URL) {
  _wahaIntervalHandle = setInterval(syncWahaStatus, WAHA_SYNC_INTERVAL_MS);
  console.log(`[waha-sync] periodic sync ativo (intervalo ${WAHA_SYNC_INTERVAL_MS / 1000}s)`);
}

process.on('SIGTERM', () => {
  if (_wahaIntervalHandle) clearInterval(_wahaIntervalHandle);
});


// ---------- CLEANUP STATUS ----------
app.get('/api/cleanup/status', async (req, res) => {
  try {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setMinutes(0, 0, 0);
    nextRun.setHours(nextRun.getHours() + 1);

    const [lastRunRes, tablesRes] = await Promise.all([
      pool.query('SELECT cleaned_at, tables_cleaned FROM cleanup_log ORDER BY cleaned_at DESC LIMIT 1').catch(() => ({ rows: [] })),
      pool.query('SELECT table_name, description FROM cleanup_historicos ORDER BY table_name').catch(() => ({ rows: [] })),
    ]);

    res.json({
      last_run: lastRunRes.rows[0]?.cleaned_at || null,
      last_tables_cleaned: lastRunRes.rows[0]?.tables_cleaned || 0,
      next_run: nextRun.toISOString(),
      cron: '0 * * * *',
      interval_minutes: 60,
      tables: tablesRes.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(Number(PORT), () => console.log(`Painel rodando em :${PORT}`));
