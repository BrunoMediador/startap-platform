/**
 * Testes do AsyncRunner (ADR 0021) — semáforo de concorrência + timeout + drain.
 *
 * Cobre: agenda em background sem bloquear; satura no limite (schedule=false);
 * libera slot ao terminar; timeout libera slot e reporta erro; drain espera o
 * in-flight; drain com timeout retorna o que sobrou; rejeita config inválida.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncRunner, TaskTimeoutError } from './async-runner.js';

vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

/** Promise controlável manualmente — base pra segurar tarefas "em voo". */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('AsyncRunner', () => {
  describe('construção', () => {
    it('rejeita maxInFlight < 1 ou não-inteiro', () => {
      expect(() => new AsyncRunner({ maxInFlight: 0, taskTimeoutMs: 0 })).toThrow();
      expect(() => new AsyncRunner({ maxInFlight: 1.5, taskTimeoutMs: 0 })).toThrow();
    });
  });

  describe('semáforo de concorrência', () => {
    it('agenda em background sem bloquear (schedule=true) e libera slot ao terminar', async () => {
      const runner = new AsyncRunner({ maxInFlight: 2, taskTimeoutMs: 0 });
      const d = deferred();
      const ok = runner.schedule(() => d.promise);
      expect(ok).toBe(true);
      expect(runner.currentInFlight).toBe(1);

      d.resolve();
      await tick();
      expect(runner.currentInFlight).toBe(0);
    });

    it('satura no limite — schedule retorna false sem rodar a tarefa', async () => {
      const runner = new AsyncRunner({ maxInFlight: 2, taskTimeoutMs: 0 });
      const tasks = [deferred(), deferred()];
      expect(runner.schedule(() => tasks[0].promise)).toBe(true);
      expect(runner.schedule(() => tasks[1].promise)).toBe(true);
      expect(runner.isSaturated).toBe(true);

      const blocked = vi.fn(() => Promise.resolve());
      expect(runner.schedule(blocked)).toBe(false);
      expect(blocked).not.toHaveBeenCalled();

      // Liberar um slot reabre a vaga.
      tasks[0].resolve();
      await tick();
      expect(runner.isSaturated).toBe(false);
      expect(runner.schedule(() => tasks[1].promise)).toBe(true);
    });

    it('chama onSettled(null) no sucesso e onSettled(err) na falha — sempre libera o slot', async () => {
      const runner = new AsyncRunner({ maxInFlight: 1, taskTimeoutMs: 0 });
      const settledOk = vi.fn();
      runner.schedule(() => Promise.resolve(), settledOk);
      await tick();
      expect(settledOk).toHaveBeenCalledWith(null);
      expect(runner.currentInFlight).toBe(0);

      const boom = new Error('boom');
      const settledErr = vi.fn();
      runner.schedule(() => Promise.reject(boom), settledErr);
      await tick();
      expect(settledErr).toHaveBeenCalledWith(boom);
      expect(runner.currentInFlight).toBe(0);
    });
  });

  describe('timeout por tarefa', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('estoura TaskTimeoutError, reporta em onSettled e libera o slot', async () => {
      const runner = new AsyncRunner({ maxInFlight: 1, taskTimeoutMs: 50 });
      const never = deferred(); // nunca resolve
      const settled = vi.fn();
      runner.schedule(() => never.promise, settled);
      expect(runner.currentInFlight).toBe(1);

      await vi.advanceTimersByTimeAsync(60);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled.mock.calls[0]?.[0]).toBeInstanceOf(TaskTimeoutError);
      expect(runner.currentInFlight).toBe(0);
    });
  });

  describe('graceful drain', () => {
    it('espera as tarefas in-flight terminarem e recusa novas durante o drain', async () => {
      const runner = new AsyncRunner({ maxInFlight: 2, taskTimeoutMs: 0 });
      const d = deferred();
      runner.schedule(() => d.promise);

      const drainPromise = runner.drain(1000);
      // Durante o drain, novas tarefas são recusadas.
      expect(runner.schedule(() => Promise.resolve())).toBe(false);

      d.resolve();
      const remaining = await drainPromise;
      expect(remaining).toBe(0);
    });

    it('drain sem in-flight retorna 0 imediatamente', async () => {
      const runner = new AsyncRunner({ maxInFlight: 2, taskTimeoutMs: 0 });
      expect(await runner.drain(1000)).toBe(0);
    });

    it('drain com timeout retorna o nº de tarefas ainda em voo', async () => {
      vi.useFakeTimers();
      try {
        const runner = new AsyncRunner({ maxInFlight: 2, taskTimeoutMs: 0 });
        const stuck = deferred(); // nunca resolve dentro do teste
        runner.schedule(() => stuck.promise);

        const drainPromise = runner.drain(30);
        await vi.advanceTimersByTimeAsync(40);
        const remaining = await drainPromise;
        expect(remaining).toBe(1);
        stuck.resolve(); // limpa o pendente
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
