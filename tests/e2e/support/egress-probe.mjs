import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

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

await expectBlocked('fetch externo', () => fetch('http://example.invalid/'));
await expectBlocked('fetch metadata', () => fetch('http://169.254.169.254/latest/meta-data/'));
await expectBlocked('http externo', () => request(http, 'http://example.invalid/'));
await expectBlocked('https externo', () => request(https, 'https://example.invalid/'));
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

const internal = await fetch('http://fake-waha:4010/health');
if (!internal.ok) throw new Error('allowlist interna não alcançou fake-waha');
process.stdout.write('egress guard probes: OK\n');
