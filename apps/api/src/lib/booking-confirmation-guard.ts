/**
 * ADR 0046 — confirmação de agenda server-first.
 *
 * A LLM só propõe dados estruturados; este módulo cria o cartão e confirma a escrita
 * terminalmente. Não recebe nem persiste texto livre, nome, telefone ou summary.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { buildEventSummary, normalizeClientePhone } from '@startap/core/agenda-summary';
import {
  type BookingConfirmationProposal,
  type CloneConfirmationCardContract,
  bookingConfirmations,
} from '@startap/db';
import type { GoogleCalendarClient } from '@startap/integrations/google-calendar';
import { type CartaoConfig, buildCartaoExemplo } from '@startap/integrations/prompt-builder';
import {
  renderConfirmationCardContract,
  validateConfirmationCardContract,
} from './booking-confirmation-template.js';

export const BOOKING_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

type BookingGuardScopeFailure = {
  enabled: false;
  reason: 'slot_off' | 'tenant_unresolved' | 'pepper_missing';
};

/**
 * Identidade criptográfica do contato. Independe do renderer para que uma proposta
 * persistida não volte ao fluxo legado se uma configuração de cartão ficar inválida.
 */
export type BookingGuardScope = { enabled: true; contactHmac: string } | BookingGuardScopeFailure;

export type BookingGuardEligibility =
  | { enabled: true; contactHmac: string }
  | BookingGuardScopeFailure
  | { enabled: false; reason: 'baked_not_renderable' | 'baked_contract_invalid' };

export function isBookingGuardSlotAllowed(slot: string, allowedSlots: string | undefined): boolean {
  const slots = (allowedSlots ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return slots.includes(slot) || slots.includes('*');
}

export function resolveBookingGuardScope(input: {
  slot: string;
  tenantId: string | null;
  telefone: string;
  allowedSlots: string | undefined;
  pepper: string | undefined;
}): BookingGuardScope {
  if (!isBookingGuardSlotAllowed(input.slot, input.allowedSlots))
    return { enabled: false, reason: 'slot_off' };
  if (!input.tenantId) return { enabled: false, reason: 'tenant_unresolved' };
  if (!input.pepper || input.pepper.length < 16)
    return { enabled: false, reason: 'pepper_missing' };
  const normalized = normalizeClientePhone(input.telefone);
  if (!normalized.ok) return { enabled: false, reason: 'pepper_missing' };
  return {
    enabled: true,
    contactHmac: createHmac('sha256', input.pepper)
      .update(`${input.tenantId}\0${input.slot}\0${normalized.digits}`, 'utf8')
      .digest('hex'),
  };
}

export function resolveBookingGuardEligibility(input: {
  slot: string;
  tenantId: string | null;
  telefone: string;
  allowedSlots: string | undefined;
  pepper: string | undefined;
  /** Runtime é canônico; baked só entra com contrato explícito e hash pré-condicionado. */
  cartaoMode: 'baked' | 'runtime';
  bakedContract: CloneConfirmationCardContract | null;
  bakedCardSha256: string;
}): BookingGuardEligibility {
  const scope = resolveBookingGuardScope(input);
  if (!scope.enabled) return scope;
  if (input.cartaoMode === 'baked') {
    if (
      !validateConfirmationCardContract({
        contract: input.bakedContract,
        bakedCardSha256: input.bakedCardSha256,
      }).valid
    ) {
      return { enabled: false, reason: 'baked_contract_invalid' };
    }
  } else if (input.cartaoMode !== 'runtime') {
    return { enabled: false, reason: 'baked_not_renderable' };
  }
  return scope;
}

export function isExactConfirmation(texto: string): boolean {
  return texto.trim().toLocaleUpperCase('pt-BR') === 'SIM';
}

export function renderBookingCard(input: {
  mode: 'agenda' | 'estabelecimento';
  area: string | null;
  cartaoConfig: CartaoConfig | null;
  bakedContract: CloneConfirmationCardContract | null;
  bakedCardSha256: string;
  nomeNegocio: string | null;
  inicioAt: string;
  timezone: string;
  servico: string;
  valorCents: number;
  profissional: string | null;
}): string | null {
  const start = new Date(input.inicioAt);
  const dia = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: input.timezone,
  }).format(start);
  const horario = new Intl.DateTimeFormat('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: input.timezone,
  }).format(start);
  const canonicalFields = {
    dia,
    horario,
    servico: input.servico,
    valor: new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(
      input.valorCents / 100,
    ),
    profissional: input.profissional ?? '',
  };
  if (input.bakedContract) {
    return renderConfirmationCardContract({
      contract: input.bakedContract,
      bakedCardSha256: input.bakedCardSha256,
      fields: canonicalFields,
    });
  }
  return buildCartaoExemplo({
    modo: input.mode,
    area: input.area,
    config: input.cartaoConfig,
    sample: {
      nomeNegocio: input.nomeNegocio ?? undefined,
      ...canonicalFields,
    },
  });
}

