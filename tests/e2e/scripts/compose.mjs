import { spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';

const action = process.argv[2] ?? 'run';
const projectName = 'startap-e2e';
const artifactVolumeName = `${projectName}_e2e_artifacts`;
const compose = ['compose', '-f', 'tests/e2e/compose.yml', '-p', projectName];
const canonicalRounds = ['round-1', 'round-2'];
const longRunningServices = ['api', 'worker', 'portal-api', 'portal-web'];
const oneShotServices = ['worker-once', 'integration-probe', 'egress-probe', 'network-probe'];
const locallyBuiltTestServices = ['worker-once', 'integration-probe', 'egress-probe', 'e2e'];

function assertLifecycleContract() {
  const uniqueLongRunning = new Set(longRunningServices);
  const uniqueOneShots = new Set(oneShotServices);
  if (
    projectName !== 'startap-e2e' ||
    !/^[a-z0-9][a-z0-9_-]*$/u.test(projectName) ||
    artifactVolumeName !== 'startap-e2e_e2e_artifacts' ||
    canonicalRounds.length !== 2 ||
    uniqueLongRunning.size !== longRunningServices.length ||
    uniqueOneShots.size !== oneShotServices.length ||
    longRunningServices.some((service) => uniqueOneShots.has(service))
  ) {
    throw new Error('contrato E2E inválido: serviços long-running e one-shot devem ser disjuntos');
  }
}

async function assertArtifactVolume(expected, stage) {
  const output = await dockerOutput(['volume', 'ls', '--format', '{{.Name}}']);
  const exists = output.split(/\r?\n/u).includes(artifactVolumeName);
  if (exists !== expected) {
    throw new Error(
      `${stage}: volume ${artifactVolumeName} deveria estar ${expected ? 'criado' : 'removido'}`,
    );
  }
  process.stdout.write(
    `E2E artifact volume ${expected ? 'created' : 'removed'} (${stage}): ${artifactVolumeName}\n`,
  );
}

function hostCanaryIp() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  throw new Error('não foi possível determinar IP IPv4 do host para o canário de isolamento');
}

function dockerEnv() {
  return {
    ...process.env,
    COMPOSE_ANSI: 'never',
    E2E_HOST_CANARY_IP: process.env.E2E_HOST_CANARY_IP ?? hostCanaryIp(),
  };
}

function docker(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...compose, ...args], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: dockerEnv(),
      ...options,
    });
    child.once('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('Docker não está instalado/disponível. O E2E exige Docker Compose v2.'));
        return;
      }
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`docker compose falhou (code=${code ?? 'null'}, signal=${signal ?? 'none'})`),
        );
    });
  });
}

function dockerOutput(args, composeCommand = false) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...(composeCommand ? compose : []), ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: dockerEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => reject(error));
    child.once('exit', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `docker falhou com code=${code ?? 'null'}`));
    });
  });
}

async function preflight() {
  let version;
  try {
    version = (await dockerOutput(['version', '--format', '{{.Server.Version}}'])).trim();
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      throw new Error('Docker não está instalado/disponível. O E2E exige Docker Compose v2.');
    }
    throw error;
  }
  const major = Number(version.split('.')[0]);
  if (!Number.isInteger(major) || major < 28) {
    throw new Error(
      `Docker Engine >=28 obrigatório para gateway_mode_ipv4=isolated; encontrado ${version}`,
    );
  }
  await dockerOutput(['compose', 'version']);
  process.stdout.write(`Docker preflight: Engine ${version}, Compose v2 OK.\n`);
}

