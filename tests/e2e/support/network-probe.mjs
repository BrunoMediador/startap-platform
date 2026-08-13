import dns from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import process from 'node:process';

const TIMEOUT_MS = 2_500;

async function expectNetworkDenied(label, operation) {
  let escaped = false;
  try {
    escaped = await operation();
  } catch {
    return;
  }
  if (escaped) throw new Error(`${label} escapou da rede internal:true`);
}

function httpConnect(host, path = '/') {
  return new Promise((resolve) => {
    const req = http.get({ host, port: 80, path, timeout: TIMEOUT_MS }, (res) => {
      res.resume();
      resolve(true);
    });
    req.once('timeout', () => req.destroy(new Error('timeout')));
    req.once('error', () => resolve(false));
  });
}

function tcpConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: TIMEOUT_MS });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => socket.destroy(new Error('timeout')));
    socket.once('error', () => resolve(false));
  });
}

await expectNetworkDenied('metadata', () => httpConnect('169.254.169.254', '/latest/meta-data/'));
await expectNetworkDenied('IP público HTTP', () => httpConnect('1.1.1.1'));
await expectNetworkDenied('IP público TCP', () => tcpConnect('1.1.1.1', 443));
await expectNetworkDenied('bridge padrão', () => tcpConnect('172.17.0.1', 80));
await expectNetworkDenied('metadata Azure', () => tcpConnect('168.63.129.16', 80));
await expectNetworkDenied('canário HTTP do host', () =>
  httpConnect(process.env.E2E_HOST_CANARY_IP ?? '127.0.0.1'),
);

await dns.lookup('postgres');
await expectNetworkDenied('DNS externo', async () => {
  await dns.lookup('example.com');
  return true;
});

const ipv4Routes = await readFile('/proc/net/route', 'utf8');
if (
  ipv4Routes
    .split('\n')
    .slice(1)
    .some((line) => line.trim().split(/\s+/u)[1] === '00000000')
) {
  throw new Error('rede internal expôs rota default IPv4');
}
const ipv6Routes = await readFile('/proc/net/ipv6_route', 'utf8');
if (
  ipv6Routes.split('\n').some((line) => {
    const fields = line.trim().split(/\s+/u);
    return fields[0] === '00000000000000000000000000000000' && fields[1] === '00000000';
  })
) {
  throw new Error('rede internal expôs rota default IPv6');
}
process.stdout.write('internal network probes: OK\n');
