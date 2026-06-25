import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
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
  // Pepper PROPRIO de pacotes (ADR 0025 §4), distinto de TRIAL_PHONE_PEPPER. Usado SO ao
  // VENDER um pacote (hash do telefone do cliente final). Validacao LAZY no ponto de uso
  // (postmortem #247): boot NUNCA crasha sem ele — a venda de pacote e que falha com 409
  // claro. NUNCA rotacionar (HMAC deterministico; rotacao invalida todo lookup de saldo).
  PACKAGE_PHONE_PEPPER = '',
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
// MANTER OS DOIS CONSISTENTES — formato e seleção de chave devem bater 1:1.
//
// Formato: enc:<ver>:<iv>:<authTag>:<ciphertext> (base64).
//   - enc:v2: cifrado com GCAL_ENCRYPTION_KEY (chave atual)
//   - enc:v1: cifrado com a chave legada — decifrado com GCAL_ENCRYPTION_KEY_OLD
//             se definida, senão com GCAL_ENCRYPTION_KEY (estado de HOJE).
//   - sem prefixo "enc:": texto claro legado (fallback de migração).
//
// ⚠️ RETROCOMPAT (ADR 0024, AC5): no estado de HOJE (tudo enc:v1, só
// GCAL_ENCRYPTION_KEY definida, sem OLD), enc:v1 decifra com GCAL_ENCRYPTION_KEY
// — comportamento idêntico ao anterior. Rotação: docs/runbooks/rotacao-gcal-encryption-key.md
const _GCAL_PREFIX_V1 = 'enc:v1:';
const _GCAL_PREFIX_V2 = 'enc:v2:';
const _GCAL_CURRENT_PREFIX = _GCAL_PREFIX_V2;

// Carrega/valida uma chave hex de 32 bytes. required=false devolve null se ausente.
function _loadGcalKey(envName, required) {
  const hex = process.env[envName];
  if (!hex || hex.trim() === '') {
    if (!required) {
      return null;
    }
    throw new Error(`boot: ${envName} ausente — defina 32 bytes hex no .env antes de iniciar`);
  }
  const buf = Buffer.from(hex.trim(), 'hex');
  if (buf.length !== 32) {
    throw new Error(
      `boot: ${envName} deve ter 32 bytes (64 chars hex); recebido ${buf.length} bytes`,
    );
  }
  return buf;
}

// Chave atual (nova). Obrigatória.
function _getGcalKey() {
  return _loadGcalKey('GCAL_ENCRYPTION_KEY', true);
}

// Chave legada para decifrar enc:v1 durante a janela de rotação. Opcional.
function _getGcalOldKey() {
  return _loadGcalKey('GCAL_ENCRYPTION_KEY_OLD', false);
}

// Seleciona a chave de descriptografia pelo prefixo (mesma lógica do core):
//   enc:v2 → GCAL_ENCRYPTION_KEY; enc:v1 → OLD se definida, senão GCAL_ENCRYPTION_KEY.
function _getGcalDecryptionKey(prefix) {
  if (prefix === _GCAL_PREFIX_V2) {
    return _getGcalKey();
  }
  return _getGcalOldKey() ?? _getGcalKey();
}

function encryptGcalCredentials(plain) {
  const key = _getGcalKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return (
    _GCAL_CURRENT_PREFIX +
    iv.toString('base64') +
    ':' +
    authTag.toString('base64') +
    ':' +
    encrypted.toString('base64')
  );
}

function decryptGcalCredentials(stored) {
  const prefix = stored.startsWith(_GCAL_PREFIX_V2)
    ? _GCAL_PREFIX_V2
    : stored.startsWith(_GCAL_PREFIX_V1)
      ? _GCAL_PREFIX_V1
      : null;
  if (prefix === null) {
    // Dado legado em texto claro — aceitar durante janela de migração.
    return stored;
  }
  const rest = stored.slice(prefix.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error(
      `gcal: formato ${prefix.replace(/:$/, '')} inválido — esperado 3 partes após prefixo`,
    );
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const key = _getGcalDecryptionKey(prefix);
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

// ── DDI BR conservador — espelho de packages/core/src/phone.ts:ensureDddBr ───
// MANTER 1:1 com @startap/core ensureDddBr (painel é JS puro, sem build-time dep
// do core — mesmo padrão do espelho de cripto acima). O painel é o PIOR ofensor:
// gravava cliente_telefone CRU (ex.: dragon "3599247411" sem o DDI 55), e o
// request-code do WAHA falha sem o 55. Garante o DDI ANTES do INSERT/UPDATE, de
// forma CONSERVADORA: prefixa 55 em nacional sem DDI; NUNCA adiciona/remove o 9º
// dígito (preserva pagantes de 13 díg: Cirilo/Samuel). Número irrecuperável → null
// → o handler responde erro de validação (não grava lixo).
const _BR_DDD = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38',
  '41', '42', '43', '44', '45', '46', '47', '48', '49',
  '51', '53', '54', '55',
  '61', '62', '63', '64', '65', '66', '67', '68', '69',
  '71', '73', '74', '75', '77', '79',
  '81', '82', '83', '84', '85', '86', '87', '88', '89',
  '91', '92', '93', '94', '95', '96', '97', '98', '99',
]);

// Espelho de meIdToDigits: corta envelope (@dominio / :device), tira "+"/não-dígitos
// e o tronco "0" à esquerda. Retorna dígitos puros (>= 8) ou null.
function _meIdToDigits(raw) {
  if (!raw) return null;
  const base = String(raw).split('@')[0].split(':')[0];
  const digits = base.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 8 ? digits : null;
}

// Espelho de ensureDddBr. Retorna dígitos COM DDI 55 ou null se inválido/ambíguo.
function ensureDddBr(raw) {
  const digits = _meIdToDigits(raw);
  if (!digits) return null;
  if (digits.length === 10 || digits.length === 11) {
    const ddd = digits.slice(0, 2);
    if (!_BR_DDD.has(ddd)) return null;
    return `55${digits}`;
  }
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    if (!_BR_DDD.has(ddd)) return null;
    return digits;
  }
  return null;
}
// ─────────────────────────────────────────────────────────────────────────────
const TS_API_URL = process.env.TS_API_URL || 'http://startap-api:3040';
const TS_WEBHOOK_URL = process.env.TS_WEBHOOK_URL || `${TS_API_URL}/webhooks/waha`;

// P0 security #268 + spike 2026-06-11: auth do webhook WAHA em sessao NOVA criada
// pelo painel. Dois mecanismos (mesmas envs do apps/api — manter em sincronia):
//  - WAHA_WEBHOOK_HMAC_KEY (plano A): sessao nasce com webhooks[].hmac.key e o
//    WAHA assina o body de cada POST (HMAC nativo). No apps/api, HMAC configurado
//    governa SOZINHO (header estatico ignorado).
//  - WAHA_WEBHOOK_SECRET (plano B): sessao nasce com o header X-Webhook-Secret
//    via webhooks[].customHeaders. Contrato do nome do header:
//    apps/api/src/lib/webhook-auth.ts.
// Sem as envs = comportamento atual (sem auth). Sem isso aqui, sessao nova criada
// pos-ativacao levaria 401 e o bot nasceria surdo. Ativacao em prod:
// docs/runbooks/runbook-waha-webhook-auth.md. NUNCA logar os valores.
const WAHA_WEBHOOK_SECRET = process.env.WAHA_WEBHOOK_SECRET || '';
const WAHA_WEBHOOK_HMAC_KEY = process.env.WAHA_WEBHOOK_HMAC_KEY || '';

// ---------------------------------------------------------------------------
// Padrao-ouro de sessao nova (diretriz Bruno 12/06): toda sessao WAHA criada
// aqui segue EXPLICITAMENTE a config das sessoes prod comprovadas (GET real de
// `cirilobarbearia`, WAHA Plus 2026.3.2 NOWEB — evidencia 2026-06-12). Os
// valores COINCIDEM com defaults da instancia hoje, mas default implicito e
// FRAGIL (prova: trial nasceu com retries.delaySeconds=2, Cirilo tem 3). NAO
// remover achando redundante com o WAHA. Espelho EXATO das constantes de
// clone-provisioning.ts (packages/integrations) — manter em sincronia.
// ---------------------------------------------------------------------------

// Retry de entrega do webhook — igual Cirilo (attempts 15, constant 3s).
const WAHA_WEBHOOK_RETRIES = { attempts: 15, delaySeconds: 3, policy: 'constant' };
// Bot SO responde chat privado: ignora status, grupos, canais e broadcast.
const WAHA_SESSION_IGNORE = { status: true, groups: true, channels: true, broadcast: true };
// Engine NOWEB igual Cirilo: markOnline ligado, store de chats/contatos
// DESLIGADO (recent-contacts ja tem fallback via message_log p/ sessao sem store).
const WAHA_SESSION_NOWEB = { markOnline: true, store: { enabled: false, fullSync: false } };

/**
 * Monta o array `config.webhooks` padrao de uma sessao WAHA nova: url do TS api +
 * events recebidos + retries explicito (padrao Cirilo, diretriz Bruno 12/06) +
 * hmac.key (plano A) e/ou customHeaders (plano B), somente se configurados. Os
 * dois podem coexistir na sessao (o WAHA manda assinatura E header); a
 * precedencia de validacao e decidida pelo apps/api.
 */
function buildWahaWebhooks(events) {
  const webhook = { url: TS_WEBHOOK_URL, events, retries: WAHA_WEBHOOK_RETRIES };
  if (WAHA_WEBHOOK_HMAC_KEY) {
    webhook.hmac = { key: WAHA_WEBHOOK_HMAC_KEY };
  }
  if (WAHA_WEBHOOK_SECRET) {
    webhook.customHeaders = [{ name: 'X-Webhook-Secret', value: WAHA_WEBHOOK_SECRET }];
  }
  return [webhook];
}

/**
 * WahaConfig do modulo compartilhado de provisionamento (clone-provisioning).
 * Mesmas envs de auth do buildWahaWebhooks acima — sessao criada via modulo
 * compartilhado tambem nasce com hmac.key/customHeaders (P0 #268 + spike
 * 2026-06-11). Manter os DOIS caminhos em sincronia.
 */
function wahaProvisioningConfig() {
  return {
    url: WAHA_URL,
    apiKey: WAHA_API_KEY,
    webhookUrl: TS_WEBHOOK_URL,
    webhookHmacKey: WAHA_WEBHOOK_HMAC_KEY || undefined,
    webhookSecret: WAHA_WEBHOOK_SECRET || undefined,
  };
}

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
    tags: ['servicos', 'agenda'],
    description: 'Matriz genérica de atendimento de serviços com consulta de agenda e Google Calendar.',
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
};

// Mapeamento flow_id → tabela de leads (slots sem leads_table omitidos intencionalmente).
// Usado em GET /api/bots para popular leads_count sem hardcode inline.
const FLOW_LEADS_TABLE = {
  dlpKXM3gvX2joC1b: 'leads_ricardo',
};

