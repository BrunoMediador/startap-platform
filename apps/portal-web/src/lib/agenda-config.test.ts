import { describe, expect, it } from 'vitest';
import {
  type AgendaConfigDraft,
  ajudaLink,
  isAgendaDirty,
  isLinkValido,
  normalizeLink,
  toAgendaDraft,
  validateAgenda,
} from './agenda-config';

const ON: AgendaConfigDraft = { agenda_automatica: true, link_agendamento: '' };
const OFF: AgendaConfigDraft = { agenda_automatica: false, link_agendamento: '' };

describe('toAgendaDraft', () => {
  it('default = automático ligado, link vazio (campos ausentes)', () => {
    expect(toAgendaDraft(null)).toEqual(ON);
    expect(toAgendaDraft(undefined)).toEqual(ON);
    expect(toAgendaDraft({})).toEqual(ON);
  });

  it('preserva agenda_automatica=false e o link', () => {
    expect(
      toAgendaDraft({ agenda_automatica: false, link_agendamento: 'https://x.com/a' }),
    ).toEqual({ agenda_automatica: false, link_agendamento: 'https://x.com/a' });
  });

  it('trata link null como vazio', () => {
    expect(
      toAgendaDraft({ agenda_automatica: false, link_agendamento: null }).link_agendamento,
    ).toBe('');
  });
});

describe('normalizeLink', () => {
  it('preserva URL com esquema', () => {
    expect(normalizeLink('https://booksy.com/ze')).toBe('https://booksy.com/ze');
    expect(normalizeLink('  http://x.com  ')).toBe('http://x.com');
  });

  it('completa https:// quando falta esquema', () => {
    expect(normalizeLink('booksy.com/ze')).toBe('https://booksy.com/ze');
  });

  it('vazio permanece vazio', () => {
    expect(normalizeLink('')).toBe('');
    expect(normalizeLink('   ')).toBe('');
  });
});

describe('isLinkValido', () => {
  it('aceita URLs http(s) com host válido (com ou sem esquema)', () => {
    expect(isLinkValido('https://booksy.com/ze')).toBe(true);
    expect(isLinkValido('booksy.com/ze')).toBe(true);
    expect(isLinkValido('http://agenda.trinks.com/barbearia')).toBe(true);
  });

  it('rejeita lixo / host sem ponto / vazio', () => {
    expect(isLinkValido('')).toBe(false);
    expect(isLinkValido('não é link')).toBe(false);
    expect(isLinkValido('https://localhost')).toBe(false);
    expect(isLinkValido('ftp://x.com')).toBe(false);
  });
});

describe('validateAgenda — link SEMPRE opcional', () => {
  it('automático ligado, sem link -> ok', () => {
    const res = validateAgenda(ON);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ agenda_automatica: true, link_agendamento: '' });
  });

  it('automático DESLIGADO, sem link -> ok (não é obrigatório)', () => {
    const res = validateAgenda(OFF);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ agenda_automatica: false, link_agendamento: '' });
  });

  it('normaliza o link no payload (completa https://)', () => {
    const res = validateAgenda({ agenda_automatica: false, link_agendamento: 'booksy.com/ze' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.link_agendamento).toBe('https://booksy.com/ze');
  });

  it('rejeita FORMATO inválido quando preenchido', () => {
    const res = validateAgenda({ agenda_automatica: false, link_agendamento: 'não é link' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/inválido/i);
  });
});

describe('isAgendaDirty', () => {
  it('detecta mudança no toggle', () => {
    expect(isAgendaDirty(OFF, ON)).toBe(true);
  });

  it('detecta mudança no link (ignora espaços nas bordas)', () => {
    expect(
      isAgendaDirty(
        { agenda_automatica: false, link_agendamento: ' https://x.com/a ' },
        { agenda_automatica: false, link_agendamento: 'https://x.com/a' },
      ),
    ).toBe(false);
    expect(
      isAgendaDirty(
        { agenda_automatica: false, link_agendamento: 'https://y.com' },
        { agenda_automatica: false, link_agendamento: 'https://x.com' },
      ),
    ).toBe(true);
  });
});

describe('ajudaLink', () => {
  it('varia conforme o link estar preenchido', () => {
    expect(ajudaLink(true)).toMatch(/envia este link/i);
    expect(ajudaLink(false)).toMatch(/avisa sua equipe/i);
  });
});
