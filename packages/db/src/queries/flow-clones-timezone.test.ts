/**
 * Data layer do fuso por clone (migration 068 — follow-up de validação/escrita).
 *
 * DB mockado (../client.js). Foco: slot SEMPRE parametrizado ($1), nunca
 * interpolado; getter degrada pra SP; updater escopado ao slot e retorna
 * false quando o slot não existe. invalidateCloneCache real (só limpa um Map
 * em memória — inofensivo no teste).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();
// Client transacional (createClone usa pool.connect()) — query captura por SQL.
const mockClientQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {
    connect: async () => ({
      query: (...args: unknown[]) => mockClientQuery(...args),
      release: () => {},
    }),
  },
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { createClone, getTimezoneBySlot, updateTimezoneBySlot } = await import('./flow-clones.js');

const SLOT = 'clone_seven_7_barber_dqjzb4';

beforeEach(() => {
  mockQuery.mockReset();
  mockClientQuery.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getTimezoneBySlot', () => {
  it('devolve o fuso gravado, com slot parametrizado ($1)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ timezone: 'America/Cuiaba' }] });
    const tz = await getTimezoneBySlot(SLOT);
    expect(tz).toBe('America/Cuiaba');
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('WHERE slot = $1'), [SLOT]);
  });

  it('slot inexistente => default America/Sao_Paulo (nunca null)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getTimezoneBySlot(SLOT)).toBe('America/Sao_Paulo');
  });

  it('coluna vazia (null) => default America/Sao_Paulo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ timezone: null }] });
    expect(await getTimezoneBySlot(SLOT)).toBe('America/Sao_Paulo');
  });
});

describe('updateTimezoneBySlot', () => {
  it('grava o fuso escopado ao slot (parametrizado) e retorna true', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const ok = await updateTimezoneBySlot(SLOT, 'America/Cuiaba');
    expect(ok).toBe(true);
    // slot em $1, timezone em $2 — nunca interpolado.
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE flow_clones SET timezone = $2'),
      [SLOT, 'America/Cuiaba'],
    );
  });

  it('slot inexistente (rowCount 0) => false', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    const ok = await updateTimezoneBySlot(SLOT, 'America/Cuiaba');
    expect(ok).toBe(false);
  });

  it('guard P3-2: tz inválido => NO-OP (nao chama query) e retorna false', async () => {
    const ok = await updateTimezoneBySlot(SLOT, 'Marte/Olympus');
    expect(ok).toBe(false);
    // Defesa em profundidade: nada é gravado — a coluna nunca vê lixo.
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

// createClone (P3-1): helper sem callers de produção HOJE (o caminho vivo é
// createCloneRecords), mas o guard IANA interno impede persistir lixo se alguém o
// religar com input de usuário. Aqui capturamos os values do INSERT flow_clones
// (timezone = $7 -> índice 6) via client transacional (pool.connect()).
describe('createClone — guard IANA do timezone (P3-1, landmine)', () => {
  function armCreateClone(): { capturedTimezone: () => unknown } {
    let captured: unknown;
    mockClientQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT provider, model, temperature FROM bot_config')) {
        return { rows: [{ provider: 'openai', model: 'gpt-5.4', temperature: '0.7' }] };
      }
      if (sql.includes('SELECT prompt FROM bot_prompt')) {
        return { rows: [{ prompt: 'Oi {{nome_negocio}}' }] };
      }
      if (sql.includes('INSERT INTO flow_clones')) {
        captured = params[6]; // $7 = timezone
        return { rows: [{ id: 1, slot: String(params[0]), timezone: params[6] }] };
      }
      // BEGIN/COMMIT, INSERT bot_config/bot_prompt/flow_controls, SELECT media/courses,
      // dual-write UPDATEs -> tudo vazio.
      return { rows: [] };
    });
    return { capturedTimezone: () => captured };
  }

  const base = { matrizSlot: 'teste_barbearia', displayName: 'Barbearia X' } as const;

  it('tz válido não-SP (America/Cuiaba) é persistido', async () => {
    const { capturedTimezone } = armCreateClone();
    await createClone({ ...base, timezone: 'America/Cuiaba' });
    expect(capturedTimezone()).toBe('America/Cuiaba');
  });

  it('tz inválido => cai pro DEFAULT America/Sao_Paulo (nunca grava lixo)', async () => {
    const { capturedTimezone } = armCreateClone();
    await createClone({ ...base, timezone: 'Marte/Olympus' });
    expect(capturedTimezone()).toBe('America/Sao_Paulo');
  });

  it('tz ausente => DEFAULT America/Sao_Paulo (byte-idêntico ao de hoje)', async () => {
    const { capturedTimezone } = armCreateClone();
    await createClone({ ...base });
    expect(capturedTimezone()).toBe('America/Sao_Paulo');
  });
});
