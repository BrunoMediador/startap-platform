/**
 * Testes unitários para loadScheduleConfig (V3 — sem fallback silencioso).
 *
 * Não conecta no banco — usa mocks do módulo @startap/db.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks devem ser declarados antes do import do módulo testado.
vi.mock('@startap/db', () => ({
  flowClones: {
    getCloneBySlot: vi.fn(),
  },
  query: vi.fn(),
}));

import { flowClones, query } from '@startap/db';
import { loadScheduleConfig } from './free-slots.js';

const mockGetCloneBySlot = vi.mocked(flowClones.getCloneBySlot);
const mockQuery = vi.mocked(query);

const HORARIOS_VALIDOS = {
  domingo: { fechado: true },
  segunda: { fechado: false, abre: '09:00', fecha: '18:00' },
  terca: { fechado: false, abre: '09:00', fecha: '18:00' },
  quarta: { fechado: false, abre: '09:00', fecha: '18:00' },
  quinta: { fechado: false, abre: '09:00', fecha: '18:00' },
  sexta: { fechado: false, abre: '09:00', fecha: '18:00' },
  sabado: { fechado: false, abre: '09:00', fecha: '18:00' },
};

const SERVICOS_VALIDOS = [
  { nome: 'Corte', duracao_min: 30, preco_cents: 2500 },
  { nome: 'Barba', duracao_min: 30, preco_cents: 2000 },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('loadScheduleConfig — caminho feliz', () => {
  it('retorna config do clone quando flow_clones tem horarios e servicos', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_cirilobarbearia_c8w2f0',
      matriz_slot: 'teste_barbearia',
      horarios_funcionamento: HORARIOS_VALIDOS,
      servicos: SERVICOS_VALIDOS,
    } as never);

    const cfg = await loadScheduleConfig('clone_cirilobarbearia_c8w2f0');

    expect(cfg.source).toBe('flow_clones');
    expect(cfg.services).toHaveLength(2);
    expect(cfg.services[0]?.name).toBe('Corte');
    expect(cfg.work[1]).toEqual([9 * 60, 18 * 60]);
  });

  it('cai para bot_config da matriz quando clone existe mas sem config', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_sem_config',
      matriz_slot: 'teste_barbearia',
      horarios_funcionamento: null,
      servicos: null,
    } as never);

    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: SERVICOS_VALIDOS,
        },
      ],
    } as never);

    const cfg = await loadScheduleConfig('clone_sem_config');

    expect(cfg.source).toBe('bot_config');
    expect(cfg.services).toHaveLength(2);
  });

  it('retorna config do bot_config quando nao ha clone (slot e a propria matriz)', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);

    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: SERVICOS_VALIDOS,
        },
      ],
    } as never);

    const cfg = await loadScheduleConfig('teste_barbearia');

    expect(cfg.source).toBe('bot_config');
  });
});

describe('loadScheduleConfig — erro explícito (V3: sem fallback silencioso)', () => {
  it('lanca erro quando clone existe mas nem clone nem matriz tem config', async () => {
    mockGetCloneBySlot.mockResolvedValue({
      slot: 'clone_mal_configurado',
      matriz_slot: 'matriz_mal_configurada',
      horarios_funcionamento: null,
      servicos: null,
    } as never);

    // Matriz também sem config
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await expect(loadScheduleConfig('clone_mal_configurado')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'clone_mal_configurado'",
    );
  });

  it('lanca erro quando nao ha clone e bot_config do slot esta sem config', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    await expect(loadScheduleConfig('slot_sem_config')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'slot_sem_config'",
    );
  });

  it('lanca erro quando nao ha clone e bot_config tem horarios mas sem servicos', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({
      rows: [
        {
          horarios_funcionamento: HORARIOS_VALIDOS,
          servicos: [],
        },
      ],
    } as never);

    await expect(loadScheduleConfig('slot_sem_servicos')).rejects.toThrow(
      "Configuração de horários/serviços ausente para o slot 'slot_sem_servicos'",
    );
  });

  it('NAO retorna BUILTIN_DEFAULTS em nenhum cenario — o tipo "defaults" foi removido', async () => {
    mockGetCloneBySlot.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ rows: [] } as never);

    // Garantir que não é possível obter source: 'defaults' — o tipo foi removido do ScheduleConfig.
    // A promise deve rejeitar antes de qualquer return.
    const result = loadScheduleConfig('qualquer_slot');
    await expect(result).rejects.toThrow();
  });
});
