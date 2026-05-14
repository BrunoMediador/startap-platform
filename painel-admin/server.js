import express from 'express';
import pg from 'pg';
import auth from 'basic-auth';
import fetch from 'node-fetch';
import path from 'path';
import { fileURLToPath } from 'url';

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
  { id: '0ni38aSspWwhooHd', name: 'TESTE_BARBEARIAS_AGENDAMENTOS', active: true, webhook_url: TS_WEBHOOK_URL, source: 'ts' },
  { id: 'dlpKXM3gvX2joC1b', name: 'elenildo.ricardo',              active: true, webhook_url: TS_WEBHOOK_URL, source: 'ts' },
  { id: 'uUS3Ux1cU2DquKxo', name: 'STARTTAP_AI',                   active: true, webhook_url: TS_WEBHOOK_URL, source: 'ts' },
];

const pool = new pg.Pool({
  host: PG_HOST, port: Number(PG_PORT),
  user: PG_USER, password: PG_PASS, database: PG_DB,
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
  fetch(`${N8N_URL}${p}`, { headers: { 'X-N8N-API-KEY': N8N_API_KEY } }).then(r => r.json());

const wahaFetch = (p) =>
  fetch(`${WAHA_URL}${p}`, { headers: { 'X-Api-Key': WAHA_API_KEY } }).then(r => r.json());

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
    if (!telefone || !workflow_id) return res.status(400).json({ error: 'telefone e workflow_id obrigatorios' });
    const tel = String(telefone).replace(/\D/g, '');
    if (tel.length < 10) return res.status(400).json({ error: 'telefone invalido' });

    const wf = await resolveWorkflow(workflow_id);
    if (!wf) return res.status(400).json({ error: 'workflow nao encontrado' });
    if (!wf.webhook_url) return res.status(400).json({ error: 'workflow sem webhook publico' });

    const existing = await pool.query('SELECT id, workflow_name FROM routing_clientes WHERE telefone = $1', [tel]);
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
      [tel, wf.id, wf.name, wf.webhook_url, nome_cliente || null, ativo]
    );
    res.json({ ok: true, moved: existing.rows.length > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
      [tel, wf.id, wf.name, wf.webhook_url, nome_cliente || null, ativo, id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/routing/:id', async (req, res) => {
  await pool.query('DELETE FROM routing_clientes WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ---------- WORKFLOWS COM WEBHOOK ----------
// Retorna apenas workflows que tem nó Webhook (utilizáveis pelo roteador)
app.get('/api/workflows', async (req, res) => {
  try {
    const workflows = await fetchAllWorkflows();
    const slim = workflows.map(w => {
      const webhookNode = (w.nodes || []).find(n => n.type === 'n8n-nodes-base.webhook');
      return {
        id: w.id,
        name: w.name,
        active: w.active,
        nodes: w.nodes?.length || 0,
        has_webhook: !!webhookNode,
        webhook_url: w._tsBot ? w._webhook_url : (webhookNode
          ? `${N8N_PUBLIC_URL}/webhook/${webhookNode.parameters?.path || webhookNode.webhookId}`
          : null),
      };
    });
    res.json(slim);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function fetchAllWorkflows() {
  let n8nData = [];
  try {
    const data = await n8nFetch('/api/v1/workflows?limit=100');
    n8nData = data.data || [];
  } catch {}
  const tsAsWorkflow = TS_BOTS.map(b => ({
    id: b.id,
    name: b.name,
    active: b.active,
    nodes: [{ type: 'n8n-nodes-base.webhook', webhookId: 'ts-' + b.id, parameters: { path: 'webhooks/waha' } }],
    _tsBot: true,
    _webhook_url: b.webhook_url,
  }));
  return [...tsAsWorkflow, ...n8nData];
}

async function resolveWorkflow(workflow_id) {
  const tsBot = TS_BOTS.find(b => b.id === workflow_id);
  if (tsBot) {
    return { id: tsBot.id, name: tsBot.name, active: tsBot.active, webhook_url: tsBot.webhook_url };
  }
  try {
    const w = await n8nFetch(`/api/v1/workflows/${encodeURIComponent(workflow_id)}`);
    if (!w?.id) return null;
    const webhookNode = (w.nodes || []).find(n => n.type === 'n8n-nodes-base.webhook');
    return {
      id: w.id,
      name: w.name,
      active: w.active,
      webhook_url: webhookNode
        ? `${N8N_PUBLIC_URL}/webhook/${webhookNode.parameters?.path || webhookNode.webhookId}`
        : null,
    };
  } catch { return null; }
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
        ativos: workflows.filter(w => w.active).length,
        workflows: workflows.map(w => ({ id: w.id, name: w.name, active: w.active })),
      },
      waha: (Array.isArray(sessions) ? sessions : []).map(s => ({
        name: s.name, status: s.status, me: s.me?.id || null,
        webhook: s.config?.webhooks?.[0]?.url,
      })),
      execucoes: (execs.data || []).map(e => ({
        id: e.id, workflowId: e.workflowId, status: e.status,
        startedAt: e.startedAt, finished: e.finished,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- LEADS & RELATORIOS ----------
app.get('/api/leads', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM leads_ricardo ORDER BY 1 DESC LIMIT 200');
    res.json(r.rows);
  } catch { res.json([]); }
});

app.get('/api/agendamentos-pendentes', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM agendamento_pendente ORDER BY 1 DESC LIMIT 200');
    res.json(r.rows);
  } catch { res.json([]); }
});

app.get('/api/message-stats', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT DATE(created_at) AS dia, COUNT(*) AS total
      FROM message_log WHERE created_at > NOW() - INTERVAL '14 days'
      GROUP BY 1 ORDER BY 1 DESC
    `);
    res.json(r.rows);
  } catch { res.json([]); }
});

app.listen(Number(PORT), () => console.log(`Painel rodando em :${PORT}`));
