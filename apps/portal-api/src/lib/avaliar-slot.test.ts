import { describe, expect, it, vi } from 'vitest';
import { avaliarConflito, avaliarJanela, avaliarSlot } from './avaliar-slot.js';

const CONFIG_OK = {
  work: {
    0: null,
    1: [9 * 60, 19 * 60] as [number, number],
    2: [9 * 60, 19 * 60] as [number, number],
    3: [9 * 60, 19 * 60] as [number, number],
    4: [9 * 60, 19 * 60] as [number, number],
    5: [9 * 60, 19 * 60] as [number, number],
    6: null,
  },
  services: [{ name: 'Corte', min: 30 }],
  source: 'flow_clones' as const,
  timezone: 'America/Sao_Paulo',
};

// Quarta-feira (weekday 3) — dentro do horário de funcionamento.
const REF_NOW = new Date('2026-08-05T12:00:00-03:00');
const FUTURO_QUARTA = '2026-08-12';

describe('avaliarJanela (Fase 1 — sem I/O)', () => {
  it('livre: slot dentro da janela de funcionamento e do horizonte', () => {
    const r = avaliarJanela({
      config: CONFIG_OK,
      data: FUTURO_QUARTA,
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    expect(r.status).toBe('livre');
    expect(r.startUtc).toBeInstanceOf(Date);
    expect(r.endUtc).toBeInstanceOf(Date);
  });

  it('fora_da_janela: data além do horizonte', () => {
    const r = avaliarJanela({
      config: CONFIG_OK,
      data: '2027-01-01',
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    expect(r.status).toBe('fora_da_janela');
  });

  it('passado: data anterior a hoje', () => {
    const r = avaliarJanela({
      config: CONFIG_OK,
      data: '2026-08-01',
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    expect(r.status).toBe('passado');
  });

  it('passado: hoje mas dentro do piso de 10min', () => {
    const r = avaliarJanela({
      config: CONFIG_OK,
      data: '2026-08-05',
      hora: '12:05',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    expect(r.status).toBe('passado');
  });

  it('fechado: weekday sem janela de funcionamento (domingo)', () => {
    const r = avaliarJanela({
      config: CONFIG_OK,
      data: '2026-08-09', // domingo
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    expect(r.status).toBe('fechado');
  });

  it('fora_do_horario: fora da janela de funcionamento do dia', () => {
    const r = avaliarJanela({
      config: CONFIG_OK,
      data: FUTURO_QUARTA,
      hora: '20:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    expect(r.status).toBe('fora_do_horario');
  });
});

describe('avaliarConflito (Fase 2 — I/O)', () => {
  it('livre: sem eventos colidindo', async () => {
    const client = { listEvents: vi.fn().mockResolvedValue([]) };
    const janela = avaliarJanela({
      config: CONFIG_OK,
      data: FUTURO_QUARTA,
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    const r = await avaliarConflito({
      client,
      startUtc: janela.startUtc as Date,
      endUtc: janela.endUtc as Date,
    });
    expect(r.status).toBe('livre');
  });

  it('ocupado: evento existente colide com a janela', async () => {
    const janela = avaliarJanela({
      config: CONFIG_OK,
      data: FUTURO_QUARTA,
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    const client = {
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt_existente',
          summary: 'Outro',
          start: { dateTime: `${FUTURO_QUARTA}T10:00:00-03:00` },
          end: { dateTime: `${FUTURO_QUARTA}T10:30:00-03:00` },
        },
      ]),
    };
    const r = await avaliarConflito({
      client,
      startUtc: janela.startUtc as Date,
      endUtc: janela.endUtc as Date,
    });
    expect(r.status).toBe('ocupado');
    expect(r.conflito).toEqual({
      inicio: `${FUTURO_QUARTA}T10:00:00-03:00`,
      fim: `${FUTURO_QUARTA}T10:30:00-03:00`,
    });
  });

  it('ignora o proprio eventId (uso do PATCH revalidando)', async () => {
    const janela = avaliarJanela({
      config: CONFIG_OK,
      data: FUTURO_QUARTA,
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    const client = {
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt_proprio',
          summary: 'Self',
          start: { dateTime: `${FUTURO_QUARTA}T10:00:00-03:00` },
          end: { dateTime: `${FUTURO_QUARTA}T10:30:00-03:00` },
        },
      ]),
    };
    const r = await avaliarConflito({
      client,
      startUtc: janela.startUtc as Date,
      endUtc: janela.endUtc as Date,
      ignorarEventId: 'evt_proprio',
    });
    expect(r.status).toBe('livre');
  });
});

describe('avaliarSlot (composicao das 2 fases)', () => {
  it('curto-circuita na Fase 1 sem chamar o client quando fora da janela', async () => {
    const client = { listEvents: vi.fn() };
    const r = await avaliarSlot({
      client,
      config: CONFIG_OK,
      data: '2027-01-01',
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    expect(r.status).toBe('fora_da_janela');
    expect(client.listEvents).not.toHaveBeenCalled();
  });

  it('chega na Fase 2 e retorna ocupado quando ha conflito', async () => {
    const client = {
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt_x',
          summary: 'X',
          start: { dateTime: `${FUTURO_QUARTA}T10:00:00-03:00` },
          end: { dateTime: `${FUTURO_QUARTA}T10:30:00-03:00` },
        },
      ]),
    };
    const r = await avaliarSlot({
      client,
      config: CONFIG_OK,
      data: FUTURO_QUARTA,
      hora: '10:00',
      duracaoMin: 30,
      maxAheadDays: 60,
      now: REF_NOW,
    });
    expect(r.status).toBe('ocupado');
  });
});
