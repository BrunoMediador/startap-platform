/**
 * Guard do PG_SEARCH_PATH (SCRUM-90 — endurecimento pedido pelo arquiteto).
 *
 * resolveSearchPath só devolve o schema quando (1) há marcador de TESTE (NODE_ENV=test | VITEST)
 * e (2) o valor passa a whitelist de identificador. Fora disso = undefined (comporta como unset),
 * blindando prod contra uma env perdida repontar as queries e contra injeção via env.
 *
 * O logger é MOCKADO (via vi.hoisted) — o teste checa retorno + que o warn dispara nos casos de
 * ignorar. Importar client.ts NÃO conecta (pg.Pool é lazy).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@startap/core/logger', () => ({
  logger: { child: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { resolveSearchPath } from './client.js';

describe('resolveSearchPath — guard do PG_SEARCH_PATH (SCRUM-90)', () => {
  const SAVED = {
    PG_SEARCH_PATH: process.env.PG_SEARCH_PATH,
    NODE_ENV: process.env.NODE_ENV,
    VITEST: process.env.VITEST,
  };

  function restore(k: keyof typeof SAVED) {
    const v = SAVED[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const KEYS = ['PG_SEARCH_PATH', 'NODE_ENV', 'VITEST'] as const;

  beforeEach(() => {
    warn.mockClear();
    // Acesso por chave COMPUTADA (delete process.env[k]) — o membro estático dispara noDelete.
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) restore(k);
  });

  it('unset → undefined (search_path default, sem warn)', () => {
    expect(resolveSearchPath()).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('COM marcador de teste (VITEST) + valor válido → devolve o schema', () => {
    process.env.VITEST = 'true';
    process.env.PG_SEARCH_PATH = 'itest_gcal_sync';
    expect(resolveSearchPath()).toBe('itest_gcal_sync');
    expect(warn).not.toHaveBeenCalled();
  });

  it('NODE_ENV=test também habilita; lista simples com vírgula é válida', () => {
    process.env.NODE_ENV = 'test';
    process.env.PG_SEARCH_PATH = 'itest_x,public';
    expect(resolveSearchPath()).toBe('itest_x,public');
  });

  it('setada SEM marcador de teste → IGNORADA (fail-safe) + warn', () => {
    process.env.NODE_ENV = 'production';
    process.env.PG_SEARCH_PATH = 'itest_x';
    expect(resolveSearchPath()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('valor com espaço → IGNORADO pela whitelist + warn', () => {
    process.env.VITEST = 'true';
    process.env.PG_SEARCH_PATH = 'itest_x public';
    expect(resolveSearchPath()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('valor com injeção de startup option (-c) → IGNORADO pela whitelist', () => {
    process.env.VITEST = 'true';
    process.env.PG_SEARCH_PATH = 'x -c statement_timeout=0';
    expect(resolveSearchPath()).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
