import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fetchWithNodeFetch from 'node-fetch';
import OpenAI from 'openai';

const wahaProbeUrl = process.env.E2E_WAHA_PROBE_URL ?? 'http://fake-waha:4010';
const llmProbeUrl = process.env.E2E_FAKE_LLM_URL ?? 'http://fake-llm:4013';

async function expectBlocked(label, operation) {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error && error.message.includes('E2E_EGRESS_BLOCKED')) return;
    throw new Error(
      `${label} falhou sem bloqueio explícito: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throw new Error(`${label} escapou do guard`);
}

const request = (module, url) =>
  new Promise((resolve, reject) => {
    try {
      const req = module.get(url, resolve);
      req.once('error', reject);
    } catch (error) {
      reject(error);
    }
  });

const connect = (host) =>
  new Promise((resolve, reject) => {
    try {
      const socket = net.connect(80, host, () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    } catch (error) {
      reject(error);
    }
  });

const bindServer = net.createServer();
try {
  await new Promise((resolve, reject) => {
    bindServer.once('error', reject);
    bindServer.listen(0, '0.0.0.0', resolve);
  });
} finally {
  if (bindServer.listening) {
    await new Promise((resolve, reject) => {
      bindServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

await expectBlocked('fetch externo', () => fetch('http://example.invalid/'));
await expectBlocked('fetch metadata', () => fetch('http://169.254.169.254/latest/meta-data/'));
await expectBlocked('fetch wildcard IPv4', () => fetch('http://0.0.0.0/'));
await expectBlocked('http externo', () => request(http, 'http://example.invalid/'));
await expectBlocked('http wildcard IPv4', () => request(http, 'http://0.0.0.0/'));
await expectBlocked('https externo', () => request(https, 'https://example.invalid/'));
await expectBlocked('node-fetch externo', () => fetchWithNodeFetch('https://example.invalid/'));
await expectBlocked('https wildcard IPv4', () => request(https, 'https://0.0.0.0/'));
await expectBlocked('net.connect wildcard IPv4', () => connect('0.0.0.0'));
await expectBlocked('net.connect wildcard IPv4 abreviado', () => connect('0.0.0'));
await expectBlocked(
  'net externo',
  () =>
    new Promise((resolve, reject) => {
      try {
        const socket = net.connect(53, '1.1.1.1', resolve);
        socket.once('error', reject);
      } catch (error) {
        reject(error);
      }
    }),
);
await expectBlocked('dns externo', () => dns.lookup('example.invalid'));
await expectBlocked('dns.promises wildcard IPv4', () => dns.lookup('0.0.0.0'));
await expectBlocked('dns.promises wildcard IPv4 abreviado', () => dns.lookup('0.0.0'));
await expectBlocked(
  'bridge host',
  () =>
    new Promise((resolve, reject) => {
      try {
        const socket = net.connect(80, 'host.docker.internal', resolve);
        socket.once('error', reject);
      } catch (error) {
        reject(error);
      }
    }),
);

const internal = await fetch(`${wahaProbeUrl}/health`);
if (!internal.ok) throw new Error('allowlist interna não alcançou fake-waha');
const openai = new OpenAI({ apiKey: 'e2e_openai_probe_key' });
const deepseek = new OpenAI({
  apiKey: 'e2e_deepseek_probe_key',
  baseURL: 'https://api.deepseek.com/v1',
});
for (const [client, model] of [
  [openai, 'egress-openai'],
  [deepseek, 'egress-deepseek'],
]) {
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: 'probe e2e' }],
  });
  if (completion.choices[0]?.message.content !== 'Resposta deterministica E2E.') {
    throw new Error(`SDK ${model} não recebeu resposta do fake LLM`);
  }
}
const llmStateResponse = await fetch(`${llmProbeUrl}/__admin/state`);
if (!llmStateResponse.ok) throw new Error('estado do fake LLM indisponível');
const llmState = await llmStateResponse.json();
const probeModels = llmState.journal
  .filter((entry) => entry.kind === 'llm' && entry.path === '/v1/chat/completions')
  .map((entry) => entry.body.model)
  .filter((model) => model === 'egress-openai' || model === 'egress-deepseek')
  .sort();
if (JSON.stringify(probeModels) !== JSON.stringify(['egress-deepseek', 'egress-openai'])) {
  throw new Error('OpenAI/DeepSeek não chegaram exatamente uma vez ao fake LLM');
}
process.stdout.write('egress guard probes: OK\n');
