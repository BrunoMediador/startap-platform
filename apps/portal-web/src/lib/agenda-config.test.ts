import { describe, expect, it } from 'vitest';
import {
  type AgendaConfigDraft,
  ajudaLink,
  isAgendaDirty,
  isLinkValido,
  isRecepcaoPreenchida,
  isRecepcaoValida,
  normalizeLink,
  recepcaoToE164,
  toAgendaDraft,
  validateAgenda,
} from './agenda-config';

const ON: AgendaConfigDraft = {
  agenda_automatica: true,
  link_agendamento: '',
  recepcao_telefone: '',
};
const OFF: AgendaConfigDraft = {
  agenda_automatica: false,
  link_agendamento: '',
  recepcao_telefone: '',
};

/** Draft a partir de ON com overrides (evita repetir recepcao_telefone nos testes). */
function d(over: Partial<AgendaConfigDraft>): AgendaConfigDraft {
  return { ...ON, ...over };
}

describe('toAgendaDraft', () => {
  it('default = automático ligado, link/telefone vazios (campos ausentes)', () => {
    expect(toAgendaDraft(null)).toEqual(ON);
    expect(toAgendaDraft(undefined)).toEqual(ON);
    expect(toAgendaDraft({})).toEqual(ON);
  });

  it('preserva agenda_automatica=false e o link', () => {
    expect(
      toAgendaDraft({ agenda_automatica: false, link_agendamento: 'https://x.com/a' }),
    ).toEqual({
      agenda_automatica: false,
      link_agendamento: 'https://x.com/a',
      recepcao_telefone: '',
    });
  });

  it('trata link null como vazio', () => {
    expect(
      toAgendaDraft({ agenda_automatica: false, link_agendamento: null }).link_agendamento,
    ).toBe('');
  });

  it('mascara o telefone RAW E.164 do backend pra exibição BR (tira o DDI 55)', () => {
    expect(toAgendaDraft({ recepcao_telefone: '5531987654321' }).recepcao_telefone).toBe(
      '(31) 98765-4321',
    );
    expect(toAgendaDraft({ recepcao_telefone: null }).recepcao_telefone).toBe('');
    expect(toAgendaDraft({}).recepcao_telefone).toBe('');
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
    const res = validateAgenda(d({ agenda_automatica: false, link_agendamento: 'booksy.com/ze' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.link_agendamento).toBe('https://booksy.com/ze');
  });

  it('rejeita FORMATO inválido quando preenchido', () => {
    const res = validateAgenda(d({ agenda_automatica: false, link_agendamento: 'não é link' }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/inválido/i);
  });

  it('NÃO inclui recepcao_telefone no value (é campo top-level, fora do perfil)', () => {
    const res = validateAgenda(d({ recepcao_telefone: '(31) 98765-4321' }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ agenda_automatica: true, link_agendamento: '' });
  });
});

describe('isAgendaDirty', () => {
  it('detecta mudança no toggle', () => {
    expect(isAgendaDirty(OFF, ON)).toBe(true);
  });

  it('detecta mudança no link (ignora espaços nas bordas)', () => {
    expect(
      isAgendaDirty(
        d({ agenda_automatica: false, link_agendamento: ' https://x.com/a ' }),
        d({ agenda_automatica: false, link_agendamento: 'https://x.com/a' }),
      ),
    ).toBe(false);
    expect(
      isAgendaDirty(
        d({ agenda_automatica: false, link_agendamento: 'https://y.com' }),
        d({ agenda_automatica: false, link_agendamento: 'https://x.com' }),
      ),
    ).toBe(true);
  });

  it('detecta mudança no telefone da recepção (compara só dígitos)', () => {
    // Mesmo número, máscaras diferentes -> não é mudança.
    expect(
      isAgendaDirty(
        d({ recepcao_telefone: '(31) 98765-4321' }),
        d({ recepcao_telefone: '31987654321' }),
      ),
    ).toBe(false);
    // Número diferente -> mudança.
    expect(
      isAgendaDirty(d({ recepcao_telefone: '(31) 98765-4321' }), d({ recepcao_telefone: '' })),
    ).toBe(true);
  });
});

describe('telefone da recepção', () => {
  it('isRecepcaoPreenchida: true só quando há dígitos', () => {
    expect(isRecepcaoPreenchida('')).toBe(false);
    expect(isRecepcaoPreenchida('  ')).toBe(false);
    expect(isRecepcaoPreenchida('(31) 9')).toBe(true);
  });

  it('isRecepcaoValida: 10 (fixo) ou 11 (móvel) dígitos locais', () => {
    expect(isRecepcaoValida('(31) 98765-4321')).toBe(true); // 11
    expect(isRecepcaoValida('(31) 3333-4444')).toBe(true); // 10
    expect(isRecepcaoValida('(31) 9')).toBe(false); // curto
    expect(isRecepcaoValida('')).toBe(false);
    // Aceita paste com DDI colado (phoneDigits tira o 55).
    expect(isRecepcaoValida('+55 31 98765-4321')).toBe(true);
  });

  it('recepcaoToE164: prefixa 55; vazio/inválido -> ""', () => {
    expect(recepcaoToE164('(31) 98765-4321')).toBe('5531987654321');
    expect(recepcaoToE164('+55 31 98765-4321')).toBe('5531987654321');
    expect(recepcaoToE164('')).toBe('');
    expect(recepcaoToE164('(31) 9')).toBe('');
  });
});

describe('ajudaLink', () => {
  it('varia conforme o link estar preenchido', () => {
    expect(ajudaLink(true)).toMatch(/envia este link/i);
    expect(ajudaLink(false)).toMatch(/avisa sua equipe/i);
  });
});
