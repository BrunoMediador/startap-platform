import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import auth from 'basic-auth';
import express from 'express';
import multer from 'multer';
import fetch from 'node-fetch';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PG_HOST = 'postgres',
  PG_PORT = '5432',
  PG_USER = 'n8n_user',
  PG_PASS = 'senha_banco_forte_123',
  PG_DB = 'n8n_database',
  WAHA_URL = 'http://waha:3000',
  WAHA_API_KEY = '',
  ADMIN_USER = 'admin',
  ADMIN_PASS = 'admin',
  PORT = '3030',
  MEDIA_STORAGE_DIR = path.join(__dirname, 'uploads'),
  MEDIA_PUBLIC_BASE_URL = '/uploads',
  MEDIA_UPLOAD_MAX_MB = '250',
} = process.env;

const TS_API_URL = process.env.TS_API_URL || 'http://startap-api:3040';
const TS_WEBHOOK_URL = process.env.TS_WEBHOOK_URL || `${TS_API_URL}/webhooks/waha`;

// Bots do TS platform
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
    flow_name: 'STARTTAP_AI',
    flow_label: 'Startap AI',
    ai_role: 'Lola - prospecção comercial',
    runtime: 'StartapAiBot.processLola',
    description: 'Atende prospects da Startap e pausa quando há intervenção humana.',
  },
  'startap-ai-samuel': {
    flow_id: 'uUS3Ux1cU2DquKxo',
    flow_name: 'STARTTAP_AI',
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

const DEFAULT_PROJECT_DATABASES = [
  {
    project_id: 'teste_barbearia',
    display_name: 'Teste - Barbearia',
    workflow_id: '0ni38aSspWwhooHd',
    slot: 'teste_barbearia',
    source: 'ts',
    memory_table: 'n8n_chat_histories',
    status: 'active',
    metadata: {
      category: 'teste',
      tables: [
        'chat_memory',
        'routing',
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
    memory_table: 'n8n_chat_histories_ricardo',
    status: 'active',
    metadata: {
      category: 'teste',
      tables: [
        'chat_memory',
        'routing',
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
    memory_table: 'n8n_chat_histories_vendas_barbearia',
    status: 'active',
    metadata: {
      category: 'teste',
      tables: [
        'chat_memory',
        'routing',
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
    memory_table: 'n8n_chat_histories_startap',
    status: 'active',
    metadata: {
      category: 'interno',
      tables: ['chat_memory', 'bot_prompt', 'model_usage', 'flow_logs', 'pause_startap'],
    },
  },
];

const DATABASE_TABLES = {
  chat_memory: { label: 'Historico de conversa', type: 'memoria' },
  routing: { label: 'Roteamento', type: 'operacao' },
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
app.use(express.json());

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
      '.pdf',
    ]);
    if (
      mimetype.startsWith('video/') ||
      mimetype.startsWith('image/') ||
      mimetype === 'application/pdf' ||
      allowedExt.has(ext)
    ) {
      cb(null, true);
      return;
    }
    cb(new Error('tipo de arquivo nao permitido'));
  },
});

// Basic Auth
app.use((req, res, next) => {
  const creds = auth(req);
  if (!creds || creds.name !== ADMIN_USER || creds.pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Painel"');
    return res.status(401).send('Acesso restrito');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(MEDIA_STORAGE_DIR));

app.post('/api/uploads/media', mediaUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'arquivo obrigatorio' });
    const base = String(MEDIA_PUBLIC_BASE_URL || '/uploads').replace(/\/$/, '');
    res.json({
      ok: true,
      file_name: req.file.filename,
      original_name: req.file.originalname,
      mime_type: req.file.mimetype,
      size: req.file.size,
      url: `${base}/${encodeURIComponent(req.file.filename)}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy HTTPS-friendly para midias HTTP internas (resolve mixed-content)
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

const wahaFetch = (p) =>
  fetch(`${WAHA_URL}${p}`, { headers: { 'X-Api-Key': WAHA_API_KEY } }).then((r) => r.json());

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
    const { telefone, workflow_id, nome_cliente, ativo } = req.body;
    const tel = String(telefone).replace(/\D/g, '');
    const wf = await resolveWorkflow(workflow_id);
    if (!wf) return res.status(400).json({ error: 'workflow nao encontrado' });
    await pool.query(
      `UPDATE routing_clientes SET
         telefone=$1, workflow_id=$2, workflow_name=$3, webhook_url=$4,
         nome_cliente=$5, ativo=$6, atualizado_em=NOW()
       WHERE id=$7`,
      [tel, wf.id, wf.name, wf.webhook_url, nome_cliente || null, ativo, id],
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
app.get('/api/bots', async (req, res) => {
  const r = await pool.query(`
    SELECT slot, display_name, provider, model, temperature::float AS temperature, updated_at
    FROM bot_config ORDER BY slot
  `);
  const flowCounts = r.rows.reduce((acc, row) => {
    const flowId = BOT_MODEL_CONTEXT[row.slot]?.flow_id || row.slot;
    acc[flowId] = (acc[flowId] || 0) + 1;
    return acc;
  }, {});
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
      return {
        ...row,
        ...context,
        models_in_flow: flowCounts[context.flow_id] || 1,
      };
    }),
  );
});

app.put('/api/bots/:slot', async (req, res) => {
  try {
    const { slot } = req.params;
    const { provider, model, temperature } = req.body;
    const sets = [];
    const vals = [];
    let i = 1;
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
app.get('/api/usage/summary', async (req, res) => {
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
});

app.get('/api/usage/daily', async (req, res) => {
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
});

app.get('/api/usage/recent', async (req, res) => {
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
  try {
    const { prompt } = req.body;
    if (typeof prompt !== 'string' || !prompt.length) {
      return res.status(400).json({ error: 'prompt obrigatorio' });
    }
    const r = await pool.query(
      `INSERT INTO bot_prompt (slot, prompt, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt, updated_at = NOW()
       RETURNING slot, prompt, updated_at`,
      [req.params.slot, prompt],
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- MIDIAS ----------
app.get('/api/bots/:slot/media', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, slot, position, media_type, url, caption, context, position_order, enabled, updated_at
       FROM bot_media WHERE slot = $1 ORDER BY position_order, id`,
      [req.params.slot],
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bots/:slot/media', async (req, res) => {
  try {
    const {
      position,
      media_type = 'video',
      url = null,
      caption = null,
      context = null,
      position_order = 0,
      enabled = true,
    } = req.body;
    if (!position) return res.status(400).json({ error: 'position obrigatorio' });
    const r = await pool.query(
      `INSERT INTO bot_media (slot, position, media_type, url, caption, context, position_order, enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (slot, position) DO UPDATE SET
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
        position,
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
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/media/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bot_media WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- WORKFLOWS COM WEBHOOK ----------
// Retorna apenas workflows que tem nó Webhook (utilizáveis pelo roteador)
app.get('/api/workflows', async (req, res) => {
  try {
    const workflows = await fetchAllWorkflows();
    const slim = workflows.map((w) => {
      return {
        id: w.id,
        name: w.name,
        active: w.active,
        routable: !!w._routable,
        source: 'ts',
        category: w._category || 'teste',
        tags: w._tags || [],
        description: w._description || '',
        webhook_url: w._webhook_url || null,
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
        type: 'n8n-nodes-base.webhook',
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
      bots: {
        total: workflows.length,
        ativos: workflows.filter((w) => w.active).length,
        workflows: workflows.map((w) => ({ id: w.id, name: w.name, active: w.active })),
      },
      waha: (Array.isArray(sessions) ? sessions : []).map((s) => ({
        name: s.name,
        status: s.status,
        me: s.me?.id || null,
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
      return {
        tableName: 'flow_execution_logs',
        countSql:
          'SELECT COUNT(*)::int AS rows, MAX(created_at) AS last_at FROM flow_execution_logs WHERE flow_id = $1 OR bot = $2',
        countVals: [project.workflow_id, project.slot],
        rowsSql:
          'SELECT id::text, execution_id::text, flow_id, flow_name, bot, telefone_masked, session, event_type, status, message, metadata, duration_ms, error_summary, created_at FROM flow_execution_logs WHERE flow_id = $1 OR bot = $2 ORDER BY id DESC LIMIT $3',
        rowsVals: [project.workflow_id, project.slot],
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
    const r = await pool.query('SELECT * FROM leads_ricardo ORDER BY 1 DESC LIMIT 200');
    res.json(r.rows);
  } catch {
    res.json([]);
  }
});

app.get('/api/agendamentos-pendentes', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM agendamento_pendente ORDER BY 1 DESC LIMIT 200');
    res.json(r.rows);
  } catch {
    res.json([]);
  }
});

app.get('/api/message-stats', async (req, res) => {
  // Lê de flow_execution_logs (event_type='webhook.received') porque message_log
  // é zerada a cada hora pelo limpar_historicos.sh (uso anti-bot). flow_execution_logs
  // preserva 14+ dias e tem índice idx_flow_logs_created.
  try {
    const r = await pool.query(`
      SELECT DATE(created_at) AS dia, COUNT(*) AS total
      FROM flow_execution_logs
      WHERE event_type = 'webhook.received'
        AND created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1 DESC
    `);
    res.json(r.rows);
  } catch {
    res.json([]);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const message =
      err.code === 'LIMIT_FILE_SIZE' ? 'arquivo maior que o limite permitido' : err.message;
    return res.status(400).json({ error: message });
  }
  if (err) return res.status(400).json({ error: err.message || 'falha no upload' });
  res.status(500).json({ error: 'erro inesperado' });
});

// ---------- CLEANUP STATUS ----------
app.get('/api/cleanup/status', async (req, res) => {
  try {
    const now = new Date();
    const nextRun = new Date(now);
    nextRun.setMinutes(0, 0, 0);
    nextRun.setHours(nextRun.getHours() + 1);

    const [lastRunRes, tablesRes] = await Promise.all([
      pool
        .query(
          'SELECT cleaned_at, tables_cleaned FROM cleanup_log ORDER BY cleaned_at DESC LIMIT 1',
        )
        .catch(() => ({ rows: [] })),
      pool
        .query('SELECT table_name, description FROM cleanup_historicos ORDER BY table_name')
        .catch(() => ({ rows: [] })),
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