const DEFAULT_PROJECT_DATABASES = [
  {
    project_id: 'teste_barbearia',
    display_name: 'Atendimento de Serviços',
    workflow_id: '0ni38aSspWwhooHd',
    slot: 'teste_barbearia',
    source: 'ts',
    memory_table: 'chat_histories',
    status: 'active',
    metadata: {
      category: 'teste',
      tables: [
        'chat_memory',
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
  // 'routing' removido na Missão 023 W2 (inspector da tabela routing_clientes de teste — descontinuado).
  flow_pauses: { label: 'Pausas por fluxo', type: 'operacao' },
  flow_pause_keywords: { label: 'Palavras-chave de pausa', type: 'config' },
  bot_prompt: { label: 'Prompt', type: 'config' },
  bot_media: { label: 'Midias', type: 'config' },
  model_usage: { label: 'Uso de modelo', type: 'metricas' },
  flow_logs: { label: 'Logs de fluxo', type: 'operacao' },
  agendamento_pendente: { label: 'Agendamentos pendentes', type: 'negocio' },
  leads_ricardo: { label: 'Leads Ricardo', type: 'negocio' },
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

// ── Helpers de arquivo físico de mídia ────────────────────────────────────────
// A coluna bot_media.url guarda OU um caminho local de upload nosso
// (ex.: "/uploads/1700000000-abc.png", prefixo MEDIA_PUBLIC_BASE_URL) OU uma
// URL externa (http(s)://... — WAHA, CDN). Só apagamos do disco arquivos LOCAIS
// dentro de MEDIA_STORAGE_DIR. Qualquer coisa fora dali é ignorada (anti
// path-traversal e proteção contra apagar arquivo de terceiro).
//
// IMPORTANTE: estes helpers são puros e replicados em test/media-unlink.test.js
// ("espelha a lógica em server.js — manter em sync", padrão de models.test.js).
const _MEDIA_PUBLIC_BASE = String(MEDIA_PUBLIC_BASE_URL || '/uploads').replace(/\/$/, '');

/**
 * Resolve o caminho absoluto do arquivo físico a partir de uma url de bot_media.
 * Retorna o path absoluto SOMENTE se a url for um upload local nosso e o caminho
 * resolvido estiver contido em MEDIA_STORAGE_DIR. Caso contrário retorna null
 * (url externa, prefixo diferente, ou tentativa de escapar do diretório).
 *
 * @param {string} url       valor de bot_media.url
 * @param {string} storageDir diretório base de uploads (MEDIA_STORAGE_DIR)
 * @param {string} publicBase prefixo público das urls locais (sem barra final)
 * @returns {string|null}
 */
function resolveLocalMediaPath(url, storageDir, publicBase) {
  if (!url || typeof url !== 'string') return null;
  // URL externa (http://, https://, //host) nunca é arquivo local nosso.
  if (/^([a-z][a-z0-9+.-]*:)?\/\//i.test(url)) return null;
  const prefix = `${publicBase}/`;
  if (!url.startsWith(prefix)) return null;
  // Tudo após o prefixo é o nome do arquivo (decodificado — urls são encodeURIComponent na gravação).
  let filename;
  try {
    filename = decodeURIComponent(url.slice(prefix.length));
  } catch {
    return null; // url malformada
  }
  if (!filename) return null;
  // Bloqueia separadores/escape explícitos antes mesmo de resolver.
  if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')) return null;
  const baseAbs = path.resolve(storageDir);
  const candidate = path.resolve(baseAbs, filename);
  // Confinamento: candidate precisa estar DENTRO de baseAbs.
  const rel = path.relative(baseAbs, candidate);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return candidate;
}

/**
 * Apaga o arquivo físico de uma mídia local de forma idempotente e segura.
 * - Só toca em arquivos dentro de MEDIA_STORAGE_DIR (via resolveLocalMediaPath).
 * - ENOENT é tratado como sucesso (arquivo já não existe).
 * - Qualquer outra falha de FS é logada e NÃO propaga (a remoção lógica no banco
 *   já aconteceu; um erro de disco não deve derrubar o request).
 * @param {string} url valor de bot_media.url
 * @returns {Promise<'deleted'|'skipped'|'missing'|'error'>}
 */
async function unlinkLocalMedia(url) {
  const abs = resolveLocalMediaPath(url, MEDIA_STORAGE_DIR, _MEDIA_PUBLIC_BASE);
  if (!abs) return 'skipped'; // url externa ou fora do storage — nada a fazer
  try {
    await fs.promises.unlink(abs);
    return 'deleted';
  } catch (e) {
    if (e && e.code === 'ENOENT') return 'missing';
    console.error('[media-unlink]', JSON.stringify({ at: 'unlinkLocalMedia', code: e?.code, msg: e?.message }));
    return 'error';
  }
}

/**
 * Calcula órfãos: arquivos presentes no disco que NÃO estão no conjunto de
 * nomes referenciados pelo banco. Puro/sem I/O para ser testável.
 * @param {string[]} filesOnDisk    nomes de arquivo (basename) presentes em uploads/
 * @param {Set<string>} referenced  basenames referenciados por bot_media (locais)
 * @returns {string[]} basenames órfãos
 */
function computeOrphans(filesOnDisk, referenced) {
  return filesOnDisk.filter((name) => !referenced.has(name));
}

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
  // Fontes locais (.woff2) servidas de public/fonts/ são assets decorativos não
  // sensíveis. A página /login.html é PÚBLICA (pré-sessão) e referencia essas
  // fontes; sem esta liberação o browser receberia 401 ao buscá-las e o login
  // cairia no fallback system-ui. Confinado a GET /fonts/ — nada mais é liberado.
  if (req.method === 'GET' && req.path.startsWith('/fonts/')) return next();
  // Favicons/ícones da marca (rebrand F4): mesmo caso das fontes — o /login.html
  // pré-sessão os referencia no <head>. Sem isto, o browser tomaria 401 ao buscá-los
  // (requisição de ícone não manda Accept: text/html, então cai no ramo 401 JSON).
  // Allowlist explícita de arquivos públicos não sensíveis em public/ — nada mais.
  const PUBLIC_ICONS = ['/favicon.svg', '/favicon.ico', '/favicon-16.png', '/favicon-32.png', '/apple-touch-icon.png'];
  if (req.method === 'GET' && PUBLIC_ICONS.includes(req.path)) return next();
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
    } else if (filePath.endsWith('.woff2')) {
      // Fontes locais são imutáveis (versionadas por peso no nome do arquivo) —
      // cache longo evita rebuscar a cada navegação e elimina flash de fonte.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
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

// ---------- ROUTING CRUD (REMOVIDO — Missão 023 W2) ----------
// A aba "Roteamento" do painel e os endpoints CRUD /api/routing (que liam/escreviam
// na tabela routing_clientes para os fluxos de TESTE) foram descontinuados pelo Bruno.
// A tabela routing_clientes foi PRESERVADA (vazia, custo zero, sem migration destrutiva).
// O roteamento CORE de mensagens (apps/api/src/router.ts → findRoute → routing.findRouting)
// NÃO passa por estes endpoints e segue intacto.

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
    const [msgRows, leadsRicardoRows] = await Promise.all([
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
    ]);

    // Mapeia slot → messages_today
    const msgBySlot = Object.fromEntries(msgRows.rows.map((row) => [row.slot, row.cnt]));

    // Consolida contagens de leads por flow_id (cada tabela usa slot do bot_config como valor da coluna slot)
    const leadsByLeadsTable = {
      leads_ricardo: Object.fromEntries(leadsRicardoRows.rows.map((row) => [row.slot, row.cnt])),
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

        const resolvedFlowId = resolveSlotToFlowId(row.slot);
        const leadsTable = FLOW_LEADS_TABLE[resolvedFlowId];
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
          flow_id: resolvedFlowId,
          workflow_id: resolvedFlowId,
          models_in_flow: flowCounts[resolvedFlowId] || 1,
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

/**
 * Valida duracao_min de UM servico: quando presente, deve ser inteiro > 0 e
 * MULTIPLO DE 5 minutos (grade de agenda anda em passos de 5min — decisao
 * Bruno 2026-06-11). Ausente/null segue permitido ("duracao a combinar",
 * ver renderServicosPrecos). Usa Number() como o restante do codigo, entao
 * "30" (string numerica) tambem passa. Retorna mensagem PT-BR ou null se ok.
 * Usado por PUT /api/bots/:slot (bot_config) e PATCH /api/clones/:id (flow_clones).
 */
function validarDuracaoServico(s) {
  if (s.duracao_min === undefined || s.duracao_min === null) return null;
  const nome = String(s.nome || 'servico').trim();
  const dur = Number(s.duracao_min);
  if (!Number.isInteger(dur) || dur <= 0) {
    return `servico "${nome}": duracao_min deve ser inteiro maior que zero`;
  }
  if (dur % 5 !== 0) {
    return `servico "${nome}": duracao_min deve ser multiplo de 5 minutos`;
  }
  return null;
}

/**
 * Valida a dupla product_type/seat_cap (taxonomia de conta — ADR 0023, migr 052).
 * Regra ÚNICA reusada pelo PATCH /api/clones/:id e pelo POST /api/clones (criar
 * clone com tipo já no wizard). product_type: 'individual' | 'estabelecimento'.
 * seat_cap: NULL (sem teto) ou inteiro 1..100. Validação no app, não por CHECK no
 * banco (enforcement do teto vive no runtime). Retorna mensagem PT-BR ou null se ok.
 * `undefined` em qualquer campo = "não informado" e passa (default fica a cargo do caller).
 */
function validarTipoConta(product_type, seat_cap) {
  if (product_type !== undefined && !['individual', 'estabelecimento'].includes(String(product_type))) {
    return 'product_type deve ser individual ou estabelecimento';
  }
  if (seat_cap !== undefined && seat_cap !== null) {
    const sc = Number(seat_cap);
    if (!Number.isInteger(sc) || sc < 1 || sc > 100) {
      return 'seat_cap deve ser inteiro entre 1 e 100 (ou nulo)';
    }
  }
  return null;
}

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
      personalizacao,
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
        const erroDuracao = validarDuracaoServico(s);
        if (erroDuracao) return res.status(400).json({ error: erroDuracao });
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
    if (personalizacao !== undefined) {
      if (!personalizacao || typeof personalizacao !== 'object' || Array.isArray(personalizacao)) {
        return res.status(400).json({ error: 'personalizacao deve ser objeto' });
      }
      sets.push(`personalizacao = $${i++}::jsonb`);
      vals.push(JSON.stringify(personalizacao));
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

// POST /api/flows/:flowId/pauses
// Cria ou reativa a pausa de um numero num fluxo via painel.
// Espelha a logica de validacao do DELETE acima.
// source = 'manual-painel' para rastreabilidade (distinto de 'fromMe'/'antibot'/'manual').
app.post('/api/flows/:flowId/pauses', async (req, res) => {
  try {
    const flowId = String(req.params.flowId || '').trim();
    if (!flowId) return res.status(400).json({ error: 'flowId invalido' });

    // Validar telefone: somente digitos, minimo 10 (DDD+numero), maximo 15 (DDI+DDD+numero)
    const rawPhone = String(req.body?.telefone ?? '');
    const phone = rawPhone.replace(/\D/g, '');
    if (!phone || phone.length < 10 || phone.length > 15) {
      return res.status(400).json({
        error:
          'telefone invalido — envie somente digitos com DDI+DDD+numero (ex: 5511999999999)',
      });
    }

    const operator = req.session?.userId || 'unknown';

    // Resolver session (waha_sessao) e flow_name a partir do flowId.
    // Estrategia: busca em bot_config pelo slot (flowId e o slot para clones;
    // para matrizes o slot tambem coincide com o workflow_id em project_databases).
    // Fallback gracioso: se nao encontrar, insere com session/flow_name NULL --
    // igual ao que addFlowPause() na packages/db faz em runtime.
    const botRow = await pool
      .query(
        `SELECT b.slot, b.display_name, b.waha_sessao
         FROM bot_config b
         WHERE b.slot = $1
         LIMIT 1`,
        [flowId],
      )
      .then((r) => r.rows[0] ?? null)
      .catch(() => null);

    const session = botRow?.waha_sessao ?? null;
    const flowName = botRow?.display_name ?? null;

    const r = await pool.query(
      `INSERT INTO flow_pauses
         (flow_id, flow_name, telefone, session, active, source, reason, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, 'manual-painel', 'Pausado via painel', NOW())
       ON CONFLICT (flow_id, telefone) DO UPDATE
         SET active      = TRUE,
             flow_name   = COALESCE(EXCLUDED.flow_name, flow_pauses.flow_name),
             session     = COALESCE(EXCLUDED.session,   flow_pauses.session),
             source      = 'manual-painel',
             reason      = CASE
               WHEN flow_pauses.reason IS NULL OR flow_pauses.reason = ''
               THEN 'Pausado via painel'
               ELSE flow_pauses.reason || ' | reativado via painel'
             END,
             updated_at  = NOW()
       RETURNING flow_id, flow_name, telefone, active, source,
                 LEFT(reason, 200) AS reason, updated_at`,
      [flowId, flowName, phone, session],
    );

    console.log(
      JSON.stringify({
        audit: 'flow-pause-created',
        operator,
        flow_id: flowId,
        phone_masked: _maskPhoneForLog(phone),
        session,
        at: new Date().toISOString(),
      }),
    );

    res.status(201).json({ ok: true, pausa: r.rows[0] });
  } catch (e) {
    console.error('[flow-pauses-create]', e);
    res.status(500).json({ error: 'erro ao pausar numero' });
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
        'DELETE FROM bot_media WHERE id = $1 AND slot = $2 RETURNING id, url',
        [req.params.id, slot],
      );
      if (!r.rowCount) return res.status(404).json({ error: 'mídia não encontrada ou slot incorreto' });
    } else {
      r = await pool.query('DELETE FROM bot_media WHERE id = $1 RETURNING id, url', [req.params.id]);
      if (!r.rowCount) return res.status(404).json({ error: 'mídia não encontrada' });
    }
    // Remove o arquivo físico só se nenhuma outra linha ainda referencia a mesma url
    // (proteção contra arquivo compartilhado). Idempotente; falha de FS não derruba o request.
    const delUrl = r.rows[0]?.url;
    if (delUrl) {
      const stillUsed = await pool.query('SELECT 1 FROM bot_media WHERE url = $1 LIMIT 1', [delUrl]);
      if (!stillUsed.rowCount) await unlinkLocalMedia(delUrl);
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

    // Captura a url ANTES do UPDATE para apagar o arquivo antigo (senão vira órfão).
    const prev = await pool.query(
      'SELECT url FROM bot_media WHERE slot = $1 AND id = $2',
      [slot, mediaId],
    );
    if (!prev.rows.length) return res.status(404).json({ error: 'mídia não encontrada' });
    const oldUrl = prev.rows[0].url;

    const r = await pool.query(
      `UPDATE bot_media
          SET url = $1, media_type = $2, updated_at = NOW()
        WHERE slot = $3 AND id = $4
        RETURNING id, slot, position, title, media_type, url, position_order, enabled, updated_at`,
      [url, media_type, slot, mediaId],
    );
    if (!r.rows.length) return res.status(404).json({ error: 'mídia não encontrada' });

    // Apaga o arquivo antigo só se nenhuma outra linha ainda o referencia
    // (proteção contra arquivo compartilhado entre slots/posições) e se for
    // diferente do novo. Idempotente; falha de FS não derruba o request.
    if (oldUrl && oldUrl !== url) {
      const stillUsed = await pool.query(
        'SELECT 1 FROM bot_media WHERE url = $1 LIMIT 1',
        [oldUrl],
      );
      if (!stillUsed.rowCount) await unlinkLocalMedia(oldUrl);
    }

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
      'DELETE FROM bot_media WHERE slot = $1 AND id = $2 RETURNING id, url',
      [slot, mediaId],
    );
    if (!r.rowCount) return res.status(404).json({ error: 'mídia não encontrada' });
    // Remove o arquivo físico só se nenhuma outra linha ainda referencia a mesma url
    // (proteção contra arquivo compartilhado). Idempotente; falha de FS não derruba o request.
    const delUrl = r.rows[0]?.url;
    if (delUrl) {
      const stillUsed = await pool.query('SELECT 1 FROM bot_media WHERE url = $1 LIMIT 1', [delUrl]);
      if (!stillUsed.rowCount) await unlinkLocalMedia(delUrl);
    }
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

// ---------- ROTAS DE CURSOS REMOVIDAS (Fase 2 — descontinuação vertical vendas) ----------
// As rotas POST/DELETE /api/bots/:slot/gallery/:id/link,
// PUT /api/bots/:slot/courses/:course_slug/media,
// GET/POST/PUT/DELETE /api/bots/:slot/courses e
// PUT /api/bots/:slot/courses/:course_slug/intro/:media_id
// foram removidas neste PR. A UI de cursos foi removida simultaneamente.
// Dados em bot_courses/bot_media_courses permanecem no banco até a Fase 3 (limpeza de banco).
// ---------- FIM PLACEHOLDER ----------

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

// resolveWorkflow() removido na Missão 023 W2 — só era usado pelo CRUD /api/routing
// (aba "Roteamento" de teste, descontinuada). TS_BOTS segue em uso em fetchAllWorkflows.

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
// Retorna: array de { id, slot, telefone_mascarado, started_at, duration_ms, status_final, events_count, gatilho }
//   gatilho = event_type do PRIMEIRO evento da execução (entrada do fluxo); null se sem eventos
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
         (ARRAY_AGG(status ORDER BY id DESC))[1]             AS status_final,
         (ARRAY_AGG(event_type ORDER BY id ASC))[1]          AS gatilho
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
        gatilho: row.gatilho ?? null,
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
    // case 'routing' removido na Missão 023 W2 (inspector de routing_clientes de teste — descontinuado).
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
           ORDER BY criado_em DESC
           LIMIT $2 OFFSET $3`,
          [slot, limit, offset],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM leads_ricardo WHERE slot = $1`,
          [slot],
        ),
      ]);
      rows = rData.rows;
      total = rCount.rows[0]?.n ?? 0;
    } else {
      const [rData, rCount] = await Promise.all([
        pool.query(
          `SELECT id::text, nome, telefone, interesse AS mensagem_inicial, NULL::text AS origem, criado_em, slot,
                  'leads_ricardo'::text AS _table
             FROM leads_ricardo
           ORDER BY criado_em DESC
           LIMIT $1 OFFSET $2`,
          [limit, offset],
        ),
        pool.query(
          `SELECT COUNT(*)::int AS n FROM leads_ricardo`,
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

// ---------- DEFAULTS + RENDER DE PROMPT POR CLONE (módulo compartilhado) ----------
// Missão 020 F1: a lógica de defaults por matriz, render de prompt e orquestração
// clone+WAHA foi EXTRAÍDA (move, não muda) para
// packages/integrations/src/provisioning/clone-provisioning.ts — compartilhada
// entre este painel e o portal-api (signup self-service). O painel consome o dist
// compilado via import dinâmico, mesmo padrão do GoogleCalendarClient acima.

let _provisioningModPromise = null;
function getProvisioning() {
  if (!_provisioningModPromise) {
    _provisioningModPromise = import(
      '../packages/integrations/dist/provisioning/clone-provisioning.js'
    );
  }
  return _provisioningModPromise;
}

/**
 * Defaults para clone novo (delegado ao módulo compartilhado). Hierarquia:
 *   1) bot_config.horarios_funcionamento + bot_config.servicos da MATRIZ;
 *   2) hardcoded por matriz (teste_barbearia); 3) null/null.
 */
async function getCloneDefaults(matrizSlot) {
  const mod = await getProvisioning();
  return mod.getCloneDefaults(pool, matrizSlot);
}

/**
 * Re-renderiza o prompt do clone a partir do template da MATRIZ (delegado ao
 * módulo compartilhado). Idempotente. Retorna { ok, prompt } ou { ok:false, error }.
 */
async function regerarPromptClone(cloneRow) {
  const mod = await getProvisioning();
  return mod.regerarPromptClone(pool, cloneRow);
}

// ---------- CLONES DE FLUXO MATRIZ ----------

// GET /api/clones — lista todos os clones
app.get('/api/clones', async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome,
             fc.cliente_telefone, fc.personalizacao, fc.waha_sessao, fc.status,
             fc.flow_enabled, fc.suspended_reason, fc.suspended_at,
             fc.horarios_funcionamento, fc.servicos,
             fc.product_type, fc.seat_cap,
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
  // Tipo de conta opcional no momento da clonagem (escolha já no wizard "Clonar").
  // Default 'individual' quando ausente = retrocompatível (quem clona sem escolher
  // continua igual a hoje). product_type/seat_cap validados pela MESMA regra do PATCH.
  const { product_type, seat_cap } = req.body ?? {};
  if (!matriz_slot || typeof matriz_slot !== 'string') {
    return res.status(400).json({ error: 'matriz_slot obrigatório' });
  }
  if (!display_name || typeof display_name !== 'string') {
    return res.status(400).json({ error: 'display_name obrigatório' });
  }
  const erroTipoConta = validarTipoConta(product_type, seat_cap);
  if (erroTipoConta) return res.status(400).json({ error: erroTipoConta });
  // Normaliza o DDI do telefone ANTES de gravar (painel grava cru = pior ofensor).
  // Se o operador digitou algo, exige que normalize (DDI 55 + DDD BR); senão null.
  let clienteTelefoneFinal = null;
  if (cliente_telefone !== undefined && cliente_telefone !== null && String(cliente_telefone).trim() !== '') {
    clienteTelefoneFinal = ensureDddBr(cliente_telefone);
    if (!clienteTelefoneFinal) {
      return res.status(400).json({ error: 'cliente_telefone inválido (informe DDD + número com DDI BR)' });
    }
  }
  // Normaliza: default 'individual'; seat_cap só faz sentido p/ estabelecimento.
  const productTypeFinal =
    product_type !== undefined ? String(product_type) : 'individual';
  const seatCapFinal =
    productTypeFinal === 'estabelecimento' && seat_cap !== undefined && seat_cap !== null
      ? Number(seat_cap)
      : null;

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
          product_type, seat_cap,
          status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,'rascunho',NOW(),NOW())
       RETURNING *`,
      [
        slug,
        matriz_slot,
        display_name,
        cliente_nome ?? null,
        clienteTelefoneFinal,
        JSON.stringify(pers),
        defaults.horarios_funcionamento ? JSON.stringify(defaults.horarios_funcionamento) : null,
        defaults.servicos ? JSON.stringify(defaults.servicos) : null,
        productTypeFinal,
        seatCapFinal,
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

const MATRIZES_ROUTAVEIS = ['teste_barbearia'];

/**
 * Deriva o nome da sessão WAHA a partir do slot do clone (delegado ao módulo
 * compartilhado de provisionamento — mesma regra de sempre).
 */
async function wahaSessionName(slot) {
  const mod = await getProvisioning();
  return mod.wahaSessionName(slot);
}

/**
 * Cria sessão WAHA com webhook configurado (delegado ao módulo compartilhado).
 * Retorna { ok, status, error }. Nunca lança — encapsula falha pra o caller decidir.
 */
async function createWahaSession(name) {
  const mod = await getProvisioning();
  // wahaProvisioningConfig injeta hmac.key (plano A) e/ou customHeader (plano B)
  // na sessao nova — P0 #268 + spike 2026-06-11.
  return mod.createWahaSession(wahaProvisioningConfig(), name);
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

  // --- Orquestração (módulo compartilhado — Missão 020 F1, "move, não muda") ---
  // Mesma sequência de sempre: transação clone -> regerarPromptClone -> sessão
  // WAHA (falha não reverte o clone — decisão Bruno 005-B) -> vínculo da sessão
  // em flow_clones E bot_config (memoria mapping_slot_waha_sessao).
  let result;
  try {
    const mod = await getProvisioning();
    result = await mod.provisionCloneWithWaha(
      // wahaProvisioningConfig injeta auth do webhook na sessao nova (P0 #268).
      { db: pool, waha: wahaProvisioningConfig() },
      {
        matrizSlot: matriz_slot,
        novoSlot: novo_slot,
        displayName: display_name,
        telefoneContato: telefone_contato ?? null,
        personalizacao: pers,
      },
    );
  } catch (e) {
    if (e && e.name === 'MatrizNotFoundError') {
      return res
        .status(400)
        .json({ error: `matriz_slot "${matriz_slot}" não encontrado em bot_config` });
    }
    if (e && e.name === 'CloneSlotConflictError') {
      return res.status(409).json({ error: `slot "${novo_slot}" já existe` });
    }
    console.error(`[clones/with-waha] falha ao criar clone: ${e.message}`);
    return res.status(500).json({ error: `clones/with-waha: ${e.message}` });
  }

  if (result.wahaStatus === 'failed') {
    console.warn(
      `[clones/with-waha] clone ${novo_slot} (id=${result.cloneId}) criado mas WAHA falhou: ${result.wahaError}`,
    );
    return res.json({
      clone_id: result.cloneId,
      novo_slot,
      waha_session_name: result.sessionName,
      waha_status: 'failed',
      waha_error: result.wahaError,
      clone_status: 'rascunho',
    });
  }

  console.log(
    `[clones/with-waha] clone ${novo_slot} (id=${result.cloneId}) criado, sessão WAHA ${result.sessionName} iniciada`,
  );

  res.json({
    clone_id: result.cloneId,
    novo_slot,
    waha_session_name: result.sessionName,
    waha_status: result.wahaStatus,
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

  const sessaoName = cloneRow.waha_sessao ?? (await wahaSessionName(cloneRow.slot));
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
      `SELECT fc.id, fc.slot, fc.matriz_slot, fc.display_name, fc.cliente_nome,
              fc.cliente_telefone, fc.personalizacao, fc.waha_sessao, fc.status,
              fc.flow_enabled, fc.suspended_reason, fc.suspended_at,
              fc.horarios_funcionamento, fc.servicos,
              fc.product_type, fc.seat_cap,
              fc.created_at, fc.updated_at,
              bc.display_name AS matriz_display_name
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
    product_type,
    seat_cap,
  } = req.body ?? {};

  // Validacao leve dos novos campos.
  if (horarios_funcionamento !== undefined) {
    if (!horarios_funcionamento || typeof horarios_funcionamento !== 'object' || Array.isArray(horarios_funcionamento)) {
      return res.status(400).json({ error: 'horarios_funcionamento deve ser objeto' });
    }
  }
  // product_type/seat_cap: taxonomia validada no app (ADR 0023), nao por CHECK no
  // banco. Regra ÚNICA em validarTipoConta — mesma usada pelo POST /api/clones.
  const erroTipoConta = validarTipoConta(product_type, seat_cap);
  if (erroTipoConta) return res.status(400).json({ error: erroTipoConta });
  if (servicos !== undefined) {
    if (!Array.isArray(servicos)) {
      return res.status(400).json({ error: 'servicos deve ser array' });
    }
    for (const s of servicos) {
      if (!s || typeof s !== 'object' || !s.nome) {
        return res.status(400).json({ error: 'cada servico precisa de { nome }' });
      }
      const erroDuracao = validarDuracaoServico(s);
      if (erroDuracao) return res.status(400).json({ error: erroDuracao });
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
    // Normaliza o DDI antes de gravar (mesma regra do POST). Vazio/null = limpar o
    // campo (permitido); valor preenchido que NÃO normaliza = 400 (não grava lixo).
    let telPatch = null;
    if (cliente_telefone !== null && String(cliente_telefone).trim() !== '') {
      telPatch = ensureDddBr(cliente_telefone);
      if (!telPatch) {
        return res.status(400).json({ error: 'cliente_telefone inválido (informe DDD + número com DDI BR)' });
      }
    }
    sets.push(`cliente_telefone = $${i++}`);
    vals.push(telPatch);
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
  if (product_type !== undefined) {
    sets.push(`product_type = $${i++}`);
    vals.push(String(product_type));
  }
  if (seat_cap !== undefined) {
    sets.push(`seat_cap = $${i++}`);
    vals.push(seat_cap === null ? null : Number(seat_cap));
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

// ──────────────────────────────────────────────────────────────────────────
// Helpers do DELETE /api/clones/:id (exclusão de clone + sessão WAHA + órfãos)
// ──────────────────────────────────────────────────────────────────────────

// DENYLIST de sessões WAHA que NUNCA podem ser deletadas por esta rota, mesmo
// que algum clone aponte para elas. São sessões compartilhadas/críticas:
//   - STARTAP_AI_PROD: Lola (prospecção própria)
//   - ALERTAS: remetente único de todos os alertas internos/cliente
//   - matrizes/roteador: bases das quais os clones são clonados
// NÃO reusamos o guard `clone_` do provisioning porque clientes manuais têm
// sessão SEM esse prefixo (cirilobarbearia, barbearia_samuel) e PRECISAM ser
// deletáveis por aqui. A denylist é a barreira correta. Fácil de estender.
const WAHA_SESSION_DELETE_DENYLIST = new Set([
  'STARTAP_AI_PROD',
  'ALERTAS',
  'teste_barbearia',
  'teste_vendas_barbearia',
  'WHATSAPP_ROUTER_TESTE',
]);

/** true se a sessão WAHA é protegida e não pode ser removida por esta rota. */
function isProtectedWahaSession(sessao) {
  return WAHA_SESSION_DELETE_DENYLIST.has(sessao);
}

/**
 * Escapa um valor para uso seguro como PREFIXO em LIKE ... ESCAPE '\'.
 * Slots e sessões contêm '_' (curinga do LIKE) — sem escapar, 'clone_a' casaria
 * com 'cloneXa'. Escapa \ % _ para que o LIKE confine estritamente ao slot.
 */
function escapeLikePrefix(value) {
  return value.replace(/([\\%_])/g, '\\$1');
}

/** Espelha isValidChatTableName de packages/db (defesa contra SQL injection no nome da tabela). */
function isValidChatTableName(table) {
  return typeof table === 'string' && /^chat_histories(_[a-z0-9_]+)?$/.test(table);
}

/**
 * Apaga a sessão do WAHA de fato (para + REMOVE no NOWEB/Baileys). Best-effort:
 * erro NUNCA bloqueia a exclusão do clone no banco. Pula se sessão vazia ou
 * protegida pela denylist. DELETE é idempotente (404 = já não existe = ok).
 */
async function deleteCloneWahaSession(sessao) {
  if (!sessao) return { attempted: false, reason: 'sem sessão' };
  if (isProtectedWahaSession(sessao)) {
    console.log(`[clones] sessão protegida '${sessao}' NÃO removida do WAHA (denylist)`);
    return { attempted: false, reason: 'protegida' };
  }
  try {
    const r = await fetch(`${WAHA_URL}/api/sessions/${sessao}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
    });
    if (!r.ok && r.status !== 404) {
      const body = await r.json().catch(() => ({}));
      console.log(`[clones] DELETE sessão '${sessao}' -> WAHA erro: ${body?.message ?? `HTTP ${r.status}`}`);
      return { attempted: true, ok: false };
    }
    console.log(`[clones] sessão '${sessao}' removida do WAHA (status ${r.status})`);
    return { attempted: true, ok: true };
  } catch (e) {
    // best-effort: WAHA fora do ar não pode travar a exclusão do clone
    console.log(`[clones] falha ao contatar WAHA p/ deletar sessão '${sessao}': ${e.message}`);
    return { attempted: true, ok: false };
  }
}

// DELETE /api/clones/:id
app.delete('/api/clones/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const existing = await pool.query(
      `SELECT slot, waha_sessao, chat_table FROM flow_clones WHERE id = $1`,
      [id],
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    const { slot: cloneSlot, waha_sessao, chat_table } = existing.rows[0];

    // Remove a SESSÃO do WAHA de fato (não só logout). Best-effort: erro aqui
    // nunca bloqueia o delete no banco. Denylist protege sessões compartilhadas.
    await deleteCloneWahaSession(waha_sessao);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Remove todos os dados do clone na mesma transação para evitar órfãos.
      // O DELETE de flow_clones dispara ON DELETE CASCADE (migrations 039/040/041):
      // portal_users, portal_user_clones, client_billing, billing_charges — por
      // isso o "usuário cliente" e o billing somem sem DELETE explícito aqui.
      await client.query(`DELETE FROM flow_controls WHERE flow_id = $1`, [cloneSlot]);
      await client.query(`DELETE FROM bot_prompt WHERE slot = $1`, [cloneSlot]);
      await client.query(`DELETE FROM bot_media WHERE slot = $1`, [cloneSlot]);
      await client.query(`DELETE FROM bot_config WHERE slot = $1`, [cloneSlot]);

      // ── Órfãos SEM FK/CASCADE — limpeza explícita keyed pelo slot/sessão ──
      // flow_pauses: registry usa workflow_id = slot do clone (registry.ts).
      await client.query(`DELETE FROM flow_pauses WHERE flow_id = $1`, [cloneSlot]);

      // alert_states (migration 046, PK = check_key, sem FK). Duas famílias de
      // chave carregam o clone:
      //   - 'waha:<waha_sessao>'        (monitor.ts: key = `waha:${sessao}`)
      //   - 'clientalert:<slot>:<hash>' (client-alert.ts: cooldownKey por slot)
      await client.query(
        `DELETE FROM alert_states WHERE check_key LIKE $1 ESCAPE '\\'`,
        [`clientalert:${escapeLikePrefix(cloneSlot)}:%`],
      );
      if (waha_sessao) {
        await client.query(`DELETE FROM alert_states WHERE check_key = $1`, [`waha:${waha_sessao}`]);
      }

      // Histórico de chat (tabela COMPARTILHADA entre clones da mesma matriz).
      // session_id = `${slot}:${sessao}:${flowId}:${telefone}` (bots/base.ts) —
      // prefixado pelo slot. Confina ao slot com LIKE escapado + ESCAPE '\\'.
      // Valida o nome da tabela (vem do banco) contra injeção antes de interpolar.
      if (isValidChatTableName(chat_table)) {
        await client.query(
          `DELETE FROM ${chat_table} WHERE session_id LIKE $1 ESCAPE '\\'`,
          [`${escapeLikePrefix(cloneSlot)}:%`],
        );
      }

      // trial_ledger: NÃO deletar de propósito (migration 044) — o ledger sobrevive
      // ao delete do clone (anti trial-farming: deletar+recriar não reseta o trial).

      await client.query(`DELETE FROM flow_clones WHERE id = $1`, [id]);
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

// POST /api/clones/:id/suspend — suspende fluxo do clone sem desconectar WAHA
// Body opcional: { reason?: string }
// Preserva a sessão WAHA intacta; apenas marca flow_enabled=false no banco.
// Registra em flow_suspension_log para auditoria.
app.post('/api/clones/:id/suspend', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() || null : null;
  // suspended_kind = categoria ESTRUTURADA da suspensao (ADR 0013 / threat-model C1; ADR 0014 F1).
  // O auto-resume do webhook PIX SO reativa quando kind='billing' — nunca por string-match
  // no texto livre de reason. A categoria e OBRIGATORIA: SEM default 'billing' (ADR 0014).
  // Motivo: um default 'billing' silencioso poderia AUTO-RESUMIR uma suspensao que o
  // operador fez por outro motivo (esqueceu de trocar o dropdown). Forcando a escolha
  // consciente, so suspensoes realmente de cobranca reativam ao pagar.
  const VALID_KINDS = ['billing', 'owner_request', 'manual_other', 'abuse'];
  const kind = typeof req.body?.kind === 'string' ? req.body.kind.trim() : '';
  if (!VALID_KINDS.includes(kind)) {
    return res.status(400).json({ error: 'kind obrigatório (billing|owner_request|manual_other|abuse)' });
  }
  const actor = req.session?.userId ?? 'admin';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE flow_clones
          SET flow_enabled      = FALSE,
              suspended_reason  = $2,
              suspended_kind    = $3,
              suspended_at      = NOW(),
              updated_at        = NOW()
        WHERE id = $1
    RETURNING id, slot, flow_enabled, suspended_reason, suspended_kind, suspended_at`,
      [id, reason, kind],
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Clone não encontrado' });
    }
    const { slot } = r.rows[0];
    await client.query(
      `INSERT INTO flow_suspension_log (slot, action, reason, actor) VALUES ($1, 'suspend', $2, $3)`,
      [slot, reason, actor],
    );
    await client.query('COMMIT');
    console.log(`[suspend] clone ${slot} (id=${id}) suspenso por ${actor} — motivo: ${reason ?? '(sem motivo)'}`);
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST /api/clones/:id/resume — reativa fluxo do clone
// Registra em flow_suspension_log para auditoria.
app.post('/api/clones/:id/resume', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
  const actor = req.session?.userId ?? 'admin';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `UPDATE flow_clones
          SET flow_enabled      = TRUE,
              suspended_reason  = NULL,
              suspended_kind    = NULL,
              suspended_at      = NULL,
              updated_at        = NOW()
        WHERE id = $1
    RETURNING id, slot, flow_enabled, suspended_reason, suspended_kind, suspended_at`,
      [id],
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Clone não encontrado' });
    }
    const { slot } = r.rows[0];
    await client.query(
      `INSERT INTO flow_suspension_log (slot, action, reason, actor) VALUES ($1, 'resume', NULL, $2)`,
      [slot, actor],
    );
    await client.query('COMMIT');
    console.log(`[resume] clone ${slot} (id=${id}) reativado por ${actor}`);
    res.json({ ok: true, ...r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
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
  // Normaliza o DDI do telefone (se vier) ANTES de gravar — mesma regra do POST/PATCH.
  // Valor preenchido que não normaliza = 400 (não grava destino de pareamento inválido).
  let telefoneFinal = null;
  if (telefone && typeof telefone === 'string' && telefone.trim() !== '') {
    telefoneFinal = ensureDddBr(telefone);
    if (!telefoneFinal) {
      return res.status(400).json({ error: 'telefone inválido (informe DDD + número com DDI BR)' });
    }
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
    if (telefoneFinal) {
      await pool.query(
        `UPDATE flow_clones SET cliente_telefone = $1, updated_at = NOW() WHERE id = $2`,
        [telefoneFinal, id],
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

  let parsed;
  try {
    parsed = JSON.parse(credentials_json);
  } catch {
    return res.status(400).json({ error: 'credentials_json: JSON malformado' });
  }
  if (parsed.type !== 'service_account') {
    return res.status(400).json({ error: 'credentials_json: deve ser do tipo service_account' });
  }

  // No estabelecimento, o calendarId do CLONE é ignorado pelo bot — cada colaborador
  // tem o seu (clone_colaboradores.gcal_calendar_id). Aqui só gravamos a Service
  // Account do clone, sem exigir calendar_id. No individual, calendar_id segue obrigatório.
  let productType;
  try {
    const meta = await pool.query(`SELECT product_type FROM flow_clones WHERE id = $1`, [id]);
    if (!meta.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    productType = meta.rows[0].product_type;
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  const isEstabelecimento = productType === 'estabelecimento';
  if (!isEstabelecimento && (!calendar_id || typeof calendar_id !== 'string')) {
    return res.status(400).json({ error: 'calendar_id obrigatório' });
  }
  // calendar_id é opcional no estabelecimento; quando ausente, gravamos NULL.
  const calendarIdValue =
    calendar_id && typeof calendar_id === 'string' ? calendar_id.trim() : null;

  const clientEmail = parsed.client_email ?? null;
  // Loga apenas o client_email — nunca a chave privada
  console.log(`[gcal] PUT clone ${id} (${productType}): client_email=${clientEmail}`);

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
      [encryptGcalCredentials(credentials_json), clientEmail, calendarIdValue, id],
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

// ── Conta Google do CLIENTE (login do Google Agenda) ─────────────────────────
// DIFERENTE da Service Account (gcal_*, o "robô" do bot): aqui guardamos o
// e-mail + senha da conta Google PESSOAL do cliente pra ele logar no Google
// Agenda. Colunas google_account_email / google_account_password_enc /
// google_account_updated_at vêm da migration 061 (PR feat/google-account-api).
// A SENHA é cifrada com o MESMO AES-256-GCM (formato enc:v2:) usado pro gcal —
// e NUNCA aparece em log (nem em erro). Diferente do /gcal/status (que jamais
// devolve segredo), o GET aqui devolve a senha em claro DE PROPÓSITO: é o
// operador que precisa ver pra entregar a conta ao cliente.

// PUT /api/clones/:id/google-account { email, password } — grava cifrada.
app.put('/api/clones/:id/google-account', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  const { email, password } = req.body ?? {};
  if (!email || typeof email !== 'string' || email.trim() === '') {
    return res.status(400).json({ error: 'email obrigatório' });
  }
  if (!password || typeof password !== 'string' || password === '') {
    return res.status(400).json({ error: 'password obrigatório' });
  }
  const emailTrim = email.trim();
  // Validação leve de formato (não bloqueia caso de borda, só erro óbvio de digitação).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
    return res.status(400).json({ error: 'email inválido' });
  }

  try {
    const r = await pool.query(
      `UPDATE flow_clones
          SET google_account_email        = $1,
              google_account_password_enc = $2,
              google_account_updated_at   = NOW(),
              updated_at                  = NOW()
        WHERE id = $3
        RETURNING id, slot, google_account_email, google_account_updated_at`,
      [emailTrim, encryptGcalCredentials(password), id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    // Loga SÓ o e-mail — a senha NUNCA entra em log.
    console.log(`[google-account] PUT clone ${id}: email=${emailTrim}`);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clones/:id/google-account — decifra server-side e devolve { email, password }.
// Intencional: o operador precisa ver a senha pra entregar a conta ao cliente.
app.get('/api/clones/:id/google-account', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  try {
    const r = await pool.query(
      `SELECT google_account_email, google_account_password_enc, google_account_updated_at
         FROM flow_clones WHERE id = $1`,
      [id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });

    const { google_account_email, google_account_password_enc, google_account_updated_at } = r.rows[0];
    let password = '';
    if (google_account_password_enc) {
      try {
        password = decryptGcalCredentials(google_account_password_enc);
      } catch {
        // NÃO vaza o ciphertext/erro de cripto — só sinaliza que está corrompido.
        return res.status(500).json({ error: 'falha ao decifrar a senha — dado corrompido' });
      }
    }
    res.json({
      email: google_account_email || '',
      password,
      updated_at: google_account_updated_at || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/clones/:id/google-account — zera as 2 colunas (+ updated_at).
app.delete('/api/clones/:id/google-account', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });

  try {
    const r = await pool.query(
      `UPDATE flow_clones
          SET google_account_email        = NULL,
              google_account_password_enc = NULL,
              google_account_updated_at   = NOW(),
              updated_at                  = NOW()
        WHERE id = $1
        RETURNING id`,
      [id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Clone não encontrado' });
    console.log(`[google-account] DELETE clone ${id}: conta removida`);
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

// POST /api/sessions/:name/ensure-audio-webhook — garante 'message.any' nos
// events do webhook da sessao no WAHA e REMOVE 'message' se presente. Engine
// NOWEB so envia audio/video/imagem sob 'message.any'; sessoes criadas antes
// da correcao de 2026-05-21 tinham so ['message','session.status'] e nunca
// recebiam audio. 'message' sai porque 'message.any' e superset — os dois
// juntos entregam a mesma mensagem inbound 2x (event.id diferentes, dedup nao
// pega) e o bot responde em dobro (bug do smoke 2026-06-12). Idempotente.
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

    // 2. Garante message.any e remove 'message' em CADA webhook (caso haja
    // mais de um) — manter os dois duplica a entrega e o bot responde 2x.
    let changed = false;
    const newWebhooks = webhooks.map((w) => {
      let events = Array.isArray(w.events) ? [...w.events] : [];
      if (!events.includes('message.any')) {
        events.push('message.any');
        changed = true;
      }
      if (events.includes('message')) {
        events = events.filter((ev) => ev !== 'message');
        changed = true;
      }
      return { ...w, events };
    });

    if (!changed) {
      return res.json({ ok: true, changed: false, message: 'events ja corretos em todos os webhooks (message.any presente, sem message)' });
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
          // buildWahaWebhooks injeta hmac.key (plano A) e/ou customHeader (plano B) — P0 #268 + spike 2026-06-11.
          // SO 'message.any', SEM 'message': na engine NOWEB message.any e
          // superset de message — assinar os dois entrega a mesma mensagem 2x
          // e o bot responde em dobro (bug do smoke 2026-06-12). message.any
          // sozinho tambem cobre audio/video/imagem (correcao 2026-05-21).
          // Mesma lista do clone-provisioning.ts (createWahaSession).
          webhooks: buildWahaWebhooks(['message.any', 'session.status']),
          // ignore/noweb explicitos (padrao Cirilo, diretriz Bruno 12/06):
          // sessao nova segue a config das sessoes prod comprovadas em vez de
          // herdar default implicito da instancia WAHA — ver bloco "Padrao-ouro
          // de sessao nova" no topo. Bot SO responde chat privado.
          ignore: WAHA_SESSION_IGNORE,
          noweb: WAHA_SESSION_NOWEB,
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

// GET /api/sessions/:name/recent-contacts?days=7
// Lista contatos individuais (sem grupos) que interagiram com a sessao
// nos ultimos N dias, ordenados por interacao mais recente.
// Sem cache — bate no WAHA fresh a cada chamada (on-demand pelo frontend).
//
// Estrategia: tenta WAHA /chats primeiro (funciona quando config.noweb.store.enabled=True,
// ex: Lola/STARTAP_AI_PROD). Se WAHA retornar qualquer erro (400 "store disabled", 502,
// timeout), cai automaticamente para fallback no banco: busca telefones distintos em
// message_log WHERE chat_id = :name AND created_at > now() - N days.
// Isso garante que sessoes sem store (Cirilo, Carlos, matrizes) tambem listem contatos.
app.get('/api/sessions/:name/recent-contacts', async (req, res) => {
  const { name } = req.params;

  // Valida :name — apenas alfanumerico + _ e -
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
    return res.status(400).json({ error: 'name invalido' });
  }

  // Valida ?days — default 7, max 30, inteiro positivo
  const rawDays = req.query.days !== undefined ? Number(req.query.days) : 7;
  if (!Number.isFinite(rawDays) || rawDays < 1 || rawDays > 30 || !Number.isInteger(rawDays)) {
    return res.status(400).json({ error: 'days deve ser inteiro entre 1 e 30' });
  }
  const days = rawDays;

  const TIMEOUT_MS = 8_000;
  const ENRICH_LIMIT = 30; // maximo de chats que tentamos buscar pushName
  const RESPONSE_LIMIT = 100;

  // ── helper: fallback via banco ───────────────────────────────────────────────────────
  // Busca os telefones que conversaram com esta sessao nos ultimos N dias a partir
  // de message_log (chat_id = nome da sessao WAHA). Filtros:
  //   - phone com ate 15 digitos (telefones reais BR/internacionais; >15 sao IDs de grupo)
  //   - exclui o proprio numero do bot (busca waha_sessao=name em bot_config)
  // Retorna array no mesmo shape { phone, name, last_interaction } que o caminho WAHA.
  async function fallbackFromDB() {
    // Descobre o numero do proprio bot pra excluir da lista (coluna opcional).
    // Se coluna waha_number nao existir, botPhone fica null e o filtro e ignorado.
    let botPhone = null;
    try {
      const botRow = await pool.query(
        `SELECT b.waha_number
         FROM bot_config b
         WHERE b.waha_sessao = $1
         LIMIT 1`,
        [name],
      );
      botPhone = botRow.rows[0]?.waha_number ?? null;
    } catch (_) {
      // coluna waha_number pode nao existir — ignora, nao filtra pelo numero do bot
    }

    // Busca contatos distintos, mais recente interacao primeiro.
    // Todos os parametros sao parametrizados — sem interpolacao de input do usuario.
    // LENGTH(phone) <= 15 exclui IDs de grupo WhatsApp (normalmente >15 digitos).
    const dbRows = await pool.query(
      `SELECT
         phone,
         MAX(created_at) AS last_at
       FROM message_log
       WHERE chat_id = $1
         AND created_at > NOW() - ($2 || ' days')::interval
         AND LENGTH(phone) <= 15
         AND ($3::text IS NULL OR phone <> $3)
       GROUP BY phone
       ORDER BY last_at DESC
       LIMIT $4`,
      [name, String(days), botPhone, RESPONSE_LIMIT],
    );

    return dbRows.rows.map((row) => ({
      phone: row.phone,
      name: null,   // message_log nao guarda nome — compativel com shape WAHA (name nullable)
      last_interaction: new Date(row.last_at).toISOString(),
    }));
  }
  // ────────────────────────────────────────────────────────────────────────────

  try {
    // 1. Tenta WAHA /chats — funciona quando store habilitado (ex: STARTAP_AI_PROD/Lola)
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let wahaOk = false;
    let chatsRaw = [];
    try {
      const r = await fetch(`${WAHA_URL}/api/${name}/chats`, {
        headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        console.log(`[recent-contacts] WAHA /chats ${name} -> ${r.status}: ${body?.message ?? ''} — usando fallback DB`);
        // nao retorna 502 aqui; cai pro fallback do banco abaixo
      } else {
        chatsRaw = await r.json().catch(() => []);
        wahaOk = true;
      }
    } catch (fetchErr) {
      clearTimeout(timer);
      const isTimeout = fetchErr.name === 'AbortError';
      console.log(`[recent-contacts] WAHA /chats ${name} -> ${isTimeout ? 'timeout' : fetchErr.message} — usando fallback DB`);
      // nao retorna erro; cai pro fallback do banco abaixo
    }

    // 2. Se WAHA falhou por qualquer motivo (store off, timeout, rede), usa banco
    if (!wahaOk) {
      try {
        const contacts = await fallbackFromDB();
        console.log(`[recent-contacts] fallback DB ${name}: ${contacts.length} contatos`);
        return res.json({
          session: name,
          days,
          count: contacts.length,
          contacts,
          source: 'db',  // informativo para debug; ignorado pelo frontend
        });
      } catch (dbErr) {
        console.error(`[recent-contacts] fallback DB ${name} falhou:`, dbErr.message);
        return res.status(502).json({ error: 'nao foi possivel buscar contatos agora' });
      }
    }

    // 3. Caminho WAHA (store habilitado): processa chatsRaw como antes
    if (!Array.isArray(chatsRaw)) chatsRaw = [];

    // Calcula corte de tempo (seconds epoch)
    const nowSec = Math.floor(Date.now() / 1000);
    const cutoffSec = nowSec - days * 86400;

    // Filtra: apenas individuais (@s.whatsapp.net ou @c.us), dentro da janela
    const filtered = chatsRaw.filter((chat) => {
      const id = chat?.id ?? '';
      if (id.endsWith('@g.us')) return false;
      if (!id.endsWith('@s.whatsapp.net') && !id.endsWith('@c.us')) return false;
      let ts = chat?.conversationTimestamp ?? chat?.timestamp ?? 0;
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      return ts >= cutoffSec;
    });

    // Extrai telefone limpo e timestamp normalizado
    const mapped = filtered.map((chat) => {
      const id = chat?.id ?? '';
      const phone = id.replace(/@s\.whatsapp\.net$|@c\.us$/, '');
      let ts = chat?.conversationTimestamp ?? chat?.timestamp ?? 0;
      if (ts > 1e12) ts = Math.floor(ts / 1000);
      return { phone, chatId: id, ts, name: chat?.name ?? null };
    });

    mapped.sort((a, b) => b.ts - a.ts);
    const limited = mapped.slice(0, RESPONSE_LIMIT);

    // Enriquece com pushName para os primeiros ENRICH_LIMIT chats
    //    Usa GET /api/{name}/chats/{chatId} — endpoint WAHA Plus para metadata do chat.
    //    Se falhar (404, erro, timeout), cai para name: null sem derrubar a resposta.
    const enrichBatch = limited.slice(0, ENRICH_LIMIT);
    const enrichResults = await Promise.allSettled(
      enrichBatch.map(async (item) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3_000);
        try {
          const r = await fetch(
            `${WAHA_URL}/api/${name}/chats/${encodeURIComponent(item.chatId)}`,
            {
              headers: WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {},
              signal: ctrl.signal,
            },
          );
          clearTimeout(t);
          if (!r.ok) return null;
          const data = await r.json().catch(() => null);
          // WAHA Plus retorna { name, id, ... } ou { pushName, ... }
          return data?.name ?? data?.pushName ?? null;
        } catch {
          clearTimeout(t);
          return null;
        }
      }),
    );

    // Monta response final
    const contacts = limited.map((item, idx) => {
      let resolvedName = item.name; // nome que ja veio no /chats (pushName inline)
      if (idx < ENRICH_LIMIT) {
        const settled = enrichResults[idx];
        if (settled?.status === 'fulfilled' && settled.value) {
          resolvedName = settled.value;
        }
      }
      return {
        phone: item.phone,
        name: resolvedName ?? null,
        last_interaction: new Date(item.ts * 1000).toISOString(),
      };
    });

    res.json({
      session: name,
      days,
      count: contacts.length,
      contacts,
      source: 'waha',
    });
  } catch (e) {
    console.error(`[recent-contacts] erro inesperado ${name}:`, e.message);
    res.status(502).json({ error: 'nao foi possivel buscar contatos agora' });
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

// ============================================================================
// PORTAL DO CLIENTE — gestao de usuarios e billing (Missao 009 / ADR 0012)
// Backend apenas; a UI vem depois (frontend-engineer). Todas as rotas atras do
// requireAuth global + CSRF para mutacoes (igual ao restante do painel).
// ============================================================================

const BCRYPT_COST = 12;
const PORTAL_USERNAME_RE = /^[a-zA-Z0-9._-]{3,80}$/;

// Gera senha aleatoria legivel (sem caracteres ambiguos) para criacao de user.
function _genPortalPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// ---------- GET /api/portal-users — lista users do portal (sem hash) ----------
app.get('/api/portal-users', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, slot, username, display_name, active, must_change_password,
              last_login_at, created_at, updated_at
       FROM portal_users
       ORDER BY created_at DESC`,
    );
    res.json({ count: r.rows.length, users: r.rows });
  } catch (e) {
    console.error(JSON.stringify({ at: 'portal-users-list', pg_code: e?.code, pg_constraint: e?.constraint, msg: 'falha ao listar usuarios do portal' }));
    res.status(500).json({ error: 'erro ao listar usuarios do portal' });
  }
});

// ---------- POST /api/portal-users — cria user (senha fornecida ou gerada) ----
// Body: { slot, username, display_name?, password? }
// Retorna a senha em claro UMA UNICA VEZ quando gerada (nunca persistida em claro).
app.post('/api/portal-users', async (req, res) => {
  try {
    const slot = String(req.body?.slot ?? '').trim();
    const username = String(req.body?.username ?? '').trim();
    const displayName = req.body?.display_name != null ? String(req.body.display_name).trim() : null;
    const providedPassword = req.body?.password != null ? String(req.body.password) : null;

    if (!slot) return res.status(400).json({ error: 'slot obrigatorio' });
    if (!PORTAL_USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'username invalido (3-80 chars: letras, numeros, . _ -)' });
    }
    if (providedPassword != null && providedPassword.length < 8) {
      return res.status(400).json({ error: 'senha deve ter ao menos 8 caracteres' });
    }

    // slot precisa existir em flow_clones (FK garante, mas damos erro claro antes).
    const cloneRow = await pool.query(`SELECT slot FROM flow_clones WHERE slot = $1`, [slot]);
    if (cloneRow.rowCount === 0) {
      return res.status(404).json({ error: 'slot (fluxo) nao encontrado' });
    }

    // username unico (case-insensitive).
    const dupe = await pool.query(
      `SELECT 1 FROM portal_users WHERE lower(username) = lower($1) LIMIT 1`,
      [username],
    );
    if (dupe.rowCount > 0) {
      return res.status(409).json({ error: 'username ja existe' });
    }

    const plainPassword = providedPassword ?? _genPortalPassword();
    const generated = providedPassword == null;
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_COST);

    const client = await pool.connect();
    let userRow;
    try {
      await client.query('BEGIN');
      // A senha definida na criação é a DEFINITIVA — não forçamos
      // must_change_password (o portal não tem troca self-service nem deve
      // mostrar nag de "senha provisória"). FALSE explícito.
      const ins = await client.query(
        `INSERT INTO portal_users
           (slot, username, password_hash, display_name, must_change_password, created_at, updated_at)
         VALUES ($1, $2, $3, $4, FALSE, NOW(), NOW())
         RETURNING id, slot, username, display_name, active, must_change_password,
                   last_login_at, created_at, updated_at`,
        [slot, username, passwordHash, displayName],
      );
      userRow = ins.rows[0];
      await client.query(
        `INSERT INTO portal_user_clones (user_id, slot, role, created_at)
         VALUES ($1, $2, 'owner', NOW())
         ON CONFLICT (user_id, slot) DO NOTHING`,
        [userRow.id, slot],
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    console.log(JSON.stringify({
      audit: 'portal-user-created',
      operator: req.session?.userId || 'unknown',
      user_id: userRow.id,
      slot,
      username,
      password_generated: generated,
      at: new Date().toISOString(),
    }));

    // Senha em claro retornada SO agora (gerada) — UI deve mostrar uma vez.
    res.status(201).json({
      ok: true,
      user: userRow,
      generated_password: generated ? plainPassword : undefined,
    });
  } catch (e) {
    console.error(JSON.stringify({ at: 'portal-users-create', pg_code: e?.code, pg_constraint: e?.constraint, msg: 'falha ao criar usuario do portal' }));
    res.status(500).json({ error: 'erro ao criar usuario do portal' });
  }
});

// ---------- PATCH /api/portal-users/:id — ativar/desativar ou reset de senha ---
// Body (qualquer combinacao): { active?: bool, reset_password?: bool, password?: string }
// Nao ha DELETE — desativacao apenas (ADR 0012).
app.patch('/api/portal-users/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id invalido' });

    const exists = await pool.query(`SELECT id, username FROM portal_users WHERE id = $1`, [id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'usuario nao encontrado' });

    const operator = req.session?.userId || 'unknown';
    let response = {};

    // 1. ativar/desativar
    if (req.body?.active !== undefined) {
      const active = req.body.active === true || req.body.active === 'true';
      const r = await pool.query(
        `UPDATE portal_users
           SET active = $2,
               failed_attempts = CASE WHEN $2 THEN failed_attempts ELSE 0 END,
               locked_until = CASE WHEN $2 THEN locked_until ELSE NULL END,
               updated_at = NOW()
         WHERE id = $1
         RETURNING id, slot, username, display_name, active, must_change_password,
                   last_login_at, created_at, updated_at`,
        [id, active],
      );
      response.user = r.rows[0];
      console.log(JSON.stringify({
        audit: active ? 'portal-user-activated' : 'portal-user-deactivated',
        operator, user_id: id, at: new Date().toISOString(),
      }));
    }

    // 2. reset de senha (gera nova se nao fornecida; retorna em claro uma vez)
    if (req.body?.reset_password === true || req.body?.reset_password === 'true' || req.body?.password != null) {
      const provided = req.body?.password != null ? String(req.body.password) : null;
      if (provided != null && provided.length < 8) {
        return res.status(400).json({ error: 'senha deve ter ao menos 8 caracteres' });
      }
      const plain = provided ?? _genPortalPassword();
      const generated = provided == null;
      const hash = await bcrypt.hash(plain, BCRYPT_COST);
      // A senha definida no reset é a DEFINITIVA — não marcamos
      // must_change_password (o portal não tem troca self-service e não deve
      // mostrar nag de "senha provisória" ao cliente). Limpamos a flag aqui pra
      // não arrastar um TRUE antigo de quando o reset ainda forçava troca.
      const r = await pool.query(
        `UPDATE portal_users
           SET password_hash = $2, must_change_password = FALSE,
               failed_attempts = 0, locked_until = NULL, updated_at = NOW()
         WHERE id = $1
         RETURNING id, slot, username, display_name, active, must_change_password,
                   last_login_at, created_at, updated_at`,
        [id, hash],
      );
      response.user = r.rows[0];
      if (generated) response.generated_password = plain;
      console.log(JSON.stringify({
        audit: 'portal-user-password-reset',
        operator, user_id: id, password_generated: generated, at: new Date().toISOString(),
      }));
    }

    if (Object.keys(response).length === 0) {
      return res.status(400).json({ error: 'nada para atualizar (use active e/ou reset_password/password)' });
    }
    res.json({ ok: true, ...response });
  } catch (e) {
    console.error(JSON.stringify({ at: 'portal-users-patch', pg_code: e?.code, pg_constraint: e?.constraint, msg: 'falha ao atualizar usuario do portal' }));
    res.status(500).json({ error: 'erro ao atualizar usuario do portal' });
  }
});

// ---------- GET /api/billing — lista billing por slot ----------
app.get('/api/billing', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT slot,
              to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
              amount_cents, last_payment_at, status, notes, created_at, updated_at
       FROM client_billing
       ORDER BY next_due_date NULLS LAST, slot`,
    );
    res.json({ count: r.rows.length, billing: r.rows });
  } catch (e) {
    console.error(JSON.stringify({ at: 'billing-list', pg_code: e?.code, pg_constraint: e?.constraint, msg: 'falha ao listar billing' }));
    res.status(500).json({ error: 'erro ao listar billing' });
  }
});

// ---------- PUT /api/billing/:slot — define/atualiza ou registra pagamento -----
// Body: { next_due_date?, amount_cents?, status?, notes?, register_payment?, cycle_months? }
// register_payment=true: grava last_payment_at=now(), status='active' e avanca
// next_due_date em cycle_months (default 1), preservando o dia.
app.put('/api/billing/:slot', async (req, res) => {
  try {
    const slot = String(req.params.slot ?? '').trim();
    if (!slot) return res.status(400).json({ error: 'slot invalido' });

    const cloneRow = await pool.query(`SELECT slot FROM flow_clones WHERE slot = $1`, [slot]);
    if (cloneRow.rowCount === 0) return res.status(404).json({ error: 'slot (fluxo) nao encontrado' });

    const operator = req.session?.userId || 'unknown';
    const registerPayment = req.body?.register_payment === true || req.body?.register_payment === 'true';

    // Validacoes leves dos campos opcionais.
    const nextDueDate = req.body?.next_due_date != null ? String(req.body.next_due_date) : null;
    if (nextDueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(nextDueDate)) {
      return res.status(400).json({ error: 'next_due_date deve ser YYYY-MM-DD' });
    }
    let amountCents = null;
    if (req.body?.amount_cents != null) {
      amountCents = Number(req.body.amount_cents);
      if (!Number.isInteger(amountCents) || amountCents < 0) {
        return res.status(400).json({ error: 'amount_cents deve ser inteiro >= 0 (centavos)' });
      }
    }
    const status = req.body?.status != null ? String(req.body.status) : null;
    if (status != null && !['active', 'overdue', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'status invalido (active|overdue|suspended)' });
    }
    const notes = req.body?.notes != null ? String(req.body.notes) : null;
    if (notes != null && notes.length > 2000) {
      return res.status(400).json({ error: 'notes deve ter no maximo 2000 caracteres' });
    }

    if (registerPayment) {
      // Avanca o vencimento em cycle_months (default 1) a partir de MAX(vencimento, hoje).
      // Espelha advanceFromMaxDue (packages/db client-billing.ts) e o avanco do webhook
      // (billing-webhook-events.applyPaidWebhook §6 no modelo por data): o GREATEST garante
      // que registrar pagamento de um cliente VENCIDO (due no passado) NUNCA renova pro
      // passado — o novo vencimento parte de hoje. Aplicado INCONDICIONALMENTE: o painel
      // nao le a flag BILLING_DUE_DATE_MODEL, e GREATEST(due, hoje) e seguro/correto nos
      // DOIS modelos (em dia: parte de due; vencido: parte de hoje). Logica em SQL para
      // nao depender de helpers TS aqui.
      let cycleMonths = req.body?.cycle_months != null ? Number(req.body.cycle_months) : 1;
      if (!Number.isInteger(cycleMonths) || cycleMonths < 1 || cycleMonths > 36) cycleMonths = 1;

      const r = await pool.query(
        `INSERT INTO client_billing (slot, next_due_date, amount_cents, status, notes,
                                     last_payment_at, created_at, updated_at)
         VALUES (
           $1,
           (GREATEST(COALESCE($2::date, CURRENT_DATE), CURRENT_DATE) + ($3 || ' months')::interval)::date,
           $4, 'active', $5, NOW(), NOW(), NOW()
         )
         ON CONFLICT (slot) DO UPDATE SET
           next_due_date   = (GREATEST(COALESCE(client_billing.next_due_date, CURRENT_DATE), CURRENT_DATE) + ($3 || ' months')::interval)::date,
           amount_cents    = COALESCE($4, client_billing.amount_cents),
           status          = 'active',
           notes           = COALESCE($5, client_billing.notes),
           last_payment_at = NOW(),
           updated_at      = NOW()
         RETURNING slot, to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
                   amount_cents, last_payment_at, status, notes, updated_at`,
        [slot, nextDueDate, String(cycleMonths), amountCents, notes],
      );
      console.log(JSON.stringify({
        audit: 'billing-payment-registered', operator, slot,
        cycle_months: cycleMonths, at: new Date().toISOString(),
      }));
      return res.json({ ok: true, billing: r.rows[0] });
    }

    // Sem pagamento: upsert dos campos informados (COALESCE preserva existentes).
    const r = await pool.query(
      `INSERT INTO client_billing (slot, next_due_date, amount_cents, status, notes, created_at, updated_at)
       VALUES ($1, $2::date, $3, COALESCE($4, 'active'), $5, NOW(), NOW())
       ON CONFLICT (slot) DO UPDATE SET
         next_due_date = COALESCE($2::date, client_billing.next_due_date),
         amount_cents  = COALESCE($3, client_billing.amount_cents),
         status        = COALESCE($4, client_billing.status),
         notes         = COALESCE($5, client_billing.notes),
         updated_at    = NOW()
       RETURNING slot, to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date,
                 amount_cents, last_payment_at, status, notes, updated_at`,
      [slot, nextDueDate, amountCents, status, notes],
    );
    console.log(JSON.stringify({
      audit: 'billing-updated', operator, slot, at: new Date().toISOString(),
    }));
    res.json({ ok: true, billing: r.rows[0] });
  } catch (e) {
    console.error(JSON.stringify({ at: 'billing-put', pg_code: e?.code, pg_constraint: e?.constraint, msg: 'falha ao atualizar billing' }));
    res.status(500).json({ error: 'erro ao atualizar billing' });
  }
});

// ============================================================================
// GC de uploads órfãos (fix vazamento de disco — Missão uploads-disk-leak)
// ----------------------------------------------------------------------------
// Arquivos em MEDIA_STORAGE_DIR que não têm linha correspondente em bot_media
// ficaram órfãos antes do fix de unlink no delete/replace. Este endpoint lista
// (dry-run por padrão) e só apaga com { confirm: true } no corpo.
// Atrás do requireAuth global + CSRF (igual ao resto do painel).
// NUNCA apaga arquivo referenciado por alguma linha de mídia.
// ============================================================================
app.post('/api/admin/uploads/gc-orphans', async (req, res) => {
  const confirm = req.body?.confirm === true;
  try {
    // 1) Lista arquivos físicos no diretório de uploads (só arquivos, não subdirs).
    let dirEntries;
    try {
      dirEntries = await fs.promises.readdir(MEDIA_STORAGE_DIR, { withFileTypes: true });
    } catch (e) {
      if (e?.code === 'ENOENT') {
        return res.json({ ok: true, dry_run: !confirm, uploads_dir: MEDIA_STORAGE_DIR, orphans: [], orphan_count: 0, orphan_bytes: 0, deleted: 0 });
      }
      throw e;
    }
    const filesOnDisk = dirEntries.filter((d) => d.isFile()).map((d) => d.name);

    // 2) Conjunto de basenames referenciados pelo banco (apenas uploads locais nossos).
    const referenced = new Set();
    const rows = await pool.query('SELECT DISTINCT url FROM bot_media WHERE url IS NOT NULL');
    for (const { url } of rows.rows) {
      const abs = resolveLocalMediaPath(url, MEDIA_STORAGE_DIR, _MEDIA_PUBLIC_BASE);
      if (abs) referenced.add(path.basename(abs));
    }

    // 3) Órfãos = no disco e não referenciados.
    const orphanNames = computeOrphans(filesOnDisk, referenced);

    // 4) Coleta tamanho de cada órfão (e total) para o relatório.
    const orphans = [];
    let orphanBytes = 0;
    for (const name of orphanNames) {
      const abs = path.join(MEDIA_STORAGE_DIR, name);
      let size = null;
      try {
        const st = await fs.promises.stat(abs);
        size = st.size;
        orphanBytes += st.size;
      } catch { /* sumiu entre readdir e stat — ignora */ }
      orphans.push({ filename: name, size_bytes: size });
    }

    // 5) Dry-run por padrão: só apaga com confirm explícito.
    let deleted = 0;
    if (confirm) {
      for (const name of orphanNames) {
        // Reconfirma segurança: o nome veio de readdir do próprio storage, mas
        // resolvemos o caminho de novo para barrar qualquer coisa estranha.
        const localUrl = `${_MEDIA_PUBLIC_BASE}/${encodeURIComponent(name)}`;
        const abs = resolveLocalMediaPath(localUrl, MEDIA_STORAGE_DIR, _MEDIA_PUBLIC_BASE);
        if (!abs) continue; // defensivo
        try {
          await fs.promises.unlink(abs);
          deleted++;
        } catch (e) {
          if (e?.code === 'ENOENT') { deleted++; continue; }
          console.error('[gc-orphans]', JSON.stringify({ filename: name, code: e?.code, msg: e?.message }));
        }
      }
      console.log(JSON.stringify({
        audit: 'uploads-gc-orphans', operator: req.session?.userId || 'unknown',
        deleted, orphan_count: orphanNames.length, orphan_bytes: orphanBytes,
        at: new Date().toISOString(),
      }));
    }

    res.json({
      ok: true,
      dry_run: !confirm,
      uploads_dir: MEDIA_STORAGE_DIR,
      total_files: filesOnDisk.length,
      referenced_count: referenced.size,
      orphan_count: orphanNames.length,
      orphan_bytes: orphanBytes,
      orphans,
      deleted,
    });
  } catch (e) {
    console.error('[gc-orphans]', JSON.stringify({ at: 'gc-orphans', code: e?.code, msg: e?.message }));
    res.status(500).json({ error: 'erro ao coletar/limpar órfãos de uploads' });
  }
});

// ============================================================================
// SISTEMA DE ALERTAS INTERNO — config + destinatarios (Missao 021, Fase 1)
// Spec: docs/missoes/021-sistema-alertas-interno.md.
// Backend apenas; a sub-aba "Alertas" em Configuracoes vem na proxima onda
// (frontend-engineer). Todas as rotas atras do requireAuth global + CSRF para
// mutacoes (aplicado globalmente em /api/* mais acima). Config e GLOBAL (alerta
// do time) — sem tenant key. NAO envia WhatsApp daqui; o envio e do worker
// (job monitor) atras da flag ALERTS_ENABLED.
// ============================================================================

const ALERTS_MAX_RECIPIENTS = 5;
// E.164 so digitos: 8 a 15 digitos (recomendacao ITU-T). Sem "+", sem mascara.
const ALERTS_PHONE_RE = /^[1-9]\d{7,14}$/;

// Normaliza telefone recebido (com +, mascara, espacos) -> so digitos.
function _alertsNormalizePhone(raw) {
  return String(raw ?? '').replace(/\D/g, '');
}

// ---------- GET /api/alerts/config — le a config global (1 linha) ----------
app.get('/api/alerts/config', async (_req, res) => {
  try {
    await pool.query(`INSERT INTO alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const r = await pool.query(
      `SELECT id, enabled, sender_slot, cooldown_min, check_waha, check_health, check_host, updated_at
         FROM alert_config WHERE id = 1`,
    );
    res.json({ config: r.rows[0] });
  } catch (e) {
    console.error(JSON.stringify({ at: 'alerts-config-get', pg_code: e?.code, msg: 'falha ao ler config de alertas' }));
    res.status(500).json({ error: 'erro ao ler config de alertas' });
  }
});

// ---------- PUT /api/alerts/config — patch parcial da config global ----------
// Body: { enabled?, sender_slot?, cooldown_min?, check_waha?, check_health?, check_host? }
app.put('/api/alerts/config', async (req, res) => {
  try {
    const b = req.body ?? {};
    const sets = [];
    const vals = [];
    const addBool = (col, v) => { vals.push(Boolean(v)); sets.push(`${col} = $${vals.length}`); };

    if (b.enabled !== undefined) addBool('enabled', b.enabled);
    if (b.check_waha !== undefined) addBool('check_waha', b.check_waha);
    if (b.check_health !== undefined) addBool('check_health', b.check_health);
    if (b.check_host !== undefined) addBool('check_host', b.check_host);
    if (b.sender_slot !== undefined) {
      const slot = String(b.sender_slot).trim();
      if (!slot || slot.length > 40) return res.status(400).json({ error: 'sender_slot invalido' });
      vals.push(slot); sets.push(`sender_slot = $${vals.length}`);
    }
    if (b.cooldown_min !== undefined) {
      const cd = Number(b.cooldown_min);
      if (!Number.isInteger(cd) || cd < 5) return res.status(400).json({ error: 'cooldown_min minimo 5' });
      vals.push(cd); sets.push(`cooldown_min = $${vals.length}`);
    }

    await pool.query(`INSERT INTO alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    if (sets.length === 0) {
      const cur = await pool.query(
        `SELECT id, enabled, sender_slot, cooldown_min, check_waha, check_health, check_host, updated_at
           FROM alert_config WHERE id = 1`,
      );
      return res.json({ config: cur.rows[0] });
    }
    sets.push('updated_at = NOW()');
    const r = await pool.query(
      `UPDATE alert_config SET ${sets.join(', ')} WHERE id = 1
       RETURNING id, enabled, sender_slot, cooldown_min, check_waha, check_health, check_host, updated_at`,
      vals,
    );
    console.log(JSON.stringify({
      audit: 'alerts-config-updated', operator: req.session?.userId || 'unknown',
      enabled: r.rows[0]?.enabled, at: new Date().toISOString(),
    }));
    res.json({ ok: true, config: r.rows[0] });
  } catch (e) {
    console.error(JSON.stringify({ at: 'alerts-config-put', pg_code: e?.code, msg: 'falha ao atualizar config de alertas' }));
    res.status(500).json({ error: 'erro ao atualizar config de alertas' });
  }
});

// ---------- GET /api/alerts/recipients — lista destinatarios ----------
app.get('/api/alerts/recipients', async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, phone, label, enabled, created_at FROM alert_recipients ORDER BY created_at ASC`,
    );
    res.json({ count: r.rows.length, max: ALERTS_MAX_RECIPIENTS, recipients: r.rows });
  } catch (e) {
    console.error(JSON.stringify({ at: 'alerts-recipients-list', pg_code: e?.code, msg: 'falha ao listar destinatarios' }));
    res.status(500).json({ error: 'erro ao listar destinatarios' });
  }
});

// ---------- POST /api/alerts/recipients — cria destinatario (max 5) ----------
// Body: { phone: string (E.164/digitos), label?: string }
app.post('/api/alerts/recipients', async (req, res) => {
  const client = await pool.connect();
  try {
    const phone = _alertsNormalizePhone(req.body?.phone);
    const label = req.body?.label != null ? String(req.body.label).trim().slice(0, 60) : null;
    if (!ALERTS_PHONE_RE.test(phone)) {
      return res.status(400).json({ error: 'telefone invalido (E.164 so digitos, 8 a 15 digitos, sem +)' });
    }

    await client.query('BEGIN');
    const cnt = await client.query(`SELECT COUNT(*)::int AS c FROM alert_recipients`);
    if ((cnt.rows[0]?.c ?? 0) >= ALERTS_MAX_RECIPIENTS) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `limite de ${ALERTS_MAX_RECIPIENTS} destinatarios atingido` });
    }
    const dup = await client.query(`SELECT 1 FROM alert_recipients WHERE phone = $1 LIMIT 1`, [phone]);
    if ((dup.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'telefone ja cadastrado' });
    }
    const ins = await client.query(
      `INSERT INTO alert_recipients (phone, label) VALUES ($1, $2)
       RETURNING id, phone, label, enabled, created_at`,
      [phone, label],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({
      audit: 'alerts-recipient-created', operator: req.session?.userId || 'unknown',
      recipient_id: ins.rows[0]?.id, at: new Date().toISOString(),
    }));
    res.status(201).json({ ok: true, recipient: ins.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ at: 'alerts-recipients-create', pg_code: e?.code, msg: 'falha ao criar destinatario' }));
    res.status(500).json({ error: 'erro ao criar destinatario' });
  } finally {
    client.release();
  }
});

// ---------- PATCH /api/alerts/recipients/:id — toggle enabled / editar label ----------
// Body: { enabled?: bool, label?: string }
app.patch('/api/alerts/recipients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id invalido' });
    const sets = [];
    const vals = [];
    if (req.body?.enabled !== undefined) { vals.push(Boolean(req.body.enabled)); sets.push(`enabled = $${vals.length}`); }
    if (req.body?.label !== undefined) {
      const label = req.body.label != null ? String(req.body.label).trim().slice(0, 60) : null;
      vals.push(label); sets.push(`label = $${vals.length}`);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'nada a atualizar' });
    vals.push(id);
    const r = await pool.query(
      `UPDATE alert_recipients SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, phone, label, enabled, created_at`,
      vals,
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'destinatario nao encontrado' });
    res.json({ ok: true, recipient: r.rows[0] });
  } catch (e) {
    console.error(JSON.stringify({ at: 'alerts-recipients-patch', pg_code: e?.code, msg: 'falha ao atualizar destinatario' }));
    res.status(500).json({ error: 'erro ao atualizar destinatario' });
  }
});

// ---------- DELETE /api/alerts/recipients/:id ----------
app.delete('/api/alerts/recipients/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id invalido' });
    const r = await pool.query(`DELETE FROM alert_recipients WHERE id = $1`, [id]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'destinatario nao encontrado' });
    console.log(JSON.stringify({
      audit: 'alerts-recipient-deleted', operator: req.session?.userId || 'unknown',
      recipient_id: id, at: new Date().toISOString(),
    }));
    res.json({ ok: true });
  } catch (e) {
    console.error(JSON.stringify({ at: 'alerts-recipients-delete', pg_code: e?.code, msg: 'falha ao remover destinatario' }));
    res.status(500).json({ error: 'erro ao remover destinatario' });
  }
});

// ---------- POST /api/alerts/test — dispara UM alerta de teste on-demand ------
// Onda 2, parte 1 (o "Enviar teste" adiado no #281).
// Body (opcional): { phone?: string }  — se vier, envia SO pra esse numero;
//   senao envia pra todos os destinatarios HABILITADOS em alert_recipients.
//
// Contrato/decisoes:
//  - On-demand: funciona MESMO com ALERTS_ENABLED off e alert_config.enabled off.
//    O objetivo e validar o envio ANTES de ligar o monitoramento (nao usa o cron).
//  - Remetente: alert_config.sender_slot (default 'startap' = Lola/STARTAP_AI_PROD),
//    resolvido para a sessao WAHA via bot_config.waha_sessao. Espelha getSenderSession()
//    de packages/db/src/queries/alerts.ts (painel e JS standalone, sem build-time dep).
//  - Envio reaproveita WAHA_URL + WAHA_API_KEY (process.env, ja em escopo — sem extrair
//    segredo de container) batendo no mesmo /api/sendText que packages/integrations usa.
//  - Anti-abuso: cooldown curto por operador (in-memory) pra o botao nao virar
//    metralhadora pra Lola. Painel e single-operador; cooldown em memoria basta.
//  - Erro de WAHA por destinatario NAO derruba a rota: resposta traz sucesso/falha
//    item a item pra UI mostrar "enviado pro +55... ok".

const ALERTS_TEST_COOLDOWN_MS = 15_000;
const _alertsTestLastSendByUser = new Map(); // userId -> epoch ms do ultimo envio

// Envia um texto via WAHA reaproveitando a config ja usada pelo painel.
// Resolve via /api/sendText (mesmo endpoint de packages/integrations/waha/client).
// timeout explicito (Regra 7) pra nunca aguardar WAHA infinito.
async function _alertsSendText(sessao, chatId, texto, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${WAHA_URL}/api/sendText`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WAHA_API_KEY ? { 'X-Api-Key': WAHA_API_KEY } : {}),
      },
      body: JSON.stringify({ session: sessao, chatId, text: texto }),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new Error(`WAHA HTTP ${r.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    }
  } finally {
    clearTimeout(t);
  }
}

app.post('/api/alerts/test', async (req, res) => {
  const userId = req.session?.userId || 'unknown';

  // Cooldown anti-spam por operador.
  const now = Date.now();
  const last = _alertsTestLastSendByUser.get(userId) ?? 0;
  const waitMs = ALERTS_TEST_COOLDOWN_MS - (now - last);
  if (waitMs > 0) {
    return res.status(429).json({
      error: 'aguarde alguns segundos antes de enviar outro teste',
      retry_after_s: Math.ceil(waitMs / 1000),
    });
  }

  try {
    // 1) Resolve a sessao remetente (sender_slot -> bot_config.waha_sessao).
    await pool.query(`INSERT INTO alert_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
    const cfg = await pool.query(`SELECT sender_slot FROM alert_config WHERE id = 1`);
    const senderSlot = cfg.rows[0]?.sender_slot || 'startap';
    const sess = await pool.query(`SELECT waha_sessao FROM bot_config WHERE slot = $1`, [senderSlot]);
    const sessao = sess.rows[0]?.waha_sessao || null;
    if (!sessao) {
      return res.status(409).json({
        error: `remetente '${senderSlot}' sem sessao WAHA configurada (bot_config.waha_sessao)`,
      });
    }

    // 2) Monta a lista de destinatarios: numero do body (so ele) OU habilitados.
    let targets; // [{ phone, label }]
    if (req.body?.phone != null && String(req.body.phone).trim() !== '') {
      const phone = _alertsNormalizePhone(req.body.phone);
      if (!ALERTS_PHONE_RE.test(phone)) {
        return res.status(400).json({ error: 'telefone invalido (E.164 so digitos, 8 a 15 digitos, sem +)' });
      }
      targets = [{ phone, label: null }];
    } else {
      const r = await pool.query(
        `SELECT phone, label FROM alert_recipients WHERE enabled = TRUE ORDER BY created_at ASC`,
      );
      targets = r.rows;
    }

    if (targets.length === 0) {
      return res.status(400).json({ error: 'cadastre ao menos um numero antes de enviar o teste' });
    }

    // Marca o cooldown ANTES de enviar — evita corrida de duplo-clique.
    _alertsTestLastSendByUser.set(userId, now);

    const texto =
      '🔔 Teste de alerta — Startap. Se você recebeu isto, os alertas estão funcionando.';

    // 3) Envia 1 a 1, coletando sucesso/falha sem derrubar a rota.
    const results = [];
    for (const t of targets) {
      const chatId = `${t.phone}@c.us`;
      try {
        await _alertsSendText(sessao, chatId, texto);
        results.push({ phone: t.phone, label: t.label ?? null, ok: true });
      } catch (err) {
        results.push({
          phone: t.phone,
          label: t.label ?? null,
          ok: false,
          error: err?.name === 'AbortError' ? 'timeout ao contatar WAHA' : (err?.message || 'falha no envio'),
        });
      }
    }

    const sent = results.filter((r) => r.ok).length;
    console.log(JSON.stringify({
      audit: 'alerts-test-sent', operator: userId, sender_slot: senderSlot,
      sessao, total: results.length, sent, failed: results.length - sent,
      at: new Date().toISOString(),
    }));

    // 200 se ao menos 1 chegou; 502 se TODOS falharam (problema de WAHA/sessao).
    const status = sent > 0 ? 200 : 502;
    res.status(status).json({ ok: sent > 0, sender_slot: senderSlot, sessao, sent, total: results.length, results });
  } catch (e) {
    // Falha inesperada (ex.: banco) — libera o cooldown pra o operador tentar de novo.
    _alertsTestLastSendByUser.delete(userId);
    console.error(JSON.stringify({ at: 'alerts-test', pg_code: e?.code, msg: 'falha ao enviar alerta de teste' }));
    res.status(500).json({ error: 'erro ao enviar alerta de teste' });
  }
});

// ============================================================================
// COLABORADORES (estabelecimento) + PACOTES (templates / venda / saldo).
// Bloco 3 (frontend-engineer). ADR 0023 (colaboradores) + ADR 0025 (pacotes).
//
// Escopo por CLONE: toda rota recebe o id do clone na URL, resolve slot + tenant_id
// de flow_clones e carimba tenant_id em todo INSERT (isolamento — migrations 053-057).
// Todas atras do requireAuth global + CSRF para mutacoes (aplicado em /api/* acima).
//
// O painel e JS standalone (sem build-time dep do @startap/*): os helpers puros abaixo
// ESPELHAM packages/core (phone.ts / package-phone.ts). MANTER EM SYNC — testados em
// test/pacotes-phone.test.js (mesmo padrao de media-unlink/servicos-duracao).
//
// FISCAL (ADR 0025 §5): preco_cents do pacote e INFORMATIVO (caixa do barbeiro). NAO
// toca AbacatePay / client_billing / billing_charges / MRR. So rastreamos o SALDO.
// O LEDGER (package_redemptions) so e escrito pelo BOT (deducao 2b, #321) — o painel
// nunca desconta/estorna; aqui so DEFINE template, VENDE credito e LE saldo/extrato.
// ============================================================================

// ── Helpers puros (espelho de packages/core) — testados isoladamente ──────────

// Espelho de canonicalE164 (packages/core/src/phone.ts). So digitos com DDI ou null.
function _pkgCanonicalE164(raw) {
  if (!raw) return null;
  const base = String(raw).split('@')[0]?.split(':')[0] ?? '';
  let digits = base.replace(/\D/g, '').replace(/^0+/, '');
  if (digits.length < 10 || digits.length > 15) return null;
  if (digits.length === 10 || digits.length === 11) digits = `55${digits}`;
  if (digits.startsWith('55')) {
    if (digits.length === 13 && digits[4] === '9') return digits.slice(0, 4) + digits.slice(5);
    if (digits.length === 12) return digits;
    if (digits.length === 13) return digits;
    return null;
  }
  return digits;
}

// Espelho de phoneHint (packages/core/src/phone.ts). Mascara LGPD: DDD + 2 ultimos.
function _pkgPhoneHint(canonical) {
  const digits = String(canonical).replace(/\D/g, '');
  const last2 = digits.slice(-2);
  if (digits.startsWith('55') && digits.length >= 12) {
    const ddd = digits.slice(2, 4);
    return `+55 ${ddd} •••••-••${last2}`;
  }
  return `+${digits.slice(0, 2)} •••••-••${last2}`;
}

// Espelho de packagePhoneHmac (packages/core/src/package-phone.ts). Pepper PROPRIO,
// validacao LAZY: lanca se ausente/curto (chamador devolve 409, nunca crasha o boot).
const _PKG_PEPPER_MIN = 16;
function _pkgIsPepperConfigured() {
  return !!PACKAGE_PHONE_PEPPER && PACKAGE_PHONE_PEPPER.trim().length >= _PKG_PEPPER_MIN;
}
function _pkgPhoneHmac(canonicalPhone) {
  if (!_pkgIsPepperConfigured()) {
    throw new Error('PACKAGE_PHONE_PEPPER ausente ou curta demais (min 16 chars)');
  }
  return crypto.createHmac('sha256', PACKAGE_PHONE_PEPPER.trim()).update(canonicalPhone, 'utf8').digest('hex');
}

// Normaliza array de nomes de servico (trim, sem vazio, dedup case-insensitive, max 50).
function _pkgNormalizeServicos(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const s = String(raw ?? '').trim().slice(0, 80);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 50) break;
  }
  return out;
}

// Chave de comparacao de servico: trim + lowercase (espelha servicoKey do @startap/db).
function _pkgServicoKey(s) {
  return String(s ?? '').trim().toLowerCase();
}

// Le o catalogo de servicos do clone (flow_clones.servicos = [{nome,...}]) como Set
// de chaves normalizadas. Usa o CLIENT da transacao + o MESMO slot (isolamento).
// Catalogo vazio/ausente -> Set vazio (nenhum servico vinculavel).
async function _pkgGetCatalogoKeys(client, slot) {
  const r = await client.query(`SELECT servicos FROM flow_clones WHERE slot = $1 LIMIT 1`, [slot]);
  const raw = r.rows[0]?.servicos;
  const keys = new Set();
  if (!Array.isArray(raw)) return keys;
  for (const item of raw) {
    const nome = item && typeof item === 'object' ? item.nome : item;
    const key = _pkgServicoKey(nome);
    if (key) keys.add(key);
  }
  return keys;
}

// Valida que todo servico vinculado a um colaborador existe no catalogo do clone
// (por nome, case/trim-insensitive). Retorna o nome do 1o servico invalido, ou null
// se todos existem. Lista vazia -> null (colaborador sem servico = fallback p/ todos).
// Coracao do fix: sem isso, "cirurgia" (free-text) entrava direto no banco.
async function _pkgServicosForaDoCatalogo(client, slot, servicos) {
  if (!Array.isArray(servicos) || servicos.length === 0) return null;
  const catalogo = await _pkgGetCatalogoKeys(client, slot);
  for (const s of servicos) {
    if (!catalogo.has(_pkgServicoKey(s))) return s;
  }
  return null;
}

// Resolve { slot, tenant_id, product_type, seat_cap } de um clone pelo id (404 se nao existe).
// tenant_id e NOT NULL nas tabelas novas; flow_clones.tenant_id sempre populado (migr 045).
async function _resolveCloneScope(cloneId) {
  const id = Number(cloneId);
  if (!Number.isInteger(id) || id <= 0) return { error: 'id de clone invalido', status: 400 };
  const r = await pool.query(
    `SELECT id, slot, tenant_id, product_type, seat_cap FROM flow_clones WHERE id = $1`,
    [id],
  );
  if (r.rowCount === 0) return { error: 'clone nao encontrado', status: 404 };
  const row = r.rows[0];
  if (!row.tenant_id) return { error: 'clone sem tenant_id (dado inconsistente)', status: 409 };
  return { scope: row };
}

// ───────────────────────── COLABORADORES (estabelecimento) ───────────────────

// GET /api/clones/:id/colaboradores — lista colaboradores + uso de vagas (seat_cap).
app.get('/api/clones/:id/colaboradores', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, product_type, seat_cap } = resolved.scope;

    // O clone tem Service Account gravada? Sem ela, NENHUM colaborador agenda de
    // verdade (getGcalsForSlot retorna [] — per-clone.ts). Usamos isso pra (a)
    // informar o front (clone_has_sa) e (b) corrigir "active mentiroso" (abaixo).
    const saRow = await pool.query(
      `SELECT gcal_credentials_json IS NOT NULL AS has_sa FROM flow_clones WHERE id = $1`,
      [resolved.scope.id],
    );
    const cloneHasSa = saRow.rows[0]?.has_sa === true;

    // BACKFILL leve / corretivo: se o clone NÃO tem SA, qualquer colaborador
    // marcado 'active' é verde-falso (nunca passou por um teste real possível) —
    // volta pra 'pending'. Idempotente: só toca linhas active deste slot. Assim,
    // ex. barber_dragon (3 colabs 'active' fake, clone sem SA) aparece como
    // "precisa testar" e o operador sabe que falta subir o JSON + testar cada um.
    if (product_type === 'estabelecimento' && !cloneHasSa) {
      const fixed = await pool.query(
        `UPDATE clone_colaboradores
            SET gcal_status = 'pending', updated_at = NOW()
          WHERE slot = $1 AND gcal_status = 'active'`,
        [slot],
      );
      if (fixed.rowCount > 0) {
        console.log(JSON.stringify({ audit: 'colaborador-gcal-active-reset', slot, count: fixed.rowCount, reason: 'clone_sem_service_account', at: new Date().toISOString() }));
      }
    }

    const r = await pool.query(
      `SELECT id, nome, gcal_calendar_id, gcal_status, servicos, ativo, ordem, created_at, updated_at
         FROM clone_colaboradores WHERE slot = $1 ORDER BY ordem ASC, id ASC`,
      [slot],
    );
    const ativos = r.rows.filter((c) => c.ativo === true).length;
    res.json({
      product_type,
      seat_cap: seat_cap === null ? null : Number(seat_cap),
      usados: ativos,
      clone_has_sa: cloneHasSa,
      colaboradores: r.rows,
    });
  } catch (e) {
    console.error(JSON.stringify({ at: 'colaboradores-list', pg_code: e?.code, msg: 'falha ao listar colaboradores' }));
    res.status(500).json({ error: 'erro ao listar colaboradores' });
  }
});

// POST /api/clones/:id/colaboradores — cria colaborador (respeita seat_cap p/ ATIVOS).
// Body: { nome, gcal_calendar_id?, servicos?: string[], ativo?: bool, ordem?: int }
app.post('/api/clones/:id/colaboradores', async (req, res) => {
  const client = await pool.connect();
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id, product_type, seat_cap } = resolved.scope;
    if (product_type !== 'estabelecimento') {
      return res.status(409).json({ error: 'colaboradores so existem em clientes do tipo estabelecimento' });
    }
    const nome = String(req.body?.nome ?? '').trim().slice(0, 160);
    if (!nome) return res.status(400).json({ error: 'nome obrigatorio' });
    const gcalId = req.body?.gcal_calendar_id != null ? String(req.body.gcal_calendar_id).trim().slice(0, 500) || null : null;
    const servicos = _pkgNormalizeServicos(req.body?.servicos);
    const ativo = req.body?.ativo === undefined ? true : Boolean(req.body.ativo);
    const ordem = Number.isInteger(Number(req.body?.ordem)) ? Number(req.body.ordem) : 0;
    // Status SEMPRE nasce 'pending'. Ter um calendarId NÃO prova que a agenda foi
    // compartilhada com a SA do clone — só o endpoint /gcal/test (que bate no Google)
    // promove para 'active'. Fim do "badge verde mentiroso".
    const gcalStatus = 'pending';

    await client.query('BEGIN');
    // Teto: conta SO os ativos (vaga ocupada = colaborador ativo). seat_cap NULL = sem teto.
    if (ativo && seat_cap !== null) {
      const cnt = await client.query(
        `SELECT COUNT(*)::int AS c FROM clone_colaboradores WHERE slot = $1 AND ativo = TRUE`,
        [slot],
      );
      if ((cnt.rows[0]?.c ?? 0) >= Number(seat_cap)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: `limite do plano atingido (${seat_cap} vagas). Desative um colaborador ou aumente o plano.` });
      }
    }
    // Coracao do fix: todo servico vinculado tem que existir no catalogo do clone.
    const svFora = await _pkgServicosForaDoCatalogo(client, slot, servicos);
    if (svFora !== null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: `o serviço "${svFora}" não existe no catálogo deste cliente — cadastre na aba Serviços antes de vinculá-lo ao colaborador`, code: 'unknown_servico' });
    }
    const ins = await client.query(
      `INSERT INTO clone_colaboradores (slot, tenant_id, nome, gcal_calendar_id, gcal_status, servicos, ativo, ordem)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, nome, gcal_calendar_id, gcal_status, servicos, ativo, ordem, created_at, updated_at`,
      [slot, tenant_id, nome, gcalId, gcalStatus, JSON.stringify(servicos), ativo, ordem],
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({ audit: 'colaborador-created', operator: req.session?.userId || 'unknown', slot, colaborador_id: ins.rows[0]?.id, at: new Date().toISOString() }));
    res.status(201).json({ ok: true, colaborador: ins.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e?.code === '23505') return res.status(409).json({ error: 'ja existe um colaborador com esse nome neste estabelecimento' });
    console.error(JSON.stringify({ at: 'colaboradores-create', pg_code: e?.code, msg: 'falha ao criar colaborador' }));
    res.status(500).json({ error: 'erro ao criar colaborador' });
  } finally {
    client.release();
  }
});

// PATCH /api/clones/:id/colaboradores/:colabId — edita campos (respeita seat_cap ao ATIVAR).
app.patch('/api/clones/:id/colaboradores/:colabId', async (req, res) => {
  const client = await pool.connect();
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, seat_cap } = resolved.scope;
    const colabId = Number(req.params.colabId);
    if (!Number.isInteger(colabId) || colabId <= 0) return res.status(400).json({ error: 'colabId invalido' });

    const sets = [];
    const vals = [];
    const b = req.body ?? {};
    // Servicos normalizados quando o patch os inclui (validados contra o catalogo
    // DENTRO da transacao, abaixo). null = patch nao mexe em servicos.
    let servicosToValidate = null;
    if (b.nome !== undefined) {
      const nome = String(b.nome).trim().slice(0, 160);
      if (!nome) return res.status(400).json({ error: 'nome nao pode ser vazio' });
      vals.push(nome); sets.push(`nome = $${vals.length}`);
    }
    if (b.gcal_calendar_id !== undefined) {
      const gcalId = b.gcal_calendar_id != null ? String(b.gcal_calendar_id).trim().slice(0, 500) || null : null;
      vals.push(gcalId); const gcalPh = vals.length; sets.push(`gcal_calendar_id = $${gcalPh}`);
      // Trocar/limpar o calendarId reseta para 'pending' — a confiança de 'active' só
      // vem do /gcal/test que valida no Google. Nunca promovemos por presença de string.
      // MAS: se o calendarId NÃO mudou, preservamos o status atual ('active'/'invalid' do
      // teste) — senão um "salvar" logo após o "testar verde" apagava o 'active' e o
      // colaborador voltava a 'pending' (bot ficava em silêncio). O CASE compara o valor
      // ANTIGO da coluna (pré-update) com o novo (mesmo placeholder $gcalPh).
      sets.push(`gcal_status = CASE WHEN gcal_calendar_id IS DISTINCT FROM $${gcalPh} THEN 'pending' ELSE gcal_status END`);
    }
    if (b.servicos !== undefined) {
      servicosToValidate = _pkgNormalizeServicos(b.servicos);
      vals.push(JSON.stringify(servicosToValidate)); sets.push(`servicos = $${vals.length}::jsonb`);
    }
    if (b.ordem !== undefined) {
      const ordem = Number(b.ordem);
      if (!Number.isInteger(ordem)) return res.status(400).json({ error: 'ordem deve ser inteiro' });
      vals.push(ordem); sets.push(`ordem = $${vals.length}`);
    }

    await client.query('BEGIN');
    // Coracao do fix (PATCH): se o patch troca os servicos, todo nome tem que existir
    // no catalogo do clone. Roda dentro da transacao (mesmo client/slot).
    if (servicosToValidate !== null) {
      const svFora = await _pkgServicosForaDoCatalogo(client, slot, servicosToValidate);
      if (svFora !== null) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `o serviço "${svFora}" não existe no catálogo deste cliente — cadastre na aba Serviços antes de vinculá-lo ao colaborador`, code: 'unknown_servico' });
      }
    }
    // Ativar consome vaga: checa seat_cap se estiver virando ativo.
    if (b.ativo !== undefined) {
      const ativo = Boolean(b.ativo);
      if (ativo && seat_cap !== null) {
        const cnt = await client.query(
          `SELECT COUNT(*)::int AS c FROM clone_colaboradores WHERE slot = $1 AND ativo = TRUE AND id <> $2`,
          [slot, colabId],
        );
        if ((cnt.rows[0]?.c ?? 0) >= Number(seat_cap)) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: `limite do plano atingido (${seat_cap} vagas).` });
        }
      }
      vals.push(ativo); sets.push(`ativo = $${vals.length}`);
    }
    if (sets.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'nada a atualizar' }); }
    sets.push('updated_at = NOW()');
    vals.push(slot); vals.push(colabId);
    const r = await client.query(
      `UPDATE clone_colaboradores SET ${sets.join(', ')} WHERE slot = $${vals.length - 1} AND id = $${vals.length}
       RETURNING id, nome, gcal_calendar_id, gcal_status, servicos, ativo, ordem, created_at, updated_at`,
      vals,
    );
    if (r.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'colaborador nao encontrado neste clone' }); }
    await client.query('COMMIT');
    console.log(JSON.stringify({ audit: 'colaborador-updated', operator: req.session?.userId || 'unknown', slot, colaborador_id: colabId, at: new Date().toISOString() }));
    res.json({ ok: true, colaborador: r.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e?.code === '23505') return res.status(409).json({ error: 'ja existe um colaborador com esse nome neste estabelecimento' });
    console.error(JSON.stringify({ at: 'colaboradores-patch', pg_code: e?.code, msg: 'falha ao atualizar colaborador' }));
    res.status(500).json({ error: 'erro ao atualizar colaborador' });
  } finally {
    client.release();
  }
});

// DELETE /api/clones/:id/colaboradores/:colabId — remove colaborador (escopado por slot).
app.delete('/api/clones/:id/colaboradores/:colabId', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot } = resolved.scope;
    const colabId = Number(req.params.colabId);
    if (!Number.isInteger(colabId) || colabId <= 0) return res.status(400).json({ error: 'colabId invalido' });
    const r = await pool.query(`DELETE FROM clone_colaboradores WHERE slot = $1 AND id = $2`, [slot, colabId]);
    if (r.rowCount === 0) return res.status(404).json({ error: 'colaborador nao encontrado neste clone' });
    console.log(JSON.stringify({ audit: 'colaborador-deleted', operator: req.session?.userId || 'unknown', slot, colaborador_id: colabId, at: new Date().toISOString() }));
    res.json({ ok: true });
  } catch (e) {
    // FK de service_packages.colaborador_id e ON DELETE SET NULL — nao deve bloquear.
    console.error(JSON.stringify({ at: 'colaboradores-delete', pg_code: e?.code, msg: 'falha ao remover colaborador' }));
    res.status(500).json({ error: 'erro ao remover colaborador' });
  }
});

