/**
 * Runner assíncrono in-process com semáforo de concorrência (ADR 0021).
 *
 * Resolve o gargalo de isolamento: hoje o handler do webhook segura a request
 * HTTP (e uma conexão do pool PG) durante toda a chamada à LLM, então um cliente
 * lento degrada todos os outros. Este runner permite que a rota responda 200 ao
 * WAHA IMEDIATAMENTE (ACK-early) e processe `handleWebhook` em background, com um
 * limite de concorrência que protege o pool PG (max 10) e o event loop.
 *
 * Mecanismos (ADR 0021 §Backpressure):
 *  1. SEMÁFORO `maxInFlight` (< pool PG de 10) — controle primário de isolamento.
 *     `tryAcquire()` falha (retorna null) quando saturado; a rota decide a política
 *     (retry-503 recomendado — a WAHA retenta 15×3s e o dedup evita duplicar).
 *  2. SEM buffer ilimitado em memória: não acumulamos fila própria — o semáforo +
 *     retry da WAHA É a fila, durável do lado do WAHA, sem custo de RAM nossa.
 *  3. TIMEOUT por tarefa (`taskTimeoutMs`): uma LLM travada libera o slot e não
 *     segura o semáforo para sempre (rede final: `close-stale-running` no worker).
 *  4. GRACEFUL DRAIN: `drain()` espera as tarefas in-flight terminarem antes de o
 *     processo encerrar (SIGTERM); o que não foi ACKeado, a WAHA retenta.
 *
 * ORDENAÇÃO POR CONVERSA (trade-off ACEITO — Bruno, ADR 0021 §Risco 3): NÃO há
 * serialização por (sessao, chatId). Duas mensagens seguidas do MESMO cliente
 * podem ser processadas em paralelo e respondidas FORA DE ORDEM (raro: o cliente
 * manda 1 msg e espera). Aceito para o volume atual; adicionar lock/fila por
 * conversa depois se necessário (ADR 0021 Passo 3).
 *
 * Este módulo NÃO lê config nem process.env — recebe os limites por parâmetro,
 * pra ser testável de forma isolada e determinística.
 */
import { logger } from '@startap/core/logger';

const log = logger.child({ module: 'async-runner' });

export interface AsyncRunnerOptions {
  /** Máximo de tarefas em background simultâneas (< pool PG). Ex.: 4. */
  maxInFlight: number;
  /** Timeout por tarefa em ms; 0 desativa o timeout (espera indefinida). */
  taskTimeoutMs: number;
}

/** Erro lançado quando uma tarefa de background estoura o timeout configurado. */
export class TaskTimeoutError extends Error {
  constructor(ms: number) {
    super(`async task timeout after ${ms}ms`);
    this.name = 'TaskTimeoutError';
  }
}

export class AsyncRunner {
  private readonly maxInFlight: number;
  private readonly taskTimeoutMs: number;
  /** Nº de slots ocupados (tarefas agendadas e ainda não finalizadas). */
  private inFlight = 0;
  /** Promises das tarefas em voo — base do drain(). */
  private readonly pending = new Set<Promise<void>>();
  /** Após drainStart(), recusa novas aquisições (modo shutdown). */
  private draining = false;

  constructor(opts: AsyncRunnerOptions) {
    if (!Number.isInteger(opts.maxInFlight) || opts.maxInFlight < 1) {
      throw new Error(`maxInFlight inválido: ${opts.maxInFlight} (esperado inteiro >= 1)`);
    }
    this.maxInFlight = opts.maxInFlight;
    this.taskTimeoutMs = opts.taskTimeoutMs;
  }

  /** Nº de tarefas em background neste instante (observabilidade/teste). */
  get currentInFlight(): number {
    return this.inFlight;
  }

  /** true quando todos os slots estão ocupados — próxima aquisição falha. */
  get isSaturated(): boolean {
    return this.inFlight >= this.maxInFlight;
  }

  /**
   * Tenta agendar `task` em background. Retorna:
   *  - true  -> slot adquirido, tarefa rodando em background (NÃO aguardar aqui);
   *  - false -> SATURADO (ou em shutdown) -> a rota aplica a política (503/retry).
   *
   * A tarefa NUNCA derruba a request (já respondida): erros e timeout são
   * capturados e passados para `onSettled` (a rota loga em flow_execution_logs).
   * O slot é SEMPRE liberado no finally, inclusive sob timeout.
   */
  schedule(task: () => Promise<void>, onSettled?: (err: unknown) => void): boolean {
    if (this.draining || this.isSaturated) return false;
    this.inFlight += 1;

    const run = this.withTimeout(task())
      .then(
        () => onSettled?.(null),
        (err) => onSettled?.(err),
      )
      .finally(() => {
        this.inFlight -= 1;
        this.pending.delete(run);
      });

    this.pending.add(run);
    // Guard de segurança: se onSettled não for passado, um reject não pode virar
    // unhandledRejection. O .then acima já consome, mas blindamos contra erro
    // SÍNCRONO de onSettled.
    run.catch((e) => log.error({ err: e }, 'Falha inesperada no wrapper da tarefa async'));
    return true;
  }

  /** Envolve a tarefa com timeout; rejeita com TaskTimeoutError se estourar. */
  private withTimeout(p: Promise<void>): Promise<void> {
    if (this.taskTimeoutMs <= 0) return p;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new TaskTimeoutError(this.taskTimeoutMs)),
        this.taskTimeoutMs,
      );
      p.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
    });
  }

  /**
   * Graceful shutdown: para de aceitar novas tarefas e espera as in-flight
   * terminarem, com teto de `timeoutMs`. Retorna o nº de tarefas AINDA em voo
   * quando o timeout expirou (0 = drenou tudo). Idempotente.
   */
  async drain(timeoutMs: number): Promise<number> {
    this.draining = true;
    if (this.pending.size === 0) return 0;

    log.info({ inFlight: this.inFlight }, 'Drenando tarefas async em voo (shutdown)');
    const all = Promise.allSettled([...this.pending]).then(() => undefined);

    if (timeoutMs <= 0) {
      await all;
      return this.inFlight;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    await Promise.race([all, timeout]);
    if (timer) clearTimeout(timer);

    if (this.inFlight > 0) {
      log.warn(
        { inFlight: this.inFlight, timeoutMs },
        'Drain expirou com tarefas ainda em voo — WAHA retenta o que não foi ACKeado',
      );
    }
    return this.inFlight;
  }
}