async function inspectIsolation() {
  const networkRaw = await dockerOutput(['network', 'inspect', 'startap-e2e_e2e']);
  const [network] = JSON.parse(networkRaw);
  if (network?.Internal !== true || network?.EnableIPv6 !== false) {
    throw new Error('network inspect divergiu: exige Internal=true e EnableIPv6=false');
  }
  if (network?.Options?.['com.docker.network.bridge.gateway_mode_ipv4'] !== 'isolated') {
    throw new Error('network inspect sem gateway_mode_ipv4=isolated');
  }

  const config = JSON.parse(await dockerOutput(['config', '--format', 'json'], true));
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const networks = Object.keys(service.networks ?? {});
    if (networks.length !== 1 || networks[0] !== 'e2e') {
      throw new Error(`${name}: serviço fora da rede e2e única`);
    }
    if (
      service.ports ||
      service.privileged ||
      service.network_mode === 'host' ||
      service.extra_hosts
    ) {
      throw new Error(`${name}: exposição proibida (ports/privileged/host/extra_hosts)`);
    }
    const mounts = Array.isArray(service.volumes) ? service.volumes : [];
    if (mounts.some((mount) => JSON.stringify(mount).includes('docker.sock'))) {
      throw new Error(`${name}: montagem de docker.sock proibida`);
    }
    if (name === 'integration-probe') {
      const probeMount = mounts.find(
        (mount) =>
          mount?.target === '/app/integration-probe.mjs' ||
          String(mount).includes(':/app/integration-probe.mjs'),
      );
      if (!probeMount || service.command?.[1] !== '/app/integration-probe.mjs') {
        throw new Error('integration-probe deve executar sob /app para resolver /app/node_modules');
      }
    }
    const security = service.security_opt ?? [];
    if (!security.some((item) => String(item).startsWith('no-new-privileges'))) {
      throw new Error(`${name}: no-new-privileges ausente`);
    }
    if (!['postgres', 'redis'].includes(name)) {
      const dropped = service.cap_drop ?? [];
      if (!dropped.includes('ALL')) throw new Error(`${name}: cap_drop ALL ausente`);
    }
    if (service.tmpfs !== undefined) {
      const tmpfs = Array.isArray(service.tmpfs) ? service.tmpfs : [];
      if (
        tmpfs.length !== 1 ||
        typeof tmpfs[0] !== 'string' ||
        !/^\/tmp:rw,noexec,nosuid,size=\d+m$/u.test(tmpfs[0])
      ) {
        throw new Error(`${name}: tmpfs renderizado deve conter um único mount /tmp`);
      }
    }
  }
  process.stdout.write('Compose isolation inspect: OK.\n');
}

async function down(stage = 'manual') {
  assertLifecycleContract();
  await docker(['--profile', 'runner', 'down', '--volumes', '--remove-orphans', '--timeout', '10']);
  await assertArtifactVolume(false, stage);
}

async function up(stage = 'manual') {
  assertLifecycleContract();
  await preflight();
  await down(`${stage}:pre-up`);
  await docker(['up', '--build', '--wait', '--wait-timeout', '180', ...longRunningServices]);
  await inspectIsolation();
}

async function test(stage = 'manual') {
  await docker(['--profile', 'runner', 'build', ...locallyBuiltTestServices]);
  for (const service of oneShotServices) {
    await docker(['run', '--rm', '--no-deps', service]);
  }
  await docker(['--profile', 'runner', 'run', '--rm', '--no-deps', 'e2e']);
  await assertArtifactVolume(true, stage);
}

async function main() {
  if (action === 'up') return up('up');
  if (action === 'preflight') return preflight();
  if (action === 'test') return test('test');
  if (action === 'down') return down('down');
  if (action === 'reset') return up('reset');
  if (action !== 'run') throw new Error(`ação desconhecida: ${action}`);

  let failed = false;
  try {
    for (const [index, round] of canonicalRounds.entries()) {
      await up(round);
      await test(round);
      await down(round);
      if (index === 0) {
        process.stdout.write(
          'E2E primeira execução verde; recriando volumes para prova de repetibilidade.\n',
        );
      }
    }
  } catch (error) {
    failed = true;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    await docker(['logs', '--no-color', '--tail', '120']).catch(() => undefined);
  } finally {
    await down('final').catch((error) => {
      process.stderr.write(
        `teardown falhou: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      failed = true;
    });
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