// POST /api/clones/:id/colaboradores/:colabId/gcal/test
// Testa a agenda de UM colaborador no Google de verdade: usa a Service Account do
// CLONE (flow_clones.gcal_credentials_json) + o calendarId DO COLABORADOR e roda
// testConnection(). É a ÚNICA via que promove o colaborador para gcal_status='active'.
// Espelha /api/clones/:id/gcal/test (individual), mas com a creds do clone e o
// calendarId do colaborador. ADR 0024 §2 (1 SA do clone, N calendarIds).
app.post('/api/clones/:id/colaboradores/:colabId/gcal/test', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id, product_type } = resolved.scope;
    if (product_type !== 'estabelecimento') {
      return res.status(409).json({ error: 'teste por colaborador so existe em clientes do tipo estabelecimento' });
    }
    const colabId = Number(req.params.colabId);
    if (!Number.isInteger(colabId) || colabId <= 0) return res.status(400).json({ error: 'colabId invalido' });

    // Carrega a creds do CLONE + o calendarId do COLABORADOR num JOIN escopado por
    // slot E tenant_id (anti-IDOR: o colaborador tem que pertencer a este clone/tenant).
    const r = await pool.query(
      `SELECT fc.gcal_credentials_json AS clone_creds,
              fc.gcal_client_email     AS clone_email,
              cc.gcal_calendar_id      AS colab_calendar_id
         FROM flow_clones fc
         JOIN clone_colaboradores cc
           ON cc.slot = fc.slot AND cc.tenant_id = fc.tenant_id
        WHERE fc.id = $1 AND cc.id = $2 AND fc.tenant_id = $3`,
      [resolved.scope.id, colabId, tenant_id],
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'colaborador nao encontrado neste clone' });

    const { clone_creds, clone_email, colab_calendar_id } = r.rows[0];
    // Sem a SA do clone não há o que testar — instrui o operador a setar a SA primeiro.
    if (!clone_creds) {
      return res.status(422).json({ error: 'clone_sem_service_account' });
    }
    if (!colab_calendar_id) {
      return res.status(400).json({ error: 'colaborador sem gcal_calendar_id — informe o ID da agenda antes de testar' });
    }

    // Import dinâmico (mesmo padrão do teste individual) — evita dep. circular no legado.
    let testResult;
    let decryptedCreds;
    try {
      decryptedCreds = decryptGcalCredentials(clone_creds);
      const { GoogleCalendarClient } = await import(
        '../packages/integrations/dist/google-calendar/client.js'
      );
      const client = new GoogleCalendarClient({
        credentialsJson: decryptedCreds,
        calendarId: colab_calendar_id,
      });
      testResult = await client.testConnection();
    } catch (importErr) {
      testResult = { ok: false, error: `Falha ao carregar cliente GCal: ${importErr.message}` };
    }

    const newStatus = testResult.ok ? 'active' : 'invalid';
    console.log(`[gcal] TEST colaborador slot=${slot} colab=${colabId} (${clone_email}): ${newStatus}`);

    // Persiste o status REAL (active só quando o Google respondeu OK). Escopo por slot+id.
    await pool.query(
      `UPDATE clone_colaboradores SET gcal_status = $1, updated_at = NOW() WHERE slot = $2 AND id = $3`,
      [newStatus, slot, colabId],
    );

    // Invalida o cache in-process do bot runtime quando alcançável (mesmo processo).
    // No deploy atual o painel roda em processo separado do bot → no-op; o cache do
    // resolvedor expira em 5min (CACHE_TTL_MS). Tech debt conhecida (ver corpo do PR).
    try {
      const perClone = await import('../packages/integrations/dist/google-calendar/per-clone.js');
      if (typeof perClone.invalidateGcalsForSlot === 'function') {
        perClone.invalidateGcalsForSlot(slot);
      }
    } catch { /* módulo não carregável aqui = ok, TTL cobre */ }

    const enriched = testResult.ok ? null : enrichGcalError(testResult.error, decryptedCreds);
    res.json({
      ok: testResult.ok,
      status: newStatus,
      error: testResult.ok ? undefined : testResult.error,
      errorCode: enriched?.code,
      errorHint: enriched?.hint,
      errorLink: enriched?.link,
    });
  } catch (e) {
    console.error(JSON.stringify({ at: 'colaborador-gcal-test', pg_code: e?.code, msg: 'falha ao testar gcal do colaborador' }));
    res.status(500).json({ error: 'erro ao testar conexao do colaborador' });
  }
});

