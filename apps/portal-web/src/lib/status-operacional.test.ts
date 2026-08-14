import { describe, expect, it } from 'vitest';
import type {
  EffectiveOperationalState,
  OperationalState,
  StartapSuspensionKind,
  StatusResponse,
  WahaOperationalState,
} from './api-types';
import { resolveStatusHeroView } from './status-operacional';

function operational({
  waha = 'working',
  processing = true,
  responding = true,
  owner = false,
  billing = false,
  startap = null,
  effective = 'working',
  allowed = true,
}: {
  waha?: WahaOperationalState;
  processing?: boolean;
  responding?: boolean;
  owner?: boolean;
  billing?: boolean;
  startap?: StartapSuspensionKind | null;
  effective?: EffectiveOperationalState;
  allowed?: boolean;
} = {}): OperationalState {
  return {
    waha: { state: waha },
    atendimento: { configured: true, processing, responding },
    owner_pause: { active: owner },
    billing: { blocking: billing, dias_restantes: billing ? -1 : 8 },
    startap_suspension: { active: startap != null, kind: startap },
    effective,
    actions: {
      resume_owner: {
        allowed,
        denied_reason: allowed
          ? null
          : billing
            ? 'billing_overdue'
            : startap === 'abuse'
              ? 'startap_abuse'
              : 'startap_manual_other',
      },
    },
  };
}

function status(op?: OperationalState): StatusResponse {
  return {
    slot: 'slot-a',
    display_name: 'Negócio',
    flow_enabled: true,
    suspended_kind: null,
    waha: { session: 'sessao-a', status: 'WORKING' },
    pausas_ativas: 0,
    billing: { next_due_date: '2026-08-30', dias_restantes: 17, status: 'active' },
    operational_state: op,
  };
}

describe('resolveStatusHeroView — estado composto autoritativo', () => {
  it('só declara ativo quando efetivo WORKING e atendimento realmente responde', () => {
    const active = resolveStatusHeroView(status(operational()));
    expect(active.kind).toBe('active');
    expect(active.trulyActive).toBe(true);

    const notResponding = resolveStatusHeroView(
      status(operational({ responding: false, effective: 'working' })),
    );
    expect(notResponding.kind).toBe('unknown');
    expect(notResponding.trulyActive).toBe(false);
  });

  it('billing blocking vence flow_enabled legado e nunca aparece ativo', () => {
    const view = resolveStatusHeroView(
      status(
        operational({
          billing: true,
          processing: false,
          responding: false,
          effective: 'blocked_billing',
          allowed: false,
        }),
      ),
    );
    expect(view.kind).toBe('billing_block');
    expect(view.title).toContain('Pagamento pendente');
    expect(view.atendimentoLabel).toBe('Atendimento bloqueado');
    expect(view.trulyActive).toBe(false);
  });

  it('owner + overdue comunica os dois eixos sem apagar a pausa do dono', () => {
    const view = resolveStatusHeroView(
      status(
        operational({
          owner: true,
          billing: true,
          processing: false,
          responding: false,
          effective: 'blocked_billing',
          allowed: false,
        }),
      ),
    );
    expect(view.kind).toBe('billing_block');
    expect(view.ownerPauseAlsoActive).toBe(true);
    expect(view.description).toContain('pausa continua ativa');
  });

  it('owner em dia mostra pausa do dono e só oferece retomar quando permitido', () => {
    const view = resolveStatusHeroView(
      status(
        operational({
          owner: true,
          responding: false,
          effective: 'paused_by_owner',
        }),
      ),
    );
    expect(view.kind).toBe('owner_pause');
    expect(view.href).toBe('/conectar');
    expect(view.atendimentoLabel).toBe('Processando sem responder');
  });

  it.each([
    ['manual_other', 'startap_manual'],
    ['abuse', 'startap_abuse'],
  ] as const)('suspensão Startap %s orienta suporte (%s)', (kind, expected) => {
    const view = resolveStatusHeroView(
      status(
        operational({
          startap: kind,
          processing: false,
          responding: false,
          effective: 'blocked_startap',
          allowed: false,
        }),
      ),
    );
    expect(view.kind).toBe(expected);
    expect(view.description).toContain('suporte');
  });

  it.each([
    ['disconnected', 'waha_disconnected', 'WhatsApp desconectado'],
    ['failed', 'waha_failed', 'Falha no WhatsApp'],
    ['unknown', 'unknown', 'Status do WhatsApp indisponível'],
  ] as const)('WAHA %s fica explícito', (waha, expectedKind, expectedLabel) => {
    const effective = waha === 'unknown' ? 'unknown' : 'disconnected';
    const view = resolveStatusHeroView(
      status(operational({ waha, effective, processing: true, responding: true })),
    );
    expect(view.kind).toBe(expectedKind);
    expect(view.wahaLabel).toBe(expectedLabel);
    expect(view.trulyActive).toBe(false);
  });
});

describe('resolveStatusHeroView — fallback de rollout', () => {
  it('API antiga + WORKING nunca vira ativo por inferência', () => {
    const view = resolveStatusHeroView(status());
    expect(view.kind).toBe('unknown');
    expect(view.trulyActive).toBe(false);
    expect(view.title).toContain('Confirmando');
  });

  it('API antiga ainda distingue FAILED e owner_request explícitos', () => {
    const failedStatus = { ...status(), waha: { session: 's', status: 'FAILED' } };
    expect(resolveStatusHeroView(failedStatus).kind).toBe('waha_failed');

    const ownerStatus = {
      ...status(),
      flow_enabled: false,
      suspended_kind: 'owner_request' as const,
    };
    expect(resolveStatusHeroView(ownerStatus).kind).toBe('owner_pause');
  });
});
