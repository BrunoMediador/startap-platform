/**
 * Unit de getCloneAlertOwner (Missão 023 — fix do destino de cancelamento p/ clones NOVOS).
 *
 * Cobre a precedência alert_owner_phone -> cliente_telefone (fallback) + o toggle enabled.
 * Mocka o `query` do client (sem DB real), mesmo padrão de flow-clones-cache.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockQuery = vi.fn();

vi.mock('../client.js', () => ({
  pool: {},
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { getCloneAlertOwner, setCloneAlertOwnerPhoneIfEmpty } = await import('./flow-clones.js');

describe('getCloneAlertOwner — fallback alert_owner_phone -> cliente_telefone', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('usa alert_owner_phone quando preenchido (clone já com backfill)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: '5535999991234',
          cliente_telefone: '5511888887777',
          alert_owner_enabled: true,
          display_name: 'Barbearia Cirilo',
        },
      ],
    });

    const owner = await getCloneAlertOwner('clone_cirilo');

    // Precedência: ignora cliente_telefone porque alert_owner_phone é válido.
    expect(owner).toEqual({
      phone: '5535999991234',
      enabled: true,
      displayName: 'Barbearia Cirilo',
    });
  });

  it('FALLBACK: alert_owner_phone NULL -> usa cliente_telefone (clone NOVO sem backfill)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: null,
          cliente_telefone: '+55 (35) 98888-7777',
          alert_owner_enabled: true,
          display_name: 'Barbearia Nova',
        },
      ],
    });

    const owner = await getCloneAlertOwner('clone_novo');

    // Normaliza só dígitos do cliente_telefone como destino.
    expect(owner?.phone).toBe('5535988887777');
    expect(owner?.enabled).toBe(true);
  });

  it('FALLBACK: alert_owner_phone vazio/curto -> usa cliente_telefone', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: '   ', // vira <8 dígitos após normalizar
          cliente_telefone: '5535977776666',
          alert_owner_enabled: true,
          display_name: 'Salão X',
        },
      ],
    });

    const owner = await getCloneAlertOwner('clone_salao');

    expect(owner?.phone).toBe('5535977776666');
  });

  it('alert_owner_enabled=false -> não retorna destino (enabled=false), mesmo com phone', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: '5535999991234',
          cliente_telefone: '5511888887777',
          alert_owner_enabled: false,
          display_name: 'Clone de teste',
        },
      ],
    });

    const owner = await getCloneAlertOwner('clone_teste');

    // O chamador (client-alert) trata enabled=false como 'disabled' e não escala.
    expect(owner?.enabled).toBe(false);
    expect(owner?.phone).toBe('5535999991234');
  });

  it('sem alert_owner_phone E sem cliente_telefone -> phone=null', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: null,
          cliente_telefone: null,
          alert_owner_enabled: true,
          display_name: 'Clone órfão',
        },
      ],
    });

    const owner = await getCloneAlertOwner('clone_orfao');

    expect(owner?.phone).toBeNull();
  });

  it('slot inexistente -> null', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const owner = await getCloneAlertOwner('clone_nao_existe');

    expect(owner).toBeNull();
  });
});

describe('setCloneAlertOwnerPhoneIfEmpty — autofill do número da sessão (só se vazio)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('grava quando estava vazio (UPDATE afetou 1 linha) e retorna true', async () => {
    mockQuery.mockResolvedValue({ rows: [{ slot: 'clone_seven_7' }], rowCount: 1 });

    const filled = await setCloneAlertOwnerPhoneIfEmpty('clone_seven_7', '556599453860@c.us');

    expect(filled).toBe(true);
    // SQL parametrizado com placeholders DISTINTOS ($1 phone, $2 slot) — guard IS NULL/''.
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('alert_owner_phone IS NULL');
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    // dígitos puros do me.id (sem @c.us), preservando o número.
    expect(params).toEqual(['556599453860', 'clone_seven_7']);
  });

  it('NÃO sobrescreve valor já preenchido: UPDATE não afeta linha -> retorna false', async () => {
    // O guard WHERE alert_owner_phone IS NULL/'' faz o UPDATE não casar -> rowCount 0.
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const filled = await setCloneAlertOwnerPhoneIfEmpty('clone_cirilo', '5511979630828@c.us');

    expect(filled).toBe(false);
  });

  it('preserva o 9 do me.id (formato dos pagantes: 13 dígitos com 9)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ slot: 'clone_x' }], rowCount: 1 });

    await setCloneAlertOwnerPhoneIfEmpty('clone_x', '5511979630828@c.us');

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // NÃO canonicaliza (canonicalE164 removeria o 9) — grava igual ao Cirilo.
    expect((params as string[])[0]).toBe('5511979630828');
  });

  it('normaliza me.id com sufixo de device e @s.whatsapp.net', async () => {
    mockQuery.mockResolvedValue({ rows: [{ slot: 'clone_y' }], rowCount: 1 });

    await setCloneAlertOwnerPhoneIfEmpty('clone_y', '5531999998842:12@s.whatsapp.net');

    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect((params as string[])[0]).toBe('5531999998842');
  });

  it('me.id curto/inválido (<8 dígitos) -> não grava, retorna false (não toca o banco)', async () => {
    const filled = await setCloneAlertOwnerPhoneIfEmpty('clone_z', '123');

    expect(filled).toBe(false);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