// ───────────────────────── PACOTES — TEMPLATES (service_packages) ─────────────

// Valida o corpo de um template de pacote. Retorna { error } ou { value }.
function _validatePacoteTemplate(b, { partial = false } = {}) {
  const out = {};
  const need = (k) => !partial || b[k] !== undefined;

  if (need('nome')) {
    const nome = String(b?.nome ?? '').trim().slice(0, 160);
    if (!nome) return { error: 'nome do pacote obrigatorio' };
    out.nome = nome;
  }
  if (b?.descricao !== undefined) out.descricao = b.descricao != null ? String(b.descricao).trim().slice(0, 2000) || null : null;
  if (need('total_sessoes')) {
    const tot = Number(b?.total_sessoes);
    if (!Number.isInteger(tot) || tot < 1 || tot > 1000) return { error: 'total de sessoes deve ser inteiro entre 1 e 1000' };
    out.total_sessoes = tot;
  }
  if (b?.servicos_cobertos !== undefined) out.servicos_cobertos = _pkgNormalizeServicos(b.servicos_cobertos);
  if (b?.preco_cents !== undefined) {
    if (b.preco_cents === null || b.preco_cents === '') { out.preco_cents = null; }
    else {
      const cents = Number(b.preco_cents);
      if (!Number.isInteger(cents) || cents < 0 || cents > 100_000_000) return { error: 'preco_cents invalido' };
      out.preco_cents = cents;
    }
  }
  // Validade: EXATAMENTE um dos dois (dias OU data fixa). No create, obrigatorio um.
  const hasDias = b?.validade_dias !== undefined && b.validade_dias !== null && b.validade_dias !== '';
  const hasData = b?.data_validade_fixa !== undefined && b.data_validade_fixa !== null && b.data_validade_fixa !== '';
  if (hasDias && hasData) return { error: 'use validade em DIAS ou DATA FIXA, nao os dois' };
  if (hasDias) {
    const dias = Number(b.validade_dias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return { error: 'validade em dias deve ser inteiro entre 1 e 3650' };
    out.validade_dias = dias; out.data_validade_fixa = null;
  } else if (hasData) {
    const d = String(b.data_validade_fixa).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return { error: 'data de validade deve ser AAAA-MM-DD' };
    out.data_validade_fixa = d; out.validade_dias = null;
  } else if (!partial) {
    return { error: 'informe a validade: dias OU data fixa' };
  }
  // colaborador_id: NULL = casa inteira; preenchido = so com aquele colaborador.
  if (b?.colaborador_id !== undefined) {
    if (b.colaborador_id === null || b.colaborador_id === '') out.colaborador_id = null;
    else {
      const cid = Number(b.colaborador_id);
      if (!Number.isInteger(cid) || cid <= 0) return { error: 'colaborador_id invalido' };
      out.colaborador_id = cid;
    }
  }
  if (b?.ativo !== undefined) out.ativo = Boolean(b.ativo);
  return { value: out };
}

const PACOTE_TEMPLATE_COLS = `id, nome, descricao, servicos_cobertos, total_sessoes,
  validade_dias, to_char(data_validade_fixa, 'YYYY-MM-DD') AS data_validade_fixa,
  preco_cents, colaborador_id, ativo, created_at, updated_at`;

// GET /api/clones/:id/pacotes — lista TODOS os templates (ativos e inativos) do clone.
app.get('/api/clones/:id/pacotes', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id, product_type } = resolved.scope;
    const r = await pool.query(
      `SELECT ${PACOTE_TEMPLATE_COLS} FROM service_packages
        WHERE slot = $1 AND tenant_id = $2 ORDER BY ativo DESC, nome ASC`,
      [slot, tenant_id],
    );
    // Colaboradores p/ o select de escopo (so faz sentido em estabelecimento).
    let colaboradores = [];
    if (product_type === 'estabelecimento') {
      const cc = await pool.query(
        `SELECT id, nome FROM clone_colaboradores WHERE slot = $1 ORDER BY ordem ASC, id ASC`,
        [slot],
      );
      colaboradores = cc.rows;
    }
    res.json({ product_type, colaboradores, pacotes: r.rows });
  } catch (e) {
    console.error(JSON.stringify({ at: 'pacotes-list', pg_code: e?.code, msg: 'falha ao listar pacotes' }));
    res.status(500).json({ error: 'erro ao listar pacotes' });
  }
});

