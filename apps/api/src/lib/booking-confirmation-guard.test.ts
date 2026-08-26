import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  replacePending: vi.fn(),
  expirePending: vi.fn(),
  claimForConfirmation: vi.fn(),
  latestForContact: vi.fn(),
  markBooked: vi.fn(),
  markConflict: vi.fn(),
  markRecoveryRequired: vi.fn(),
}));
vi.mock('@startap/db', () => ({ bookingConfirmations: mocks }));

const guard = await import('./booking-confirmation-guard.js');
const scope = { tenantId: 'tenant-a', slot: 'clone-a', contactHmac: 'a'.repeat(64) };
const proposal = {
  id: 'p1',
  tenant_id: 'tenant-a',
  slot: 'clone-a',
  contact_hmac: scope.contactHmac,
  colaborador_id: 1,
  servico: 'Corte',
  inicio_at: '2026-08-27T20:00:00.000Z',
  fim_at: '2026-08-27T20:30:00.000Z',
  timezone: 'America/Sao_Paulo',
  usa_pacote: false,
  event_id: 'stbkp1',
  status: 'confirming',
  expires_at: '2026-08-27T20:15:00.000Z',
  card_sent_at: '2026-08-27T20:00:00.000Z',
  created_at: '2026-08-27T20:00:00.000Z',
  updated_at: '2026-08-27T20:00:00.000Z',
};

beforeEach(() => vi.clearAllMocks());

