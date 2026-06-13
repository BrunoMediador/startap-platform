/**
 * Testes do resolvedor de endpoint WAHA por shard (ADR 0020, Passo 2).
 *
 * Foco safe-by-construction:
 *   - Flag OFF (default) -> SEMPRE a WAHA_URL única de hoje, qualquer que seja o
 *     shardId (comportamento idêntico ao de antes do sharding).
 *   - Flag ON com mapa só de shard 0 -> ainda a mesma URL (PREP: 1 shard hoje).
 *   - Flag ON com shard 1 configurado -> resolve a URL do shard 1; shard
 *     desconhecido cai no shard 0 (fallback).
 *
 * Nada bate em WAHA real; manipula apenas process.env.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WAHA_SHARD_ID, listConfiguredShards, resolveWahaUrl } from './shard.js';

const ORIGINAL_ENV = { ...process.env };
const SHARD_VARS = ['WAHA_SHARDING', 'WAHA_URL', 'WAHA_SHARD_0_URL', 'WAHA_SHARD_1_URL'];

beforeEach(() => {
  // Base previsível: parte do ambiente original e REMOVE de fato as vars de
  // shard/flag (Reflect.deleteProperty em vez do operador delete — regra do biome).
  // Reatribuir como string "undefined" NÃO serve: o resolver leria valor setado.
  const clean = { ...ORIGINAL_ENV };
  for (const k of SHARD_VARS) Reflect.deleteProperty(clean, k);
  process.env = clean;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('resolveWahaUrl — flag WAHA_SHARDING OFF (default)', () => {
  it('usa a WAHA_URL única de hoje, ignorando o shardId', () => {
    process.env.WAHA_URL = 'http://waha:3000';
    // Sem flag: comportamento idêntico ao de antes do sharding.
    expect(resolveWahaUrl()).toBe('http://waha:3000');
    expect(resolveWahaUrl(0)).toBe('http://waha:3000');
    // Mesmo pedindo um shard "1", a flag OFF manda na URL única (não roteia).
    expect(resolveWahaUrl(1)).toBe('http://waha:3000');
  });

  it('cai no default http://waha:3000 quando WAHA_URL não está setada', () => {
    expect(resolveWahaUrl()).toBe('http://waha:3000');
  });

  it('shardId default é 0 (shard atual = automacoes-waha-1)', () => {
    expect(DEFAULT_WAHA_SHARD_ID).toBe(0);
  });
});

describe('resolveWahaUrl — flag WAHA_SHARDING ON, só shard 0 mapeado (PREP de hoje)', () => {
  beforeEach(() => {
    process.env.WAHA_SHARDING = 'true';
    process.env.WAHA_URL = 'http://waha:3000';
  });

  it('shard 0 resolve a mesma URL de hoje (equivalência funcional)', () => {
    expect(resolveWahaUrl(0)).toBe('http://waha:3000');
    expect(resolveWahaUrl()).toBe('http://waha:3000');
  });

  it('shard desconhecido (1) cai no shard 0 — sem shard 1 ainda', () => {
    // PREP: nenhum WAHA_SHARD_1_URL → fallback para a URL atual. Nada é roteado pra
    // lugar diferente até existir um shard 1 de verdade.
    expect(resolveWahaUrl(1)).toBe('http://waha:3000');
  });

  it('WAHA_SHARD_0_URL explícita sobrepõe WAHA_URL para o shard 0', () => {
    process.env.WAHA_SHARD_0_URL = 'http://automacoes-waha-1:3000';
    expect(resolveWahaUrl(0)).toBe('http://automacoes-waha-1:3000');
  });
});

describe('resolveWahaUrl — flag ON com shard 1 configurado (futuro)', () => {
  beforeEach(() => {
    process.env.WAHA_SHARDING = 'true';
    process.env.WAHA_URL = 'http://waha:3000';
    process.env.WAHA_SHARD_1_URL = 'http://automacoes-waha-2:3000';
  });

  it('shard 1 resolve a URL do container do shard 1', () => {
    expect(resolveWahaUrl(1)).toBe('http://automacoes-waha-2:3000');
  });

  it('shard 0 continua na URL atual — sessões antigas intocadas', () => {
    expect(resolveWahaUrl(0)).toBe('http://waha:3000');
  });

  it('shard desconhecido (9) cai no shard 0 (fallback seguro)', () => {
    expect(resolveWahaUrl(9)).toBe('http://waha:3000');
  });
});

describe('listConfiguredShards', () => {
  it('flag OFF: só o shard 0 com a URL única de hoje', () => {
    process.env.WAHA_URL = 'http://waha:3000';
    expect(listConfiguredShards()).toEqual([{ shardId: 0, url: 'http://waha:3000' }]);
  });

  it('flag ON com shard 1: lista shard 0 e 1 ordenados', () => {
    process.env.WAHA_SHARDING = 'true';
    process.env.WAHA_URL = 'http://waha:3000';
    process.env.WAHA_SHARD_1_URL = 'http://automacoes-waha-2:3000';
    expect(listConfiguredShards()).toEqual([
      { shardId: 0, url: 'http://waha:3000' },
      { shardId: 1, url: 'http://automacoes-waha-2:3000' },
    ]);
  });
});