// POST /api/clones/:id/pacotes — cria template de pacote.
app.post('/api/clones/:id/pacotes', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;
    const v = _validatePacoteTemplate(req.body ?? {}, { partial: false });
    if (v.error) return res.status(400).json({ error: v.error });
    const t = v.value;
    const r = await pool.query(
      `INSERT INTO service_packages
         (slot, tenant_id, nome, descricao, servicos_cobertos, total_sessoes,
          validade_dias, data_validade_fixa, preco_cents, colaborador_id, ativo)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)
       RETURNING ${PACOTE_TEMPLATE_COLS}`,
      [slot, tenant_id, t.nome, t.descricao ?? null, JSON.stringify(t.servicos_cobertos ?? []),
       t.total_sessoes, t.validade_dias ?? null, t.data_validade_fixa ?? null,
       t.preco_cents ?? null, t.colaborador_id ?? null, t.ativo === undefined ? true : t.ativo],
    );
    console.log(JSON.stringify({ audit: 'pacote-template-created', operator: req.session?.userId || 'unknown', slot, package_id: r.rows[0]?.id, at: new Date().toISOString() }));
    res.status(201).json({ ok: true, pacote: r.rows[0] });
  } catch (e) {
    if (e?.code === '23503') return res.status(400).json({ error: 'colaborador_id nao pertence a este clone' });
    console.error(JSON.stringify({ at: 'pacotes-create', pg_code: e?.code, msg: 'falha ao criar pacote' }));
    res.status(500).json({ error: 'erro ao criar pacote' });
  }
});

