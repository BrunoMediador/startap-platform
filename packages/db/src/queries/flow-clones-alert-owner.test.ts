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

const {
  getCloneAlertOwner,
  getCloneReceptionAlertTarget,
  setCloneAlertOwnerPhoneIfEmpty,
  clearAlertOwnerPhoneBySlot,
  getCloneDisconnectAlertTarget,
} = await import('./flow-clones.js');

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

describe('getCloneReceptionAlertTarget — sem fallback/self-send', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('aceita somente o E.164 BR salvo no WhatsApp da recepção', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: '5535999991234',
          alert_owner_enabled: true,
          display_name: 'Negócio X',
        },
      ],
    });
    await expect(getCloneReceptionAlertTarget('clone_x')).resolves.toEqual({
      phone: '5535999991234',
      enabled: true,
      displayName: 'Negócio X',
    });
  });

  it('número ausente ou inválido vira null — nunca usa cliente_telefone como fallback', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: '11999998888',
          alert_owner_enabled: true,
          display_name: 'Negócio X',
        },
      ],
    });
    const target = await getCloneReceptionAlertTarget('clone_x');
    expect(target?.phone).toBeNull();
    const [sql] = mockQuery.mock.calls[0] as [string];
    expect(sql).not.toContain('cliente_telefone');
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

describe('clearAlertOwnerPhoneBySlot — LIMPA o destino (grava NULL, SCRUM-62)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('grava NULL escopado por slot ($1) e retorna true quando afetou 1 linha', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    const cleared = await clearAlertOwnerPhoneBySlot('clone_meduzza_barbearia_q23psc');

    expect(cleared).toBe(true);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    // NULL literal (não sentinela) + slot parametrizado (anti-IDOR: slot vem da sessão).
    expect(sql).toContain('alert_owner_phone = NULL');
    expect(sql).toContain('WHERE slot = $1');
    expect(params).toEqual(['clone_meduzza_barbearia_q23psc']);
  });

  it('slot inexistente (rowCount 0) -> retorna false', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const cleared = await clearAlertOwnerPhoneBySlot('clone_nao_existe');

    expect(cleared).toBe(false);
  });

  it('após CLEAR, getCloneAlertOwner (alert_owner_phone NULL) cai no fallback cliente_telefone', async () => {
    // Prova o comportamento-alvo: limpar o campo => alerta sai pro número da PRÓPRIA sessão.
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: null, // limpo pelo dono
          cliente_telefone: '5531999998842', // = número pareado da sessão
          alert_owner_enabled: true,
          display_name: 'Meduzza Barbearia',
        },
      ],
    });

    const owner = await getCloneAlertOwner('clone_meduzza_barbearia_q23psc');

    expect(owner?.phone).toBe('5531999998842');
    expect(owner?.enabled).toBe(true);
  });
});

describe('getCloneDisconnectAlertTarget — destino + nome do negócio (auto-aviso de desconexão)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('retorna phone (mesma precedência) + nome do negócio da personalizacao', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: '5535999991234',
          cliente_telefone: '5511888887777',
          alert_owner_enabled: true,
          nome_negocio: 'Seven 7 Barber',
        },
      ],
    });

    const target = await getCloneDisconnectAlertTarget('clone_seven_7');

    // Lê personalizacao->>'nome_negocio' (selecionado como nome_negocio).
    const [sql] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`personalizacao->>'nome_negocio'`);
    expect(target).toEqual({
      phone: '5535999991234',
      enabled: true,
      nomeNegocio: 'Seven 7 Barber',
    });
  });

  it('FALLBACK do telefone: alert_owner_phone NULL -> cliente_telefone (clone sem backfill)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: null,
          cliente_telefone: '+55 (35) 98888-7777',
          alert_owner_enabled: true,
          nome_negocio: null,
        },
      ],
    });

    const target = await getCloneDisconnectAlertTarget('clone_novo');

    expect(target?.phone).toBe('5535988887777');
    // Sem nome do negócio -> null (o chamador cai no fallback "seu atendimento").
    expect(target?.nomeNegocio).toBeNull();
  });

  it('opt-out: alert_owner_enabled=false -> enabled=false (chamador não avisa)', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          alert_owner_phone: '5535999991234',
          cliente_telefone: null,
          alert_owner_enabled: false,
          nome_negocio: 'Clone de teste',
        },
      ],
    });

    const target = await getCloneDisconnectAlertTarget('clone_teste');

    expect(target?.enabled).toBe(false);
  });

  it('slot inexistente -> null', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const target = await getCloneDisconnectAlertTarget('clone_nao_existe');

    expect(target).toBeNull();
  });
});
