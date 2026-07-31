/**
 * Regressão SCRUM-140: sob queda total do WAHA, a janela de graça do envio de alerta
 * (SEND_ERROR_GRACE_MS) somada por broadcast x destinatário podia empurrar o ciclo do
 * monitor perto/além do limiar de liveness do heartbeat (~3min). Como o cron do monitor
 * (worker.ts, ALERTS_CRON, padrão "a cada 2 min") não tinha `protect`, o próximo tick
 * sobrepunha o anterior ainda rodando e gerava falso "worker travado" durante um
 * incidente real do WAHA (o invariante anti-duplicação do monitor seguia intacto — o
 * sintoma era só o alarme de liveness espúrio).
 *
 * Review de follow-up (qa-tester): com `protect: true` (boolean), o croner BLOQUEIA o
 * tick sobreposto mas NUNCA loga nem chama callback — o skip é silencioso (confirmado
 * lendo node_modules/croner/dist/croner.js `_checkTrigger`: o callback só dispara quando
 * `g(this.options.protect)`, i.e. quando `protect` é FUNÇÃO). Como este é o cron que
 * DETECTA falha dos outros, um skip mudo e repetido (ciclos "quase-lentos", abaixo do
 * limiar do heartbeat) seria degradê PERMANENTE e silencioso dentro do próprio detector
 * de falha silenciosa. Fix: `protect` vira função `(job) => log.warn(...)` — o croner
 * trata `true` e função IGUAL pra decidir bloquear (`s = blocking && protect`, ambos
 * truthy); só o callback de observabilidade muda. Ver teste de runtime abaixo, que
 * exercita o croner de VERDADE (não mock) pra provar bloqueio + callback juntos.
 *
 * Teste estático lê o SOURCE (não replica a lógica à mão) — padrão do time (lição PR
 * #491): réplica manual passa nos dois mundos e não guarda nada; ler o source trava a
 * regressão de "voltar pra protect: true por engano".
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { describe, expect, it, vi } from 'vitest';

const workerSrc = readFileSync(fileURLToPath(new URL('./worker.ts', import.meta.url)), 'utf-8');
const monitorSrc = readFileSync(
  fileURLToPath(new URL('./jobs/monitor.ts', import.meta.url)),
  'utf-8',
);

describe('worker.ts — cron do monitor (SCRUM-140)', () => {
  it('registra o cron do monitor com protect COMO FUNÇÃO (não boolean) — croner só loga o skip quando é função', () => {
    // Isola o bloco do registro do cron 'monitor': da options { name: 'monitor', ... }
    // até o próximo scheduleCronSafe( subsequente (ou fim do arquivo), pra não casar
    // acidentalmente com outro cron que usa protect: true (boolean, válido pros outros 3).
    const start = workerSrc.indexOf("name: 'monitor'");
    expect(start, "bloco do cron 'monitor' não encontrado em worker.ts").toBeGreaterThan(-1);

    const nextCallOffset = workerSrc.indexOf('scheduleCronSafe(', start + 1);
    const block = workerSrc.slice(start, nextCallOffset === -1 ? undefined : nextCallOffset);

    expect(block).toContain("name: 'monitor'");
    // protect: (job) => {...} — função, NUNCA `protect: true` puro (isso reintroduziria o
    // skip silencioso que a review pediu pra fechar).
    expect(block).toMatch(/protect:\s*\(/);
    expect(block).not.toMatch(/protect:\s*true/);
  });

  it('outros 3 crons com overlap conhecido (billing-silence-alert, message-ack-alert, gcal-atend-sync) seguem com protect: true (boolean é aceitável pra eles — não são o detector de incidente)', () => {
    for (const name of ['billing-silence-alert', 'message-ack-alert', 'gcal-atend-sync']) {
      const idx = workerSrc.indexOf(`name: '${name}'`);
      expect(idx, `cron '${name}' não encontrado`).toBeGreaterThan(-1);
      const nearby = workerSrc.slice(idx, idx + 200);
      expect(nearby).toMatch(/protect:\s*true/);
    }
  });
});

describe('croner@9.1.0 — protect como FUNÇÃO (comportamento de runtime, biblioteca real)', () => {
  // Não mocka o croner: instancia um Cron de verdade com o MESMO padrão de `protect`
  // usado em worker.ts, e dirige o tempo com fake timers. Cobre o que a leitura de
  // source não cobre sozinha — que o callback realmente dispara SÓ no overlap, e que
  // o job seguinte (não sobreposto) roda normalmente depois.
  it('ciclo lento (still-running) → tick seguinte é BLOQUEADO e o callback protect roda com o job passado', async () => {
    vi.useFakeTimers();
    try {
      let running = 0;
      let completed = 0;
      const protectCalls: unknown[] = [];

      const job = new Cron(
        '* * * * * *', // a cada 1s — rápido o bastante pra sobrepor de propósito no teste
        {
          protect: (j) => {
            protectCalls.push(j.currentRun());
          },
        },
        async () => {
          running++;
          // 1º ciclo demora 3.5s (> 1 tick) de propósito, pra forçar overlap no 2º tick.
          const isFirst = running === 1;
          await new Promise((resolve) => setTimeout(resolve, isFirst ? 3_500 : 10));
          completed++;
        },
      );

      // Avança 1s: dispara o 1º ciclo (ainda vai demorar 3.5s pra terminar).
      await vi.advanceTimersByTimeAsync(1_000);
      expect(running).toBe(1);
      expect(completed).toBe(0);

      // Avança mais 1s (total 2s): o 2º tick chega com o 1º AINDA rodando —
      // deve ser BLOQUEADO (não incrementa running) e o protect deve logar o skip.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(running).toBe(1); // não subiu pra 2: o tick foi descartado
      expect(protectCalls.length).toBeGreaterThanOrEqual(1); // callback disparou

      // Avança até o 1º ciclo terminar (mais ~2s) e um novo tick rodar limpo.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(completed).toBeGreaterThanOrEqual(1); // o 1º ciclo terminou
      expect(running).toBeGreaterThanOrEqual(2); // e um novo ciclo (não sobreposto) rodou

      job.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sem overlap (ciclo rápido) → protect NUNCA é chamado', async () => {
    vi.useFakeTimers();
    try {
      let running = 0;
      const protectCalls: unknown[] = [];

      const job = new Cron('* * * * * *', { protect: () => protectCalls.push(true) }, async () => {
        running++;
        await new Promise((resolve) => setTimeout(resolve, 10)); // rápido, nunca sobrepõe
      });

      await vi.advanceTimersByTimeAsync(3_000);

      expect(running).toBeGreaterThanOrEqual(2);
      expect(protectCalls).toHaveLength(0);

      job.stop();
    } finally {
      vi.useRealTimers();
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
