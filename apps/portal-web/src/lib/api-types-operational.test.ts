import { describe, expect, it } from 'vitest';
import type {
  BotResumeResponse,
  ConexaoResponse,
  OperationalState,
  StatusConexaoResponse,
  StatusResponse,
} from './api-types';

const operational = {
  waha: { state: 'working' },
  atendimento: { configured: true, processing: true, responding: false },
  owner_pause: { active: true },
  billing: { blocking: false, dias_restantes: 8 },
  startap_suspension: { active: false, kind: null },
  effective: 'paused_by_owner',
  actions: { resume_owner: { allowed: true, denied_reason: null } },
} satisfies OperationalState;

describe('api-types — operational_state aditivo e ponta a ponta', () => {
  it('tipa o mesmo snapshot em status, conexão, poll e resume', () => {
    const status = {
      slot: 'slot-a',
      display_name: 'Negócio',
      flow_enabled: false,
      suspended_kind: 'owner_request',
      waha: { session: 'sessao-a', status: 'WORKING' },
      pausas_ativas: 0,
      billing: null,
      operational_state: operational,
    } satisfies StatusResponse;
    const conexao = {
      enabled: true,
      session: 'sessao-a',
      status: 'WORKING',
      connected: true,
      needs_action: false,
      has_registered_phone: true,
      registered_phone_masked: '55 11 9••••-1234',
      can_reconnect: false,
      reconnect_cooldown_seconds: 0,
      bot_paused: true,
      pause_self: true,
      pause_locked: false,
      operational_state: operational,
    } satisfies ConexaoResponse;
    const poll = {
      status: 'WORKING',
      connected: true,
      terminal: true,
      operational_state: operational,
    } satisfies StatusConexaoResponse;
    const resume = {
      bot_paused: true,
      operational_state: operational,
    } satisfies BotResumeResponse;

    expect(status.operational_state).toBe(operational);
    expect(conexao.operational_state).toBe(operational);
    expect(poll.operational_state).toBe(operational);
    expect(resume.operational_state).toBe(operational);
  });

  it('mantém respostas antigas válidas durante rollout', () => {
    const oldResume = { bot_paused: false } satisfies BotResumeResponse;
    expect(oldResume.bot_paused).toBe(false);
  });
});
