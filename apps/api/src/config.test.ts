/**
 * Testa o ConfigSchema em isolamento, sem depender de process.env real.
 *
 * Importa ConfigSchema diretamente — evita executar o IIFE do `config` singleton
 * ao carregar o módulo (o IIFE lança ZodError se as envs obrigatórias estiverem ausentes).
 * O schema é executável independentemente e pode ser testado com inputs mock.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// Importa apenas o schema — não o `config` singleton.
// Isso funciona porque ConfigSchema é export nomeado e pode ser usado
// sem acionar o IIFE (que falha sem envs obrigatórias no ambiente CI).
import { ConfigSchema } from './config.schema.js';

// ABACATEPAY_API_KEY NAO esta aqui de proposito: pagamento e feature dormente e a key
// e OPCIONAL no boot (postmortem P0 2026-06-09). O env minimo valido NAO precisa dela.
const VALID_BASE = {
  PG_HOST: 'localhost',
  PG_USER: 'user',
  PG_PASS: 'pass',
  PG_DB: 'db',
  WAHA_URL: 'http://waha:3000',
  WAHA_API_KEY: 'key',
  WHISPER_URL: 'http://whisper:9000',
  OPENAI_API_KEY: 'sk-test',
};

describe('ConfigSchema', () => {
  it('aceita env mínimo válido com defaults', () => {
    const result = ConfigSchema.parse(VALID_BASE);
    expect(result.OPENAI_MODEL).toBe('gpt-5.4');
    expect(result.CHAT_MEMORY_RETENTION).toBe(30);
    expect(result.CHAT_STALE_RUNNING_MAX_MINUTES).toBe(30);
    expect(result.STARTAP_WAHA_SESSIONS).toBe('startap,STARTAP_AI,STARTAP_AI_PROD');
    expect(result.AGENT_HISTORY_MAX_CHARS).toBe(12000);
    expect(result.AGENT_TOOL_RESULT_MAX_CHARS).toBe(6000);
  });

  it('falha se OPENAI_API_KEY ausente', () => {
    const { OPENAI_API_KEY: _omit, ...rest } = VALID_BASE;
    expect(() => ConfigSchema.parse(rest)).toThrow(z.ZodError);
  });

  it('falha se WAHA_URL não for URL válida', () => {
    expect(() => ConfigSchema.parse({ ...VALID_BASE, WAHA_URL: 'not-a-url' })).toThrow(z.ZodError);
  });

  it('VALIDA OK sem ABACATEPAY_API_KEY — boot nao falha (corretiva postmortem P0)', () => {
    // Regressao do incidente 2026-06-09: a key obrigatoria no boot derrubou api/worker.
    // Agora a feature dormente NAO acopla o uptime do core. App sobe sem a chave.
    const result = ConfigSchema.parse(VALID_BASE);
    expect(result.ABACATEPAY_API_KEY).toBeUndefined();
  });

  it('aceita ABACATEPAY_API_KEY quando presente (feature ativa)', () => {
    const result = ConfigSchema.parse({ ...VALID_BASE, ABACATEPAY_API_KEY: 'abacate-dev-key' });
    expect(result.ABACATEPAY_API_KEY).toBe('abacate-dev-key');
  });

  it('ABACATEPAY_BASE_URL mantem default mesmo sem a key', () => {
    const result = ConfigSchema.parse(VALID_BASE);
    expect(result.ABACATEPAY_BASE_URL).toBe('https://api.abacatepay.com');
  });

  it('aceita DEEPSEEK_API_KEY opcional', () => {
    const result = ConfigSchema.parse({ ...VALID_BASE, DEEPSEEK_API_KEY: 'ds-key' });
    expect(result.DEEPSEEK_API_KEY).toBe('ds-key');
  });

  it('coerce CHAT_MEMORY_RETENTION de string para number', () => {
    const result = ConfigSchema.parse({ ...VALID_BASE, CHAT_MEMORY_RETENTION: '60' });
    expect(result.CHAT_MEMORY_RETENTION).toBe(60);
  });

  it('coerce AGENT_HISTORY_MAX_CHARS de string para number', () => {
    const result = ConfigSchema.parse({ ...VALID_BASE, AGENT_HISTORY_MAX_CHARS: '8000' });
    expect(result.AGENT_HISTORY_MAX_CHARS).toBe(8000);
  });

  it('respeita STARTAP_WAHA_SESSIONS customizado', () => {
    const result = ConfigSchema.parse({ ...VALID_BASE, STARTAP_WAHA_SESSIONS: 'minha_sessao' });
    expect(result.STARTAP_WAHA_SESSIONS).toBe('minha_sessao');
  });
});
