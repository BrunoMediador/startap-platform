/**
 * Resolvers async env→coluna dos gates de produtização (ADR 0030 D1, migration 072).
 *
 * Prova:
 *  - CURTO-CIRCUITO no env: quando o env cobre o slot (ou é '*'), retorna true SEM tocar o banco
 *    (byte-idêntico + zero leitura extra pra quem já roda hoje).
 *  - LEITURA da coluna: quando o env NÃO cobre, lê o clone (cache getCloneBySlot) e devolve a coluna.
 *  - AMBOS OFF -> off; clone ausente -> off (fail-safe).
 *  - BYTE-IDENTIDADE dos 4 clones vivos com os envs atuais.
 *
 * Mocka a camada de query (../client.js) — sem DB real, mesmo padrão de flow-clones-cache.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const {
  invalidateCloneCache,
  resolveModoAtendenteEnabledForSlot,
  resolveAtendFromAgendaEnabledForSlot,
} = await import('./flow-clones.js');

const MEDUZZA = 'clone_meduzza_barbearia_q23psc';
const DRAGON = 'clone_barber_dragon_caly8b';
const CIRILO = 'clone_cirilobarbearia_c8w2f0';
const SAMUEL = 'clone_barbearia_samuel_uefpqc';

// Envs de PRODUÇÃO hoje (o que precisa ficar byte-idêntico).
const ENV_MODO = MEDUZZA;
const ENV_BILLING = `${DRAGON},${CIRILO},${SAMUEL}`;

function rowFor(
  slot: string,
  cols: {
    modo_atendente_enabled?: boolean;
    billing_from_agenda_enabled?: boolean;
  },
): Record<string, unknown> {
  return {
    id: '1',
    slot,
    matriz_slot: 'teste_barbearia',
    display_name: 'Teste',
    cliente_nome: null,
    cliente_telefone: null,
    personalizacao: {},
    waha_sessao: `sessao_${slot}`,
    status: 'conectado',
    created_at: new Date(),
    updated_at: new Date(),
    modo_atendente_enabled: cols.modo_atendente_enabled ?? false,
    billing_from_agenda_enabled: cols.billing_from_agenda_enabled ?? false,
  };
}

describe('resolvers async env→coluna (flow_clones, ADR 0030 D1)', () => {
  beforeEach(() => {
    invalidateCloneCache();
    mockQuery.mockReset();
  });
  afterEach(() => {
    invalidateCloneCache();
  });

  describe('resolveModoAtendenteEnabledForSlot', () => {
    it('env cobre o slot -> true SEM query (curto-circuito/kill-switch)', async () => {
      const on = await resolveModoAtendenteEnabledForSlot(MEDUZZA, ENV_MODO);
      expect(on).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('env "*" -> true SEM query', async () => {
      const on = await resolveModoAtendenteEnabledForSlot(CIRILO, '*');
      expect(on).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('env NÃO cobre + coluna true -> true (lê o clone)', async () => {
      mockQuery.mockResolvedValue({ rows: [rowFor(CIRILO, { modo_atendente_enabled: true })] });
      const on = await resolveModoAtendenteEnabledForSlot(CIRILO, '');
      expect(on).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('env NÃO cobre + coluna false -> false', async () => {
      mockQuery.mockResolvedValue({ rows: [rowFor(CIRILO, { modo_atendente_enabled: false })] });
      expect(await resolveModoAtendenteEnabledForSlot(CIRILO, '')).toBe(false);
    });

    it('clone ausente (rows vazio) -> false (fail-safe)', async () => {
      mockQuery.mockResolvedValue({ rows: [] });
      expect(await resolveModoAtendenteEnabledForSlot('clone_inexistente', '')).toBe(false);
    });
  });

  describe('resolveAtendFromAgendaEnabledForSlot', () => {
    it('env cobre o slot -> true SEM query', async () => {
      expect(await resolveAtendFromAgendaEnabledForSlot(DRAGON, ENV_BILLING)).toBe(true);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('env NÃO cobre + coluna true -> true', async () => {
      mockQuery.mockResolvedValue({
        rows: [rowFor('clone_novo', { billing_from_agenda_enabled: true })],
      });
      expect(await resolveAtendFromAgendaEnabledForSlot('clone_novo', '')).toBe(true);
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });

    it('env NÃO cobre + coluna false -> false', async () => {
      mockQuery.mockResolvedValue({
        rows: [rowFor('clone_novo', { billing_from_agenda_enabled: false })],
      });
      expect(await resolveAtendFromAgendaEnabledForSlot('clone_novo', '')).toBe(false);
    });
  });

  describe('BYTE-IDENTIDADE dos 4 clones vivos (envs atuais)', () => {
    it('modo atendente: só Meduzza ON; todos SEM query (env cobre ou não-alvo lê coluna false)', async () => {
      // Meduzza no env -> true sem query. Os demais não estão no env de modo -> leem coluna=false.
      mockQuery.mockImplementation((sql: string, params: unknown[]) => {
        const slot = String((params as string[])[0]);
        return Promise.resolve({ rows: [rowFor(slot, { modo_atendente_enabled: false })] });
      });
      expect(await resolveModoAtendenteEnabledForSlot(MEDUZZA, ENV_MODO)).toBe(true);
      for (const slot of [DRAGON, CIRILO, SAMUEL]) {
        expect(await resolveModoAtendenteEnabledForSlot(slot, ENV_MODO)).toBe(false);
      }
    });

    it('billing-da-agenda: dragon/cirilo/samuel ON via env (sem query); Meduzza OFF', async () => {
      mockQuery.mockImplementation((_sql: string, params: unknown[]) => {
        const slot = String((params as string[])[0]);
        return Promise.resolve({ rows: [rowFor(slot, { billing_from_agenda_enabled: false })] });
      });
      for (const slot of [DRAGON, CIRILO, SAMUEL]) {
        expect(await resolveAtendFromAgendaEnabledForSlot(slot, ENV_BILLING)).toBe(true);
      }
      expect(mockQuery).not.toHaveBeenCalled(); // os 3 estão no env -> curto-circuito, zero leitura.
      expect(await resolveAtendFromAgendaEnabledForSlot(MEDUZZA, ENV_BILLING)).toBe(false);
    });
  });
});