// PATCH /api/clones/:id/pacotes/:pkgId — edita template (parcial).
app.patch('/api/clones/:id/pacotes/:pkgId', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;
    const pkgId = Number(req.params.pkgId);
    if (!Number.isInteger(pkgId) || pkgId <= 0) return res.status(400).json({ error: 'pkgId invalido' });
    const v = _validatePacoteTemplate(req.body ?? {}, { partial: true });
    if (v.error) return res.status(400).json({ error: v.error });
    const t = v.value;
    const sets = [];
    const vals = [];
    const put = (col, val, cast = '') => { vals.push(val); sets.push(`${col} = $${vals.length}${cast}`); };
    if (t.nome !== undefined) put('nome', t.nome);
    if (t.descricao !== undefined) put('descricao', t.descricao);
    if (t.servicos_cobertos !== undefined) put('servicos_cobertos', JSON.stringify(t.servicos_cobertos), '::jsonb');
    if (t.total_sessoes !== undefined) put('total_sessoes', t.total_sessoes);
    if (t.validade_dias !== undefined) put('validade_dias', t.validade_dias);
    if (t.data_validade_fixa !== undefined) put('data_validade_fixa', t.data_validade_fixa);
    if (t.preco_cents !== undefined) put('preco_cents', t.preco_cents);
    if (t.colaborador_id !== undefined) put('colaborador_id', t.colaborador_id);
    if (t.ativo !== undefined) put('ativo', t.ativo);
    if (sets.length === 0) return res.status(400).json({ error: 'nada a atualizar' });
    sets.push('updated_at = NOW()');
    vals.push(slot); vals.push(tenant_id); vals.push(pkgId);
    const r = await pool.query(
      `UPDATE service_packages SET ${sets.join(', ')}
        WHERE slot = $${vals.length - 2} AND tenant_id = $${vals.length - 1} AND id = $${vals.length}
       RETURNING ${PACOTE_TEMPLATE_COLS}`,
      vals,
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'pacote nao encontrado neste clone' });
    console.log(JSON.stringify({ audit: 'pacote-template-updated', operator: req.session?.userId || 'unknown', slot, package_id: pkgId, at: new Date().toISOString() }));
    res.json({ ok: true, pacote: r.rows[0] });
  } catch (e) {
    if (e?.code === '23503') return res.status(400).json({ error: 'colaborador_id nao pertence a este clone' });
    console.error(JSON.stringify({ at: 'pacotes-patch', pg_code: e?.code, msg: 'falha ao atualizar pacote' }));
    res.status(500).json({ error: 'erro ao atualizar pacote' });
  }
});

