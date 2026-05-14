import path from 'node:path';
import { fileURLToPath } from 'node:url';
import auth from 'basic-auth';
import express from 'express';
import fetch from 'node-fetch';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  PG_HOST = 'postgres',
  PG_PORT = '5432',
  PG_USER = 'n8n_user',
  PG_PASS = 'senha_banco_forte_123',
  PG_DB = 'n8n_database',
  N8N_URL = 'http://n8n:5678',
  N8N_PUBLIC_URL = 'https://n8n.startap.tech',
  N8N_API_KEY = '',
  WAHA_URL = 'http://waha:3000',
  WAHA_API_KEY = '',
  ADMIN_USER = 'admin',
  ADMIN_PASS = 'admin',
  PORT = '3030',
} = process.env;

const TS_API_URL = process.env.TS_API_URL || 'http://startap-api:3040';
const TS_WEBHOOK_URL = process.env.TS_WEBHOOK_URL || `${TS_API_URL}/webhooks/waha`;

// Bots do TS platform (substituem os workflows n8n deletados)
const TS_BOTS = [
  { id: '0ni38aSspWwhooHd', name: 'teste_barbearia', active: true, webhook_url: TS_WEBHOOK_URL, source: 'ts' },
  { id: 'dlpKXM3gvX2joC1b', name: 'teste_vendas',    active: true, webhook_url: TS_WEBHOOK_URL, source: 'ts' },
  { id: 'uUS3Ux1cU2DquKxo', name: 'startap',         active: true, webhook_url: TS_WEBHOOK_URL, source: 'ts' },
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
};

const pool = new pg.Pool({
  host: PG_HOST,
  port: Number(PG_PORT),
  user: PG_USER,
  password: PG_PASS,
  database: PG_DB,
});

const app = express();
app.use(express.json());

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

const n8nFetch = (p) =>
  fetch(`${N8N_URL}${p}`, { headers: { 'X-N8N-API-KEY': N8N_API_KEY } }).then((r) => r.json());

const wahaFetch = (p) =>
  fetch(`${WAHA_URL}${p}`, { headers: { 'X-Api-Key': WAHA_API_KEY } }).then((r) => r.json());

// ---------- ROUTING CRUD ----------
app.get('/api/routing', async (req, res) => {
  const r = await pool.query(`
    SELECT id, telefone, nome_cliente, workflow_id, workflow_name, webhook_url,
           ativo, criado_em, atualizado_em
    FROM routing_clientes ORDER BY workflow_name, telefone
  `);
  res.json(r.rows);
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
  await pool.query('DELETE FROM routing_clientes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
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
    const r = await pool.query('SELECT slot, prompt, updated_at FROM bot_prompt WHERE slot = $1', [req.params.slot]);
    if (!r.rows.length) return res.status(404).json({ error: 'prompt nao definido' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- MIDIAS ----------
app.get('/api/bots/:slot/media', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, slot, position, media_type, url, caption, position_order, enabled, updated_at
       FROM bot_media WHERE slot = $1 ORDER BY position_order, id`,
      [req.params.slot],
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bots/:slot/media', async (req, res) => {
  try {
    const { position, media_type = 'video', url = null, caption = null, position_order = 0, enabled = true } = req.body;
    if (!position) return res.status(400).json({ error: 'position obrigatorio' });
    const r = await pool.query(
      `INSERT INTO bot_media (slot, position, media_type, url, caption, position_order, enabled, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (slot, position) DO UPDATE SET
         media_type = EXCLUDED.media_type,
         url = EXCLUDED.url,
         caption = EXCLUDED.caption,
         position_order = EXCLUDED.position_order,
         enabled = EXCLUDED.enabled,
         updated_at = NOW()
       RETURNING *`,
      [req.params.slot, position, media_type, url, caption, Number(position_order) || 0, !!enabled],
    );
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/media/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM bot_media WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- WORKFLOWS COM WEBHOOK ----------
// Retorna apenas workflows que tem nó Webhook (utilizáveis pelo roteador)
app.get('/api/workflows', async (req, res) => {
  try {
    const workflows = await fetchAllWorkflows();
    const slim = workflows.map((w) => {
      const webhookNode = (w.nodes || []).find((n) => n.type === 'n8n-nodes-base.webhook');
      return {
        id: w.id,
        name: w.name,
        active: w.active,
        nodes: w.nodes?.length || 0,
        has_webhook: !!webhookNode,
        webhook_url: w._tsBot
          ? w._webhook_url
          : webhookNode
            ? `${N8N_PUBLIC_URL}/webhook/${webhookNode.parameters?.path || webhookNode.webhookId}`
            : null,
      };
    });
    res.json(slim);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fetchAllWorkflows() {
  let n8nData = [];
  try {
    const data = await n8nFetch('/api/v1/workflows?limit=100');
    n8nData = data.data || [];
  } catch {}
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
  }));
  return [...tsAsWorkflow, ...n8nData];
}

async function resolveWorkflow(workflow_id) {
  const tsBot = TS_BOTS.find((b) => b.id === workflow_id);
  if (tsBot) {
    return { id: tsBot.id, name: tsBot.name, active: tsBot.active, webhook_url: tsBot.webhook_url };
  }
  try {
    const w = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(workflow_id)}`);
    if (!w?.id) return null;
    const webhookNode = (w.nodes || []).find((n) => n.type === 'n8n-nodes-base.webhook');
    return {
      id: w.id,
      name: w.name,
      active: w.active,
      webhook_url: webhookNode
        ? `${N8N_PUBLIC_URL}/webhook/${webhookNode.parameters?.path || webhookNode.webhookId}`
        : null,
    };
  } catch {
    return null;
  }
}

// ---------- SYSTEM STATUS ----------
app.get('/api/status', async (req, res) => {
  try {
    const [workflows, sessions, execs] = await Promise.all([
      fetchAllWorkflows(),
      wahaFetch('/api/sessions').catch(() => []),
      n8nFetch('/api/v1/executions?limit=15').catch(() => ({ data: [] })),
    ]);
    res.json({
      n8n: {
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
      execucoes: (execs.data || []).map((e) => ({
        id: e.id,
        workflowId: e.workflowId,
        status: e.status,
        startedAt: e.startedAt,
        finished: e.finished,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
  try {
    const r = await pool.query(`
      SELECT DATE(created_at) AS dia, COUNT(*) AS total
      FROM message_log WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1 DESC
    `);
    res.json(r.rows);
  } catch {
    res.json([]);
  }
});

app.listen(Number(PORT), () => console.log(`Painel rodando em :${PORT}`));
