/**
 * Regressão SCRUM-140: sob queda total do WAHA, a janela de graça do envio de alerta
 * (SEND_ERROR_GRACE_MS) somada por broadcast x destinatário podia empurrar o ciclo do
 * monitor perto/além do limiar de liveness do heartbeat (~3min). Como o cron do monitor
 * (worker.ts, ALERTS_CRON, padrão "a cada 2 min") não tinha `protect: true`, o próximo
 * tick sobrepunha o anterior ainda rodando e gerava falso "worker travado" durante um
 * incidente real do WAHA (o invariante anti-duplicação do monitor seguia intacto — o
 * sintoma era só o alarme de liveness espúrio).
 *
 * Teste lê o SOURCE (não replica a lógica à mão) e verifica o predicado: o cron do
 * monitor tem `protect: true` na MESMA declaração de options do `scheduleCronSafe`.
 * Padrão consolidado no time (lição PR #491): réplica manual passa nos dois mundos e
 * não guarda nada; ler o source é o que efetivamente trava a regressão.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workerSrc = readFileSync(fileURLToPath(new URL('./worker.ts', import.meta.url)), 'utf-8');
const monitorSrc = readFileSync(
  fileURLToPath(new URL('./jobs/monitor.ts', import.meta.url)),
  'utf-8',
);

describe('worker.ts — cron do monitor (SCRUM-140)', () => {
  it('registra o cron do monitor com { protect: true } (evita overlap de ciclo)', () => {
    // Isola o bloco do registro do cron 'monitor': do scheduleCronSafe(config.ALERTS_CRON, ...)
    // até o próximo scheduleCronSafe( subsequente (ou fim do arquivo), pra não casar
    // acidentalmente com outro cron que também usa protect: true.
    const start = workerSrc.indexOf("name: 'monitor'");
    expect(start, "bloco do cron 'monitor' não encontrado em worker.ts").toBeGreaterThan(-1);

    const nextCallOffset = workerSrc.indexOf('scheduleCronSafe(', start + 1);
    const block = workerSrc.slice(start, nextCallOffset === -1 ? undefined : nextCallOffset);

    expect(block).toContain("name: 'monitor'");
    expect(block).toMatch(/protect:\s*true/);
  });

  it('outros 3 crons com overlap conhecido (billing-silence-alert, message-ack-alert, gcal-atend-sync) seguem com protect: true (não regrediram)', () => {
    for (const name of ['billing-silence-alert', 'message-ack-alert', 'gcal-atend-sync']) {
      const idx = workerSrc.indexOf(`name: '${name}'`);
      expect(idx, `cron '${name}' não encontrado`).toBeGreaterThan(-1);
      const nearby = workerSrc.slice(idx, idx + 200);
      expect(nearby).toMatch(/protect:\s*true/);
    }
  });
});

describe('monitor.ts — SEND_ERROR_GRACE_MS (SCRUM-140)', () => {
  it('grace de erro tardio do envio é 1000ms (reduzido de 3000ms)', () => {
    const match = monitorSrc.match(/const SEND_ERROR_GRACE_MS = ([\d_]+);/);
    expect(match, 'declaração de SEND_ERROR_GRACE_MS não encontrada em monitor.ts').not.toBeNull();
    const value = Number((match as RegExpMatchArray)[1].replace(/_/g, ''));
    expect(value).toBe(1_000);
  });
});