// DELETE /api/clones/:id/pacotes/:pkgId — remove template.
// Bloqueia se ja houver credito vendido desse template (FK protege o saldo do cliente).
// Recomenda desativar (ativo=false) em vez de apagar quando ha venda.
app.delete('/api/clones/:id/pacotes/:pkgId', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;
    const pkgId = Number(req.params.pkgId);
    if (!Number.isInteger(pkgId) || pkgId <= 0) return res.status(400).json({ error: 'pkgId invalido' });
    const sold = await pool.query(`SELECT 1 FROM client_package_credits WHERE package_id = $1 LIMIT 1`, [pkgId]);
    if ((sold.rowCount ?? 0) > 0) {
      return res.status(409).json({ error: 'este pacote ja foi vendido a clientes — desative-o (em vez de excluir) para preservar o saldo de quem comprou' });
    }
    const r = await pool.query(
      `DELETE FROM service_packages WHERE slot = $1 AND tenant_id = $2 AND id = $3`,
      [slot, tenant_id, pkgId],
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'pacote nao encontrado neste clone' });
    console.log(JSON.stringify({ audit: 'pacote-template-deleted', operator: req.session?.userId || 'unknown', slot, package_id: pkgId, at: new Date().toISOString() }));
    res.json({ ok: true });
  } catch (e) {
    console.error(JSON.stringify({ at: 'pacotes-delete', pg_code: e?.code, msg: 'falha ao remover pacote' }));
    res.status(500).json({ error: 'erro ao remover pacote' });
  }
});

// ───────────────────────── PACOTES — VENDER / SALDO / EXTRATO ─────────────────

