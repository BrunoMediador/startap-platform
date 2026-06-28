/**
 * Valida APENAS a FORMA/labels dos fixtures de eval do bot-detect (SCRUM-4 PR-B).
 *
 * Este teste NÃO chama LLM nem importa código de runtime. A avaliação real do
 * classificador contra estes casos é responsabilidade do PR-D.
 *
 * O que garante:
 *  - cada linha do .jsonl é JSON válido e bem-formado;
 *  - campos obrigatórios presentes e tipados (id, label, messages, why);
 *  - label ∈ {human, bot}; addressing/signals dentro do vocabulário documentado;
 *  - ids únicos; contagem 30–50; ambos os rótulos com massa razoável;
 *  - nenhum telefone real vazado (sem sequência de 11+ dígitos).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ADDRESSING = new Set(['pn', 'lid', 'broadcast', 'group']);
// Chaves de sinal documentadas em docs/bot-detect/sinais.md.
const SIGNALS = new Set([
  'flood',
  'cadencia_regular',
  'instantaneidade',
  'addressing_lid',
  'addressing_broadcast',
  'addressing_group',
  'templated',
  'pushname_marca',
  'mutualidade_eco',
]);

interface EvalCase {
  id: string;
  label: 'human' | 'bot';
  messages: string[];
  why: string;
  pushName?: string;
  addressing?: string;
  signals?: string[];
}

const raw = readFileSync(new URL('./eval-cases.jsonl', import.meta.url), 'utf8');
const lines = raw.split('\n').filter((l) => l.trim().length > 0);
const cases: EvalCase[] = lines.map((l, i) => {
  try {
    return JSON.parse(l) as EvalCase;
  } catch (e) {
    throw new Error(`Linha ${i + 1} não é JSON válido: ${(e as Error).message}`);
  }
});

describe('bot-detect eval-cases.jsonl — forma/labels', () => {
  it('tem entre 30 e 50 casos', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.length).toBeLessThanOrEqual(50);
  });

  it('ids são únicos e não-vazios', () => {
    const ids = cases.map((c) => c.id);
    for (const id of ids) expect(typeof id === 'string' && id.length > 0).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('todo caso tem label válido', () => {
    for (const c of cases) {
      expect(c.label === 'human' || c.label === 'bot').toBe(true);
    }
  });

  it('ambos os rótulos têm massa razoável (≥ 10 cada)', () => {
    const human = cases.filter((c) => c.label === 'human').length;
    const bot = cases.filter((c) => c.label === 'bot').length;
    expect(human).toBeGreaterThanOrEqual(10);
    expect(bot).toBeGreaterThanOrEqual(10);
  });

  it('messages é array não-vazio de strings não-vazias', () => {
    for (const c of cases) {
      expect(Array.isArray(c.messages)).toBe(true);
      expect(c.messages.length).toBeGreaterThan(0);
      for (const m of c.messages) {
        expect(typeof m).toBe('string');
        expect(m.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('why é string não-vazia (justificativa do rótulo)', () => {
    for (const c of cases) {
      expect(typeof c.why).toBe('string');
      expect(c.why.trim().length).toBeGreaterThan(0);
    }
  });

  it('addressing, quando presente, está no vocabulário', () => {
    for (const c of cases) {
      if (c.addressing !== undefined) {
        expect(ADDRESSING.has(c.addressing)).toBe(true);
      }
    }
  });

  it('signals, quando presente, só usa chaves documentadas', () => {
    for (const c of cases) {
      if (c.signals !== undefined) {
        expect(Array.isArray(c.signals)).toBe(true);
        for (const s of c.signals) {
          expect(SIGNALS.has(s)).toBe(true);
        }
      }
    }
  });

  it('pushName, quando presente, é string', () => {
    for (const c of cases) {
      if (c.pushName !== undefined) expect(typeof c.pushName).toBe('string');
    }
  });

  it('nenhum telefone real vazado (sem 11+ dígitos consecutivos)', () => {
    for (const c of cases) {
      const blob = JSON.stringify(c);
      expect(/[0-9]{11,}/.test(blob)).toBe(false);
    }
  });

  it('só campos esperados (sem ruído de schema)', () => {
    const allowed = new Set([
      'id',
      'label',
      'messages',
      'why',
      'pushName',
      'addressing',
      'signals',
    ]);
    for (const c of cases) {
      for (const k of Object.keys(c)) {
        expect(allowed.has(k)).toBe(true);
      }
    }
  });
});
