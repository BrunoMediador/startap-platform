import { describe, expect, it } from 'vitest';
import {
  BRAZIL_TIMEZONES,
  DEFAULT_TIMEZONE,
  buildTimezoneOptions,
  filterTimezones,
  friendlyLabel,
  getUtcOffsetLabel,
  matchesQuery,
  normalizeSearch,
} from './timezones';

// Data fixa: o Brasil não usa mais horário de verão desde 2019, então os offsets são
// estáveis o ano todo. Fixar a data mantém o teste determinístico em qualquer runner.
const AT = new Date('2026-01-15T12:00:00Z');
const MINUS = '−'; // sinal de menos tipográfico usado no rótulo

describe('getUtcOffsetLabel (offset via Intl, nunca chumbado)', () => {
  it('São Paulo = UTC−3', () => {
    expect(getUtcOffsetLabel('America/Sao_Paulo', AT)).toBe(`UTC${MINUS}3`);
  });

  it('Cuiabá = UTC−4 (o caso real que motivou a feature)', () => {
    expect(getUtcOffsetLabel('America/Cuiaba', AT)).toBe(`UTC${MINUS}4`);
  });

  it('Rio Branco = UTC−5', () => {
    expect(getUtcOffsetLabel('America/Rio_Branco', AT)).toBe(`UTC${MINUS}5`);
  });

  it('fuso com meia hora mantém os minutos (Kolkata = UTC+5:30)', () => {
    expect(getUtcOffsetLabel('Asia/Kolkata', AT)).toBe('UTC+5:30');
  });

  it('UTC puro vira UTC±0', () => {
    expect(getUtcOffsetLabel('UTC', AT)).toBe('UTC±0');
  });

  it('fuso inválido degrada pra "UTC" sem lançar', () => {
    expect(getUtcOffsetLabel('Nao/Existe', AT)).toBe('UTC');
  });
});

describe('friendlyLabel', () => {
  it('usa o rótulo do Brasil quando conhecido', () => {
    expect(friendlyLabel('America/Cuiaba')).toBe('Cuiabá');
    expect(friendlyLabel('America/Sao_Paulo')).toBe('São Paulo / Brasília');
  });

  it('deriva a cidade do IANA pro resto do mundo (underscore vira espaço)', () => {
    expect(friendlyLabel('America/New_York')).toBe('New York');
    expect(friendlyLabel('Europe/Lisbon')).toBe('Lisbon');
  });
});

describe('buildTimezoneOptions', () => {
  it('Brasil vem na ordem de prioridade, São Paulo primeiro', () => {
    const { brazil } = buildTimezoneOptions(DEFAULT_TIMEZONE, AT);
    expect(brazil[0].id).toBe('America/Sao_Paulo');
    expect(brazil.map((o) => o.id)).toEqual(BRAZIL_TIMEZONES.map((t) => t.id));
    expect(brazil.every((o) => o.brazil)).toBe(true);
  });

  it('cada opção carrega o offset computado', () => {
    const { brazil } = buildTimezoneOptions(DEFAULT_TIMEZONE, AT);
    const cuiaba = brazil.find((o) => o.id === 'America/Cuiaba');
    expect(cuiaba?.offsetLabel).toBe(`UTC${MINUS}4`);
  });

  it('mundo não repete os fusos do Brasil e vem ordenado por rótulo', () => {
    const { brazil, world } = buildTimezoneOptions(DEFAULT_TIMEZONE, AT);
    const brIds = new Set(brazil.map((o) => o.id));
    expect(world.some((o) => brIds.has(o.id))).toBe(false);
    const labels = world.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'pt-BR')));
  });

  it('um selecionado fora da lista do runtime nunca some (entra no mundo)', () => {
    const { world } = buildTimezoneOptions('Fake/Legacy_Alias', AT);
    expect(world.some((o) => o.id === 'Fake/Legacy_Alias')).toBe(true);
  });
});

describe('busca (Brasil-first, sem acento)', () => {
  it('normalizeSearch tira acento e caixa', () => {
    expect(normalizeSearch('  Cuiabá ')).toBe('cuiaba');
  });

  it('"cui" acha Cuiabá', () => {
    const groups = buildTimezoneOptions(DEFAULT_TIMEZONE, AT);
    const ids = filterTimezones(groups, 'cui').map((o) => o.id);
    expect(ids).toContain('America/Cuiaba');
  });

  it('"lis" acha Lisboa (Europe/Lisbon)', () => {
    const groups = buildTimezoneOptions(DEFAULT_TIMEZONE, AT);
    const ids = filterTimezones(groups, 'lis').map((o) => o.id);
    expect(ids).toContain('Europe/Lisbon');
  });

  it('resultado do Brasil aparece antes do mundo', () => {
    const groups = buildTimezoneOptions(DEFAULT_TIMEZONE, AT);
    // "a" casa muitíssimos; o 1º resultado tem que ser um fuso do Brasil.
    const first = filterTimezones(groups, 'a')[0];
    expect(first?.brazil).toBe(true);
  });

  it('casa também pelo offset digitado (ex.: "utc-4")', () => {
    const groups = buildTimezoneOptions(DEFAULT_TIMEZONE, AT);
    const ids = filterTimezones(groups, `utc${MINUS}4`).map((o) => o.id);
    expect(ids).toContain('America/Cuiaba');
  });

  it('matchesQuery vazio casa tudo', () => {
    expect(matchesQuery({ id: 'X', label: 'x', offsetLabel: 'UTC', brazil: false }, '')).toBe(true);
  });
});