export async function persistProposal(input: {
  tenantId: string;
  slot: string;
  contactHmac: string;
  colaboradorId: number | null;
  servico: string;
  inicioAt: string;
  fimAt: string;
  timezone: string;
  usaPacote: boolean | null;
  now?: Date;
}): Promise<BookingConfirmationProposal> {
  const id = randomUUID();
  const eventId = `stbk${id.replace(/-/g, '')}`;
  const now = input.now ?? new Date();
  return bookingConfirmations.replacePending({
    id,
    tenantId: input.tenantId,
    slot: input.slot,
    contactHmac: input.contactHmac,
    colaboradorId: input.colaboradorId,
    servico: input.servico,
    inicioAt: input.inicioAt,
    fimAt: input.fimAt,
    timezone: input.timezone,
    usaPacote: input.usaPacote,
    eventId,
    expiresAt: new Date(now.getTime() + BOOKING_CONFIRMATION_TTL_MS).toISOString(),
  });
}

type ConfirmationOutcome =
  | { kind: 'booked'; proposal: BookingConfirmationProposal; eventId: string }
  | { kind: 'conflict'; proposal: BookingConfirmationProposal }
  | { kind: 'expired' }
  | { kind: 'recovery_required' }
  | { kind: 'none' };

function overlaps(
  events: Awaited<ReturnType<GoogleCalendarClient['listEvents']>>,
  proposal: BookingConfirmationProposal,
): boolean {
  const start = new Date(proposal.inicio_at).getTime();
  const end = new Date(proposal.fim_at).getTime();
  return events.some((event) => {
    const eventStart = new Date(
      event.start.dateTime ?? event.start.date ?? proposal.inicio_at,
    ).getTime();
    const eventEnd = new Date(event.end.dateTime ?? event.end.date ?? proposal.fim_at).getTime();
    return eventStart < end && eventEnd > start;
  });
}

/** Um GET de recovery só comprova o evento que este proposal criou. */
function isOwnedEvent(
  event: Awaited<ReturnType<GoogleCalendarClient['getEvent']>>,
  proposal: BookingConfirmationProposal,
): boolean {
  return (
    event.id === proposal.event_id &&
    event.extendedProperties?.private?.kind === 'booking_confirmation' &&
    event.extendedProperties.private.proposal_id === proposal.id
  );
}

/**
 * Claim persistido precede GCal. Em timeout/409 a única recovery é GET pelo id
 * determinístico; não há segundo POST sobre estado ambíguo.
 */