describe('booking confirmation guard', () => {
  const ownedEvent = {
    id: proposal.event_id,
    extendedProperties: {
      private: { kind: 'booking_confirmation', proposal_id: proposal.id },
    },
  };

  it('fica OFF por slot e falha fechada sem pepper/runtime renderer', () => {
    expect(
      guard.resolveBookingGuardEligibility({
        slot: 'a',
        tenantId: 'tenant-a',
        telefone: '5511999999999',
        allowedSlots: '',
        pepper: '0123456789abcdef',
        cartaoMode: 'runtime',
        bakedContract: null,
        bakedCardSha256: '',
      }),
    ).toEqual({ enabled: false, reason: 'slot_off' });
    expect(
      guard.resolveBookingGuardEligibility({
        slot: 'a',
        tenantId: 'tenant-a',
        telefone: '5511999999999',
        allowedSlots: 'a',
        pepper: undefined,
        cartaoMode: 'runtime',
        bakedContract: null,
        bakedCardSha256: '',
      }),
    ).toEqual({ enabled: false, reason: 'pepper_missing' });
    expect(
      guard.resolveBookingGuardEligibility({
        slot: 'a',
        tenantId: 'tenant-a',
        telefone: '5511999999999',
        allowedSlots: 'a',
        pepper: '0123456789abcdef',
        cartaoMode: 'baked',
        bakedContract: null,
        bakedCardSha256: '',
      }),
    ).toEqual({ enabled: false, reason: 'baked_contract_invalid' });
  });

  it('só considera confirmação o SIM literal; qualquer outro inbound invalida a proposta', () => {
    expect(guard.isExactConfirmation(' SIM ')).toBe(true);
    expect(guard.isExactConfirmation('sim')).toBe(true);
    expect(guard.isExactConfirmation('SIM!')).toBe(false);
    expect(guard.isExactConfirmation('quero confirmar')).toBe(false);
  });

  it('HMAC do contato é isolado por tenant e slot', () => {
    const base = {
      telefone: '5511999999999',
      allowedSlots: '*',
      pepper: '0123456789abcdef',
      cartaoMode: 'runtime' as const,
      bakedContract: null,
      bakedCardSha256: '',
    };
    const tenantA = guard.resolveBookingGuardEligibility({
      ...base,
      tenantId: 'tenant-a',
      slot: 'a',
    });
    const tenantB = guard.resolveBookingGuardEligibility({
      ...base,
      tenantId: 'tenant-b',
      slot: 'a',
    });
    const slotB = guard.resolveBookingGuardEligibility({
      ...base,
      tenantId: 'tenant-a',
      slot: 'b',
    });
    expect(tenantA).toMatchObject({ enabled: true });
    expect(tenantB).toMatchObject({ enabled: true });
    expect(slotB).toMatchObject({ enabled: true });
    if (tenantA.enabled && tenantB.enabled && slotB.enabled) {
      expect(tenantA.contactHmac).not.toBe(tenantB.contactHmac);
      expect(tenantA.contactHmac).not.toBe(slotB.contactHmac);
    }
  });

  it('mantém o escopo HMAC para barrar pending mesmo se o contrato baked ficar inválido', () => {
    const input = {
      slot: 'clone-a',
      tenantId: 'tenant-a',
      telefone: '5511999999999',
      allowedSlots: 'clone-a',
      pepper: '0123456789abcdef',
    };
    const scope = guard.resolveBookingGuardScope(input);
    const eligibility = guard.resolveBookingGuardEligibility({
      ...input,
      cartaoMode: 'baked',
      bakedContract: null,
      bakedCardSha256: '',
    });
    expect(scope).toMatchObject({ enabled: true });
    expect(eligibility).toEqual({ enabled: false, reason: 'baked_contract_invalid' });
  });

  it('golden runtime na área outro permanece canônico e independente do contrato baked', () => {
    const card = guard.renderBookingCard({
      mode: 'estabelecimento',
      area: 'outro',
      cartaoConfig: null,
      bakedContract: null,
      bakedCardSha256: '',
      nomeNegocio: 'Studio',
      inicioAt: proposal.inicio_at,
      timezone: proposal.timezone,
      servico: 'Corte',
      valorCents: 5500,
      profissional: 'Guilherme',
    });
    expect(card).toBe(
      '📅 *Studio*\n\n' +
        '📅 Dia: quinta-feira, 27/08/2026\n' +
        '🕐 Horário: 17:00\n' +
        '📋 Serviço: Corte\n' +
        '💰 Valor: R$ 55,00\n' +
        '👤 Profissional: Guilherme\n\n' +
        '✅ Responda SIM para confirmar.',
    );
  });

  it('double SIM não cria segundo evento: segundo claimant recupera booked', async () => {
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValueOnce(proposal).mockResolvedValueOnce(null);
    mocks.latestForContact.mockResolvedValue({ ...proposal, status: 'booked' });
    mocks.markBooked.mockResolvedValue(true);
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockResolvedValue({ id: proposal.event_id }),
      getEvent: vi.fn(),
    };
    const first = await guard.confirmPendingProposal({
      ...scope,
      resolveCalClient: () => client as never,
      nomeCliente: 'Ana',
      telefone: '5511999999999',
    });
    const second = await guard.confirmPendingProposal({
      ...scope,
      resolveCalClient: () => client as never,
      nomeCliente: 'Ana',
      telefone: '5511999999999',
    });
    expect(first).toMatchObject({ kind: 'booked', delivery: 'claimed' });
    expect(second).toMatchObject({ kind: 'booked', delivery: 'retry' });
    expect(client.createEvent).toHaveBeenCalledTimes(1);
    expect(client.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: proposal.event_id }),
    );
  });

  it('P2 pendente não desloca a agenda escolhida por P1 já reivindicada', async () => {
    const p2 = {
      ...proposal,
      id: 'p2',
      colaborador_id: 2,
      inicio_at: '2026-08-27T21:00:00.000Z',
      fim_at: '2026-08-27T21:30:00.000Z',
      event_id: 'stbkp2',
      status: 'pending',
    };
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValue(proposal);
    // Simula P2 inserida entre o CAS de P1 e a escrita externa. A confirmação não pode
    // ler latestForContact neste caminho, pois P2 pertence a outro colaborador.
    mocks.latestForContact.mockResolvedValue(p2);
    mocks.markBooked.mockResolvedValue(true);
    const p1Client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockResolvedValue({ id: proposal.event_id }),
      getEvent: vi.fn(),
    };
    const p2Client = {
      listEvents: vi.fn(),
      createEvent: vi.fn(),
      getEvent: vi.fn(),
    };
    const resolveCalClient = vi.fn((claimed: { id: string }) =>
      claimed.id === proposal.id ? p1Client : p2Client,
    );

    await expect(
      guard.confirmPendingProposal({
        ...scope,
        resolveCalClient: resolveCalClient as never,
        nomeCliente: 'Ana',
        telefone: '5511999999999',
      }),
    ).resolves.toMatchObject({ kind: 'booked', delivery: 'claimed', eventId: proposal.event_id });

    expect(resolveCalClient).toHaveBeenCalledWith(proposal);
    expect(mocks.latestForContact).not.toHaveBeenCalled();
    expect(p1Client.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: proposal.event_id,
        startISO: proposal.inicio_at,
        endISO: proposal.fim_at,
      }),
    );
    expect(p2Client.createEvent).not.toHaveBeenCalled();
  });

  it('conflito depois do cartão não cria evento e timeout não reposta POST', async () => {
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValue(proposal);
    mocks.markConflict.mockResolvedValue(true);
    const conflictClient = {
      listEvents: vi
        .fn()
        .mockResolvedValue([
          { start: { dateTime: proposal.inicio_at }, end: { dateTime: proposal.fim_at } },
        ]),
      createEvent: vi.fn(),
      getEvent: vi.fn(),
    };
    await expect(
      guard.confirmPendingProposal({
        ...scope,
        resolveCalClient: () => conflictClient as never,
        nomeCliente: 'Ana',
        telefone: '5511999999999',
      }),
    ).resolves.toMatchObject({ kind: 'conflict' });
    expect(conflictClient.createEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP 400', new Error('GCal /events -> HTTP 400: bad request')],
    ['timeout', new Error('__gcal_request_timeout__')],
    ['erro inesperado', new Error('calendar transport closed')],
  ])(
    'falha de pré-checagem %s termina em recovery_required sem POST ou atendimento',
    async (_label, precheckError) => {
      mocks.expirePending.mockResolvedValue(false);
      mocks.claimForConfirmation.mockResolvedValueOnce(proposal);
      mocks.markRecoveryRequired.mockResolvedValueOnce(true);
      const afterBooked = vi.fn();
      const client = {
        listEvents: vi.fn().mockRejectedValue(precheckError),
        createEvent: vi.fn(),
        getEvent: vi.fn(),
      };

      await expect(
        guard.confirmPendingProposal({
          ...scope,
          resolveCalClient: () => client as never,
          nomeCliente: 'Ana',
          telefone: '5511999999999',
          afterBooked,
        }),
      ).resolves.toEqual({ kind: 'recovery_required' });

      expect(mocks.markRecoveryRequired).toHaveBeenCalledWith({
        tenantId: scope.tenantId,
        slot: scope.slot,
        contactHmac: scope.contactHmac,
        id: proposal.id,
      });
      expect(client.createEvent).not.toHaveBeenCalled();
      expect(client.getEvent).not.toHaveBeenCalled();
      expect(afterBooked).not.toHaveBeenCalled();
    },
  );

  it('retry após falha de pré-checagem não cria evento duplicado', async () => {
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValueOnce(proposal).mockResolvedValueOnce(null);
    mocks.latestForContact.mockResolvedValueOnce({ ...proposal, status: 'recovery_required' });
    mocks.markRecoveryRequired.mockResolvedValueOnce(true);
    const client = {
      listEvents: vi.fn().mockRejectedValue(new Error('GCal /events -> HTTP 400: bad request')),
      createEvent: vi.fn(),
      getEvent: vi.fn().mockRejectedValue(new Error('not found')),
    };

    await expect(
      guard.confirmPendingProposal({
        ...scope,
        resolveCalClient: () => client as never,
        nomeCliente: 'Ana',
        telefone: '5511999999999',
      }),
    ).resolves.toEqual({ kind: 'recovery_required' });
    await expect(
      guard.confirmPendingProposal({
        ...scope,
        resolveCalClient: () => client as never,
        nomeCliente: 'Ana',
        telefone: '5511999999999',
      }),
    ).resolves.toEqual({ kind: 'recovery_required' });

    expect(mocks.markRecoveryRequired).toHaveBeenCalledTimes(1);
    expect(client.createEvent).not.toHaveBeenCalled();
    expect(client.getEvent).toHaveBeenCalledWith(proposal.event_id);
  });

  it('mudança de serviço, duração ou colaborador entre card e SIM bloqueia sem evento', async () => {
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValue(proposal);
    mocks.markConflict.mockResolvedValue(true);
    const client = {
      listEvents: vi.fn(),
      createEvent: vi.fn(),
      getEvent: vi.fn(),
    };
    await expect(
      guard.confirmPendingProposal({
        ...scope,
        resolveCalClient: () => client as never,
        nomeCliente: 'Ana',
        telefone: '5511999999999',
        validateProposal: () => false,
      }),
    ).resolves.toMatchObject({ kind: 'conflict' });
    expect(client.listEvents).not.toHaveBeenCalled();
    expect(client.createEvent).not.toHaveBeenCalled();
  });

  it('timeout ambíguo usa GET determinístico e fica recovery_required se não provar evento', async () => {
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValue(proposal);
    mocks.markRecoveryRequired.mockResolvedValue(true);
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockRejectedValue(new Error('timeout')),
      getEvent: vi.fn().mockRejectedValue(new Error('timeout')),
    };
    await expect(
      guard.confirmPendingProposal({
        ...scope,
        resolveCalClient: () => client as never,
        nomeCliente: 'Ana',
        telefone: '5511999999999',
      }),
    ).resolves.toEqual({ kind: 'recovery_required' });
    expect(client.createEvent).toHaveBeenCalledTimes(1);
    expect(client.getEvent).toHaveBeenCalledWith(proposal.event_id);
  });

  it('recovery aceita somente evento determinístico pertencente à proposta', async () => {
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValue(null);
    mocks.latestForContact.mockResolvedValue({ ...proposal, status: 'confirming' });
    mocks.markBooked.mockResolvedValue(true);
    const client = {
      listEvents: vi.fn(),
      createEvent: vi.fn(),
      getEvent: vi.fn().mockResolvedValue(ownedEvent),
    };
    await expect(
      guard.confirmPendingProposal({
        ...scope,
        resolveCalClient: () => client as never,
        nomeCliente: 'Ana',
        telefone: '5511999999999',
      }),
    ).resolves.toMatchObject({ kind: 'booked', delivery: 'claimed', eventId: proposal.event_id });
  });

  it.each([
    ['evento inexistente', () => ({ id: 'outro-evento', extendedProperties: { private: {} } })],
    [
      'evento de outra proposta',
      () => ({
        id: proposal.event_id,
        extendedProperties: {
          private: { kind: 'booking_confirmation', proposal_id: 'outra-proposta' },
        },
      }),
    ],
    ['falha de leitura', () => Promise.reject(new Error('gcal_get_failed'))],
  ])(
    'retry legado confirming sem prova própria (%s) persiste recovery sem efeitos externos',
    async (_scenario, getEventResult) => {
      mocks.expirePending.mockResolvedValue(false);
      mocks.claimForConfirmation.mockResolvedValue(null);
      mocks.latestForContact
        .mockResolvedValueOnce({ ...proposal, status: 'confirming' })
        .mockResolvedValueOnce({ ...proposal, status: 'recovery_required' });
      mocks.markRecoveryRequired.mockResolvedValue(true);
      const client = {
        listEvents: vi.fn(),
        createEvent: vi.fn(),
        getEvent: vi.fn().mockImplementation(getEventResult),
      };

      await expect(
        guard.confirmPendingProposal({
          ...scope,
          resolveCalClient: () => client as never,
          nomeCliente: 'Ana',
          telefone: '5511999999999',
        }),
      ).resolves.toEqual({ kind: 'recovery_required' });
      await expect(
        guard.confirmPendingProposal({
          ...scope,
          resolveCalClient: () => client as never,
          nomeCliente: 'Ana',
          telefone: '5511999999999',
        }),
      ).resolves.toEqual({ kind: 'recovery_required' });

      expect(mocks.markRecoveryRequired).toHaveBeenCalledWith({
        tenantId: scope.tenantId,
        slot: scope.slot,
        contactHmac: scope.contactHmac,
        id: proposal.id,
      });
      expect(mocks.markRecoveryRequired).toHaveBeenCalledTimes(1);
      expect(client.listEvents).not.toHaveBeenCalled();
      expect(client.createEvent).not.toHaveBeenCalled();
    },
  );

  it('SIM de recovery vence antes do commit e o claimant converge recovery_required para booked', async () => {
    mocks.expirePending.mockReset();
    mocks.claimForConfirmation.mockReset();
    mocks.latestForContact.mockReset();
    mocks.markRecoveryRequired.mockReset();
    mocks.markBooked.mockReset();
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValueOnce(proposal).mockResolvedValueOnce(null);
    mocks.latestForContact.mockResolvedValueOnce({ ...proposal, status: 'confirming' });
    mocks.markRecoveryRequired.mockResolvedValueOnce(true);
    mocks.markBooked.mockResolvedValueOnce(true);
    let signalCreateStarted: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      signalCreateStarted = resolve;
    });
    let releaseCreate: (() => void) | undefined;
    const waitForCreate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn(async () => {
        signalCreateStarted?.();
        await waitForCreate;
        return { id: proposal.event_id };
      }),
      getEvent: vi.fn().mockRejectedValue(new Error('gcal_get_failed')),
    };
    const afterBooked = vi.fn(async () => undefined);

    const claimant = guard.confirmPendingProposal({
      ...scope,
      resolveCalClient: () => client as never,
      nomeCliente: 'Ana',
      telefone: '5511999999999',
      afterBooked,
    });
    await createStarted;
    const recovery = await guard.confirmPendingProposal({
      ...scope,
      resolveCalClient: () => client as never,
      nomeCliente: 'Ana',
      telefone: '5511999999999',
      afterBooked,
    });
    releaseCreate?.();

    await expect(claimant).resolves.toMatchObject({
      kind: 'booked',
      delivery: 'claimed',
      eventId: proposal.event_id,
    });
    expect(recovery).toEqual({ kind: 'recovery_required' });
    expect(mocks.markRecoveryRequired).toHaveBeenCalledWith({
      tenantId: scope.tenantId,
      slot: scope.slot,
      contactHmac: scope.contactHmac,
      id: proposal.id,
    });
    expect(mocks.markBooked).toHaveBeenCalledWith({
      tenantId: scope.tenantId,
      slot: scope.slot,
      contactHmac: scope.contactHmac,
      id: proposal.id,
    });
    expect(afterBooked).toHaveBeenCalledTimes(1);
    expect(client.listEvents).toHaveBeenCalledTimes(1);
    expect(client.createEvent).toHaveBeenCalledTimes(1);
  });

  it('recovery com evento próprio vence o CAS e o claimant original não confirma nem duplica atendimento', async () => {
    mocks.expirePending.mockReset();
    mocks.claimForConfirmation.mockReset();
    mocks.latestForContact.mockReset();
    mocks.markBooked.mockReset();
    mocks.expirePending.mockResolvedValue(false);
    mocks.claimForConfirmation.mockResolvedValueOnce(proposal).mockResolvedValueOnce(null);
    mocks.latestForContact
      .mockResolvedValueOnce({ ...proposal, status: 'confirming' })
      .mockResolvedValueOnce({ ...proposal, status: 'booked' });
    mocks.markBooked.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    let startCreate: (() => void) | undefined;
    const createStarted = new Promise<void>((resolve) => {
      startCreate = resolve;
    });
    let releaseCreate: (() => void) | undefined;
    const waitForCreate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const client = {
      listEvents: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn(async () => {
        startCreate?.();
        await waitForCreate;
        return { id: proposal.event_id };
      }),
      getEvent: vi.fn().mockResolvedValue(ownedEvent),
    };
    const afterBooked = vi.fn(async () => undefined);

    const claimant = guard.confirmPendingProposal({
      ...scope,
      resolveCalClient: () => client as never,
      nomeCliente: 'Ana',
      telefone: '5511999999999',
      afterBooked,
    });
    await createStarted;
    const recovery = await guard.confirmPendingProposal({
      ...scope,
      resolveCalClient: () => client as never,
      nomeCliente: 'Ana',
      telefone: '5511999999999',
      afterBooked,
    });
    releaseCreate?.();

    await expect(claimant).resolves.toMatchObject({
      kind: 'booked_observed',
      eventId: proposal.event_id,
    });
    expect(recovery).toMatchObject({
      kind: 'booked',
      delivery: 'claimed',
      eventId: proposal.event_id,
    });
    expect(mocks.markBooked).toHaveBeenCalledTimes(2);
    expect(afterBooked).toHaveBeenCalledTimes(1);
    expect(client.listEvents).toHaveBeenCalledTimes(1);
    expect(client.createEvent).toHaveBeenCalledTimes(1);
  });
});