// POST /api/clones/:id/pacotes/:pkgId/vender — vende/atribui um pacote a um cliente final.
// Body: { telefone (cru), sessoes?, validade_dias?|data_expiracao? }
// O servidor hasheia o telefone com PACKAGE_PHONE_PEPPER (nunca persiste o numero cru).
// sessoes default = total_sessoes do template; validade default = derivada do template.
app.post('/api/clones/:id/pacotes/:pkgId/vender', async (req, res) => {
  const client = await pool.connect();
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;
    const pkgId = Number(req.params.pkgId);
    if (!Number.isInteger(pkgId) || pkgId <= 0) return res.status(400).json({ error: 'pkgId invalido' });

    // Identidade do cliente final — pepper obrigatorio (degrada com 409 claro se ausente).
    if (!_pkgIsPepperConfigured()) {
      return res.status(409).json({ error: 'venda de pacote indisponivel: PACKAGE_PHONE_PEPPER nao configurada no servidor (avise o time)' });
    }
    const canonical = _pkgCanonicalE164(req.body?.telefone);
    if (!canonical) return res.status(400).json({ error: 'telefone do cliente invalido' });
    const hmac = _pkgPhoneHmac(canonical);
    const hint = _pkgPhoneHint(canonical);

    // Carrega o template (escopado por slot+tenant) para defaults de sessoes/validade.
    const tpl = await client.query(
      `SELECT id, total_sessoes, validade_dias, to_char(data_validade_fixa,'YYYY-MM-DD') AS data_validade_fixa, ativo
         FROM service_packages WHERE id = $1 AND slot = $2 AND tenant_id = $3`,
      [pkgId, slot, tenant_id],
    );
    if (tpl.rowCount === 0) return res.status(404).json({ error: 'pacote nao encontrado neste clone' });
    const template = tpl.rows[0];

    // sessoes: body override OU total do template.
    let sessoes = template.total_sessoes;
    if (req.body?.sessoes !== undefined && req.body.sessoes !== null && req.body.sessoes !== '') {
      const s = Number(req.body.sessoes);
      if (!Number.isInteger(s) || s < 1 || s > 1000) return res.status(400).json({ error: 'sessoes deve ser inteiro entre 1 e 1000' });
      sessoes = s;
    }

    // data_expiracao: body (data fixa OU dias) OU derivada do template.
    let dataExpiracao = null;
    if (req.body?.data_expiracao) {
      const d = String(req.body.data_expiracao).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'data_expiracao deve ser AAAA-MM-DD' });
      dataExpiracao = d;
    } else if (req.body?.validade_dias) {
      const dias = Number(req.body.validade_dias);
      if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return res.status(400).json({ error: 'validade_dias invalida' });
      dataExpiracao = `__DIAS__${dias}`;
    } else if (template.data_validade_fixa) {
      dataExpiracao = template.data_validade_fixa;
    } else if (template.validade_dias) {
      dataExpiracao = `__DIAS__${Number(template.validade_dias)}`;
    } else {
      return res.status(400).json({ error: 'sem validade definida: informe data_expiracao ou validade_dias' });
    }

    // Resolve "__DIAS__N" -> data via SQL (CURRENT_DATE + N) pra evitar fuso do Node.
    const dataExpr = dataExpiracao.startsWith('__DIAS__')
      ? `(CURRENT_DATE + ($6::int))`
      : `$6::date`;
    const dataParam = dataExpiracao.startsWith('__DIAS__')
      ? Number(dataExpiracao.slice('__DIAS__'.length))
      : dataExpiracao;

    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO client_package_credits
         (package_id, slot, tenant_id, cliente_phone_hmac, cliente_phone_hint, sessoes_total, sessoes_restantes, data_expiracao, status)
       VALUES ($1, $2, $3, $4, $5, $7, $7, ${dataExpr}, 'active')
       RETURNING id, sessoes_total, sessoes_restantes, to_char(data_expiracao,'YYYY-MM-DD') AS data_expiracao, cliente_phone_hint, data_compra, status`,
      [pkgId, slot, tenant_id, hmac, hint, dataParam, sessoes],
    );
    await client.query('COMMIT');
    // NUNCA loga o numero cru — so o hint mascarado.
    console.log(JSON.stringify({ audit: 'pacote-vendido', operator: req.session?.userId || 'unknown', slot, package_id: pkgId, credit_id: ins.rows[0]?.id, hint, at: new Date().toISOString() }));
    res.status(201).json({ ok: true, credito: ins.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ at: 'pacotes-vender', pg_code: e?.code, msg: 'falha ao vender pacote' }));
    res.status(500).json({ error: 'erro ao vender pacote' });
  } finally {
    client.release();
  }
});

// GET /api/clones/:id/creditos — saldo de pacotes do clone. Filtro opcional ?telefone=.
// Com ?telefone= hasheia e mostra so os creditos daquele cliente. Sem filtro, lista todos
// os creditos do clone (saldo recomputado do ledger — fonte da verdade).
app.get('/api/clones/:id/creditos', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;

    const params = [slot, tenant_id];
    let phoneClause = '';
    let filtroHint = null;
    if (req.query?.telefone) {
      if (!_pkgIsPepperConfigured()) {
        return res.status(409).json({ error: 'busca por telefone indisponivel: PACKAGE_PHONE_PEPPER nao configurada' });
      }
      const canonical = _pkgCanonicalE164(req.query.telefone);
      if (!canonical) return res.status(400).json({ error: 'telefone invalido' });
      params.push(_pkgPhoneHmac(canonical));
      phoneClause = ` AND c.cliente_phone_hmac = $${params.length}`;
      filtroHint = _pkgPhoneHint(canonical);
    }

    const r = await pool.query(
      `SELECT c.id AS credit_id, c.package_id, sp.nome AS pacote_nome,
              c.cliente_phone_hint, c.sessoes_total,
              (c.sessoes_total + COALESCE(SUM(pr.delta), 0)) AS saldo,
              to_char(c.data_expiracao,'YYYY-MM-DD') AS data_expiracao,
              (c.data_expiracao < (NOW() AT TIME ZONE 'utc')::date) AS expirado,
              c.status, sp.servicos_cobertos, sp.colaborador_id, c.data_compra
         FROM client_package_credits c
         JOIN service_packages sp ON sp.id = c.package_id
         LEFT JOIN package_redemptions pr ON pr.credit_id = c.id
        WHERE c.slot = $1 AND c.tenant_id = $2${phoneClause}
        GROUP BY c.id, sp.nome, sp.servicos_cobertos, sp.colaborador_id
        ORDER BY c.data_expiracao ASC, c.data_compra ASC`,
      params,
    );
    const creditos = r.rows.map((row) => {
      const saldo = Math.max(0, Number(row.saldo));
      let estado = 'ATIVO';
      if (row.status === 'cancelled') estado = 'CANCELADO';
      else if (row.expirado) estado = 'EXPIRADO';
      else if (saldo <= 0) estado = 'ESGOTADO';
      return {
        credit_id: Number(row.credit_id), package_id: Number(row.package_id), pacote_nome: row.pacote_nome,
        cliente_phone_hint: row.cliente_phone_hint, sessoes_total: Number(row.sessoes_total),
        saldo, data_expiracao: row.data_expiracao, estado,
        servicos_cobertos: Array.isArray(row.servicos_cobertos) ? row.servicos_cobertos : [],
        colaborador_id: row.colaborador_id === null ? null : Number(row.colaborador_id),
        data_compra: row.data_compra,
      };
    });
    res.json({ filtro_hint: filtroHint, total: creditos.length, creditos });
  } catch (e) {
    console.error(JSON.stringify({ at: 'pacotes-creditos', pg_code: e?.code, msg: 'falha ao listar creditos' }));
    res.status(500).json({ error: 'erro ao listar creditos' });
  }
});

// GET /api/clones/:id/creditos/:creditId/extrato — ledger (movimentos) de um credito.
app.get('/api/clones/:id/creditos/:creditId/extrato', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot } = resolved.scope;
    const creditId = Number(req.params.creditId);
    if (!Number.isInteger(creditId) || creditId <= 0) return res.status(400).json({ error: 'creditId invalido' });
    // Confirma que o credito e deste clone antes de expor o ledger (isolamento).
    const own = await pool.query(`SELECT 1 FROM client_package_credits WHERE id = $1 AND slot = $2`, [creditId, slot]);
    if ((own.rowCount ?? 0) === 0) return res.status(404).json({ error: 'credito nao encontrado neste clone' });
    const r = await pool.query(
      `SELECT id, gcal_event_id, colaborador_id, servico_nome, delta, reason, created_at
         FROM package_redemptions WHERE credit_id = $1 AND slot = $2 ORDER BY created_at ASC, id ASC`,
      [creditId, slot],
    );
    res.json({ credit_id: creditId, movimentos: r.rows });
  } catch (e) {
    console.error(JSON.stringify({ at: 'pacotes-extrato', pg_code: e?.code, msg: 'falha ao ler extrato' }));
    res.status(500).json({ error: 'erro ao ler extrato' });
  }
});

// ──────────────── PACOTES — LIFECYCLE PÓS-VENDA (recarga / vencimento / estorno) ──
//
// ADR 0025 BLOCO 2c. NOVA invariante: o PAINEL agora PODE escrever no ledger, mas SÓ
// com reason='recharge' (delta>0) — distinto de redeem(-1)/refund(+1). O saldo continua
// vindo do ledger; sessoes_restantes é cache reconstruído na MESMA transação. Estas rotas
// ESPELHAM packages/db/src/queries/packages.ts (recargaCredit/mudarVencimento/cancelarCredito/
// refundForBooking) — o painel é JS standalone, sem build-time dep do @startap/db. MANTER
// EM SYNC. FISCAL: preco/saldo é caixa do barbeiro; NUNCA toca AbacatePay/client_billing.
//
// Idempotência da recarga: gcal_event_id sintético 'recharge:<creditId>:<idempotency_key>'
// + UNIQUE(gcal_event_id,reason). Mesma idempotency_key retried = no-op (não soma 2x).

// Reconstrói o cache sessoes_restantes de UM credito a partir do LEDGER (fonte da verdade),
// DENTRO da transacao. Clampa [0..sessoes_total]; re-deriva status (exhausted/active),
// preservando 'cancelled'. Espelho de rebuildCreditCacheTx (packages.ts).
async function _pkgRebuildCreditCacheTx(client, creditId) {
  const r = await client.query(
    `UPDATE client_package_credits c
        SET sessoes_restantes = GREATEST(0, LEAST(c.sessoes_total,
              c.sessoes_total + COALESCE(
                (SELECT SUM(pr.delta) FROM package_redemptions pr WHERE pr.credit_id = c.id), 0))),
            status = CASE
              WHEN c.status = 'cancelled' THEN 'cancelled'
              WHEN (c.sessoes_total + COALESCE(
                (SELECT SUM(pr.delta) FROM package_redemptions pr WHERE pr.credit_id = c.id), 0)) <= 0
                THEN 'exhausted'
              ELSE 'active' END,
            updated_at = NOW()
      WHERE c.id = $1
      RETURNING c.sessoes_restantes AS saldo`,
    [creditId],
  );
  return Math.max(0, Number(r.rows[0]?.saldo ?? 0));
}

// Snapshot pos-update (total/validade/status) DENTRO da transacao. Read-only.
async function _pkgCreditSnapshotTx(client, creditId) {
  const r = await client.query(
    `SELECT sessoes_total, to_char(data_expiracao,'YYYY-MM-DD') AS data_expiracao, status
       FROM client_package_credits WHERE id = $1`,
    [creditId],
  );
  const row = r.rows[0] || {};
  return {
    sessoes_total: Number(row.sessoes_total ?? 0),
    data_expiracao: row.data_expiracao ?? null,
    status: row.status ?? null,
  };
}

// POST /api/clones/:id/creditos/:creditId/recarregar — RENOVA o MESMO credito (soma sessoes +
// muda vencimento no mesmo card). Body: { sessoes, data_expiracao?|adicionar_dias?,
// idempotency_key?, reativar? }. Decisao do Bruno: 1 card por cliente; renovacao reusa o card.
app.post('/api/clones/:id/creditos/:creditId/recarregar', async (req, res) => {
  const client = await pool.connect();
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;
    const creditId = Number(req.params.creditId);
    if (!Number.isInteger(creditId) || creditId <= 0) return res.status(400).json({ error: 'creditId invalido' });

    // sessoes a SOMAR (>0).
    const sessoes = Number(req.body?.sessoes);
    if (!Number.isInteger(sessoes) || sessoes < 1 || sessoes > 1000) {
      return res.status(400).json({ error: 'sessoes deve ser inteiro entre 1 e 1000' });
    }
    // Nova validade opcional: data fixa OU dias (nao os dois).
    const hasData = req.body?.data_expiracao !== undefined && req.body.data_expiracao !== null && req.body.data_expiracao !== '';
    const hasDias = req.body?.adicionar_dias !== undefined && req.body.adicionar_dias !== null && req.body.adicionar_dias !== '';
    if (hasData && hasDias) return res.status(400).json({ error: 'use data_expiracao OU adicionar_dias, nao os dois' });
    let novaData = null; let novaDias = null;
    if (hasData) {
      const d = String(req.body.data_expiracao).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'data_expiracao deve ser AAAA-MM-DD' });
      novaData = d;
    } else if (hasDias) {
      const dias = Number(req.body.adicionar_dias);
      if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return res.status(400).json({ error: 'adicionar_dias deve ser inteiro entre 1 e 3650' });
      novaDias = dias;
    }
    // Chave de idempotencia: do body (frontend reusa no retry) ou UUID novo (recarga unica).
    const idemKey = (req.body?.idempotency_key && String(req.body.idempotency_key).trim().slice(0, 80)) || crypto.randomUUID();
    const syntheticEventId = `recharge:${creditId}:${idemKey}`;
    const reativar = req.body?.reativar === true;

    await client.query('BEGIN');
    // Trava o credito; escopo slot+tenant (anti-IDOR). 404 se nao for deste clone.
    const cred = await client.query(
      `SELECT id, status FROM client_package_credits WHERE id = $1 AND slot = $2 AND tenant_id = $3 FOR UPDATE`,
      [creditId, slot, tenant_id],
    );
    if (cred.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'credito nao encontrado neste clone' }); }

    // reativar=true: tira de 'cancelled' ANTES (rebuild preserva cancelled). Idempotente.
    if (reativar && cred.rows[0]?.status === 'cancelled') {
      await client.query(
        `UPDATE client_package_credits SET status = 'active', updated_at = NOW() WHERE id = $1 AND status = 'cancelled'`,
        [creditId],
      );
    }

    // Ledger: append +sessoes, reason='recharge'. tenant_id/slot do PROPRIO credito.
    const ins = await client.query(
      `INSERT INTO package_redemptions
         (credit_id, slot, tenant_id, gcal_event_id, colaborador_id, servico_nome, delta, reason)
       SELECT c.id, c.slot, c.tenant_id, $2, NULL, $3, $4, 'recharge'
         FROM client_package_credits c WHERE c.id = $1
       ON CONFLICT (gcal_event_id, reason) DO NOTHING`,
      [creditId, syntheticEventId, String(req.session?.userId || 'recharge').slice(0, 160), sessoes],
    );

    if (ins.rowCount === 0) {
      // Mesma idempotency_key ja aplicada (retry) — NAO soma de novo nem muda validade.
      const saldo = await _pkgRebuildCreditCacheTx(client, creditId);
      const snap = await _pkgCreditSnapshotTx(client, creditId);
      await client.query('COMMIT');
      return res.json({ ok: true, status_recarga: 'ja_aplicada', credit_id: creditId, saldo, sessoes_total: snap.sessoes_total, data_expiracao: snap.data_expiracao, status: snap.status });
    }

    // Cresce sessoes_total + nova validade se veio (resolvida no DB, sem fuso do Node).
    const setVal = ['sessoes_total = sessoes_total + $2'];
    const upParams = [creditId, sessoes];
    if (novaData) { upParams.push(novaData); setVal.push(`data_expiracao = $${upParams.length}::date`); }
    else if (novaDias != null) { upParams.push(novaDias); setVal.push(`data_expiracao = CURRENT_DATE + ($${upParams.length}::int)`); }
    await client.query(`UPDATE client_package_credits SET ${setVal.join(', ')}, updated_at = NOW() WHERE id = $1`, upParams);

    const saldo = await _pkgRebuildCreditCacheTx(client, creditId);
    const snap = await _pkgCreditSnapshotTx(client, creditId);
    await client.query('COMMIT');
    console.log(JSON.stringify({ audit: 'pacote-recarga', operator: req.session?.userId || 'unknown', slot, credit_id: creditId, sessoes_add: sessoes, nova_validade: novaData || (novaDias != null ? `+${novaDias}d` : 'mantida'), reativar, at: new Date().toISOString() }));
    res.json({ ok: true, status_recarga: 'recarregado', credit_id: creditId, saldo, sessoes_total: snap.sessoes_total, data_expiracao: snap.data_expiracao, status: snap.status });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ at: 'pacotes-recarga', pg_code: e?.code, msg: 'falha ao recarregar credito' }));
    res.status(500).json({ error: 'erro ao recarregar credito' });
  } finally {
    client.release();
  }
});

// PATCH /api/clones/:id/creditos/:creditId — muda SO o vencimento. Body: { data_expiracao }
// OU { adicionar_dias }. NAO toca o ledger (nao e movimento de saldo). Rebuild re-deriva status.
app.patch('/api/clones/:id/creditos/:creditId', async (req, res) => {
  const client = await pool.connect();
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;
    const creditId = Number(req.params.creditId);
    if (!Number.isInteger(creditId) || creditId <= 0) return res.status(400).json({ error: 'creditId invalido' });

    const hasData = req.body?.data_expiracao !== undefined && req.body.data_expiracao !== null && req.body.data_expiracao !== '';
    const hasDias = req.body?.adicionar_dias !== undefined && req.body.adicionar_dias !== null && req.body.adicionar_dias !== '';
    if (hasData === hasDias) return res.status(400).json({ error: 'informe EXATAMENTE um: data_expiracao OU adicionar_dias' });
    let validadeExpr; const params = [creditId, slot, tenant_id];
    if (hasData) {
      const d = String(req.body.data_expiracao).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(400).json({ error: 'data_expiracao deve ser AAAA-MM-DD' });
      params.push(d); validadeExpr = `$${params.length}::date`;
    } else {
      const dias = Number(req.body.adicionar_dias);
      if (!Number.isInteger(dias) || dias < 1 || dias > 3650) return res.status(400).json({ error: 'adicionar_dias deve ser inteiro entre 1 e 3650' });
      params.push(dias); validadeExpr = `CURRENT_DATE + ($${params.length}::int)`;
    }

    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE client_package_credits SET data_expiracao = ${validadeExpr}, updated_at = NOW()
        WHERE id = $1 AND slot = $2 AND tenant_id = $3 RETURNING id`,
      params,
    );
    if (upd.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'credito nao encontrado neste clone' }); }
    const saldo = await _pkgRebuildCreditCacheTx(client, creditId);
    const snap = await _pkgCreditSnapshotTx(client, creditId);
    await client.query('COMMIT');
    console.log(JSON.stringify({ audit: 'pacote-vencimento', operator: req.session?.userId || 'unknown', slot, credit_id: creditId, nova_validade: hasData ? req.body.data_expiracao : `+${req.body.adicionar_dias}d`, at: new Date().toISOString() }));
    res.json({ ok: true, credit_id: creditId, data_expiracao: snap.data_expiracao, status: snap.status, saldo });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ at: 'pacotes-vencimento', pg_code: e?.code, msg: 'falha ao mudar vencimento' }));
    res.status(500).json({ error: 'erro ao mudar vencimento' });
  } finally {
    client.release();
  }
});

// POST /api/clones/:id/creditos/:creditId/cancelar — marca status='cancelled'. Ledger intacto.
// Reversivel via recarregar com {reativar:true}.
app.post('/api/clones/:id/creditos/:creditId/cancelar', async (req, res) => {
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;
    const creditId = Number(req.params.creditId);
    if (!Number.isInteger(creditId) || creditId <= 0) return res.status(400).json({ error: 'creditId invalido' });
    const upd = await pool.query(
      `UPDATE client_package_credits SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND slot = $2 AND tenant_id = $3 RETURNING status`,
      [creditId, slot, tenant_id],
    );
    if (upd.rowCount === 0) return res.status(404).json({ error: 'credito nao encontrado neste clone' });
    console.log(JSON.stringify({ audit: 'pacote-cancelado', operator: req.session?.userId || 'unknown', slot, credit_id: creditId, at: new Date().toISOString() }));
    res.json({ ok: true, credit_id: creditId, status: 'cancelled' });
  } catch (e) {
    console.error(JSON.stringify({ at: 'pacotes-cancelar', pg_code: e?.code, msg: 'falha ao cancelar credito' }));
    res.status(500).json({ error: 'erro ao cancelar credito' });
  }
});

// POST /api/clones/:id/creditos/:creditId/estornar — DEVOLVE 1 sessao de um agendamento que
// nao vai acontecer. Body: { gcal_event_id }. Espelho de refundForBooking (packages.ts):
// acha o redeem original do evento NESTE credito (escopo slot+tenant), grava +1 reason='refund'
// idempotente por UNIQUE(gcal_event_id,'refund'), reconstroi o saldo. Disparo MANUAL (o bot
// nunca cancela — escala pro dono).
app.post('/api/clones/:id/creditos/:creditId/estornar', async (req, res) => {
  const client = await pool.connect();
  try {
    const resolved = await _resolveCloneScope(req.params.id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
    const { slot, tenant_id } = resolved.scope;
    const creditId = Number(req.params.creditId);
    if (!Number.isInteger(creditId) || creditId <= 0) return res.status(400).json({ error: 'creditId invalido' });
    const gcalEventId = String(req.body?.gcal_event_id ?? '').trim();
    if (!gcalEventId) return res.status(400).json({ error: 'gcal_event_id obrigatorio' });

    await client.query('BEGIN');
    // Acha o redeem original DESTE evento NESTE credito (escopo slot+tenant). FOR UPDATE serializa.
    const redeem = await client.query(
      `SELECT id FROM package_redemptions
        WHERE gcal_event_id = $1 AND reason = 'redeem' AND credit_id = $2 AND slot = $3 AND tenant_id = $4
        FOR UPDATE`,
      [gcalEventId, creditId, slot, tenant_id],
    );
    if (redeem.rowCount === 0) { await client.query('COMMIT'); return res.status(404).json({ error: 'sem desconto (redeem) deste evento neste credito — nada a estornar' }); }

    const ins = await client.query(
      `INSERT INTO package_redemptions
         (credit_id, slot, tenant_id, gcal_event_id, colaborador_id, servico_nome, delta, reason)
       SELECT c.id, c.slot, c.tenant_id, $2, NULL, NULL, 1, 'refund'
         FROM client_package_credits c WHERE c.id = $1
       ON CONFLICT (gcal_event_id, reason) DO NOTHING`,
      [creditId, gcalEventId],
    );
    const saldo = await _pkgRebuildCreditCacheTx(client, creditId);
    await client.query('COMMIT');
    const jaEstornado = ins.rowCount === 0;
    console.log(JSON.stringify({ audit: 'pacote-estorno', operator: req.session?.userId || 'unknown', slot, credit_id: creditId, gcal_event_id: gcalEventId, ja_estornado: jaEstornado, at: new Date().toISOString() }));
    res.json({ ok: true, credit_id: creditId, estornado: !jaEstornado, status_estorno: jaEstornado ? 'ja_estornado' : 'estornado', saldo });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(JSON.stringify({ at: 'pacotes-estorno', pg_code: e?.code, msg: 'falha ao estornar' }));
    res.status(500).json({ error: 'erro ao estornar' });
  } finally {
    client.release();
  }
});

app.listen(Number(PORT), () => console.log(`Painel rodando em :${PORT}`));