export async function confirmPendingProposal(input: {
  tenantId: string;
  slot: string;
  contactHmac: string;
  /** Resolve sempre pelo proposal reivindicado, nunca pela última proposta do contato. */
  resolveCalClient: (
    proposal: BookingConfirmationProposal,
  ) =>
    | Pick<GoogleCalendarClient, 'listEvents' | 'createEvent' | 'getEvent'>
    | null
    | Promise<Pick<GoogleCalendarClient, 'listEvents' | 'createEvent' | 'getEvent'> | null>;
  nomeCliente: string;
  telefone: string;
  /** Revalida serviço, duração, horário e colaborador na configuração vigente. */
  validateProposal?: (proposal: BookingConfirmationProposal) => Promise<boolean> | boolean;
  afterBooked?: (proposal: BookingConfirmationProposal, eventId: string) => Promise<void>;
}): Promise<ConfirmationOutcome> {
  await bookingConfirmations.expirePending(input);
  const proposal = await bookingConfirmations.claimForConfirmation(input);
  if (!proposal) {
    const latest = await bookingConfirmations.latestForContact(input);
    if (!latest) return { kind: 'none' };
    if (latest.status === 'booked')
      return { kind: 'booked', proposal: latest, eventId: latest.event_id };
    if (latest.status === 'expired') return { kind: 'expired' };
    if (latest.status === 'confirming' || latest.status === 'recovery_required') {
      try {
        const calClient = await input.resolveCalClient(latest);
        if (!calClient) return { kind: 'recovery_required' };
        const event = await calClient.getEvent(latest.event_id);
        if (!isOwnedEvent(event, latest)) return { kind: 'recovery_required' };
        await bookingConfirmations.markBooked({
          tenantId: input.tenantId,
          slot: input.slot,
          id: latest.id,
        });
        return { kind: 'booked', proposal: latest, eventId: latest.event_id };
      } catch {
        return { kind: 'recovery_required' };
      }
    }
    return { kind: 'none' };
  }

  if (!((await input.validateProposal?.(proposal)) ?? true)) {
    await bookingConfirmations.markConflict({
      tenantId: input.tenantId,
      slot: input.slot,
      id: proposal.id,
    });
    return { kind: 'conflict', proposal };
  }

  const calClient = await input.resolveCalClient(proposal);
  if (!calClient) {
    await bookingConfirmations.markConflict({
      tenantId: input.tenantId,
      slot: input.slot,
      id: proposal.id,
    });
    return { kind: 'conflict', proposal };
  }

  const existing = await calClient.listEvents({
    timeMin: proposal.inicio_at,
    timeMax: proposal.fim_at,
  });
  if (overlaps(existing, proposal)) {
    await bookingConfirmations.markConflict({
      tenantId: input.tenantId,
      slot: input.slot,
      id: proposal.id,
    });
    return { kind: 'conflict', proposal };
  }

  const normalizedPhone = normalizeClientePhone(input.telefone);
  const summary = buildEventSummary({
    nome: input.nomeCliente || 'Cliente',
    servico: proposal.servico,
    ...(normalizedPhone.ok ? { telefoneDigits: normalizedPhone.digits } : {}),
  });
  try {
    const event = await calClient.createEvent({
      eventId: proposal.event_id,
      summary,
      startISO: proposal.inicio_at,
      endISO: proposal.fim_at,
      timeZone: proposal.timezone,
      extendedPropertiesPrivate: { kind: 'booking_confirmation', proposal_id: proposal.id },
    });
    if (event.id !== proposal.event_id) {
      await bookingConfirmations.markRecoveryRequired({
        tenantId: input.tenantId,
        slot: input.slot,
        id: proposal.id,
      });
      return { kind: 'recovery_required' };
    }
  } catch {
    try {
      const event = await calClient.getEvent(proposal.event_id);
      if (!isOwnedEvent(event, proposal)) throw new Error('gcal_event_ownership_mismatch');
    } catch {
      await bookingConfirmations.markRecoveryRequired({
        tenantId: input.tenantId,
        slot: input.slot,
        id: proposal.id,
      });
      return { kind: 'recovery_required' };
    }
  }
  await bookingConfirmations.markBooked({
    tenantId: input.tenantId,
    slot: input.slot,
    id: proposal.id,
  });
  await input.afterBooked?.(proposal, proposal.event_id);
  return { kind: 'booked', proposal, eventId: proposal.event_id };
}
