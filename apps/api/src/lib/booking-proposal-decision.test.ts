import { describe, expect, it, vi } from 'vitest';
import type { RunAgentConfiguredOpts } from './run-agent.js';

vi.mock('./run-agent.js', () => ({ runAgentConfigured: vi.fn() }));

const { BOOKING_PROPOSAL_DECISION_TOOL, decideBookingProposal } = await import(
  './booking-proposal-decision.js'
);

function input(userMessage: string) {
  return {
    slot: 'clone_estab_x',
    projectId: 'clone_estab_x',
    flowId: 'flow-test',
    telefone: '5511988887777',
    history: [],
    userMessage,
  };
}

function runnerCallingDecision(args: unknown) {
  return async (opts: RunAgentConfiguredOpts) => {
    expect(opts.temperature).toBe(0);
    expect(opts.maxTurns).toBe(1);
    expect(opts.toolChoice).toEqual({ forceFunction: BOOKING_PROPOSAL_DECISION_TOOL });
    expect(opts.tools).toHaveLength(1);
    expect(opts.tools?.[0]?.name).toBe(BOOKING_PROPOSAL_DECISION_TOOL);
    await opts.tools?.[0]?.run(args);
    return { toolCalls: [] };
  };
}

describe('decideBookingProposal', () => {
  it('aceita intenção inequívoca com serviço, profissional e horário', async () => {
    const result = await decideBookingProposal(
      input('Quero corte com João amanhã às 10h'),
      runnerCallingDecision({ decisao: 'pronta_para_proposta' }),
    );

    expect(result).toEqual({
      decision: { decisao: 'pronta_para_proposta' },
      toolResult: 'accepted',
    });
  });

  it('coleta dados quando há horário, mas falta profissional', async () => {
    const result = await decideBookingProposal(
      input('Quero corte amanhã às 10h'),
      runnerCallingDecision({
        decisao: 'coletar_dados',
        campos_faltantes: ['profissional'],
      }),
    );

    expect(result.decision).toEqual({
      decisao: 'coletar_dados',
      campos_faltantes: ['profissional'],
    });
    expect(result.toolResult).toBe('accepted');
  });

  it.each([
    ['pedido ambíguo', 'Quero um horário amanhã'],
    ['saudação', 'Oi, tudo bem?'],
  ])('coleta dados para %s', async (_label, message) => {
    const result = await decideBookingProposal(
      input(message),
      runnerCallingDecision({
        decisao: 'coletar_dados',
        campos_faltantes: ['servico', 'profissional', 'horario'],
      }),
    );

    expect(result.decision.decisao).toBe('coletar_dados');
    expect(result.toolResult).toBe('accepted');
  });

  it('fecha para coleta quando a tool recebe argumentos inválidos', async () => {
    const result = await decideBookingProposal(
      input('Quero corte com João amanhã às 10h'),
      runnerCallingDecision({ decisao: 'pronta_para_proposta', campos_faltantes: [] }),
    );

    expect(result).toEqual({
      decision: {
        decisao: 'coletar_dados',
        campos_faltantes: ['servico', 'profissional', 'horario'],
      },
      toolResult: 'invalid_arguments',
    });
  });

  it('fecha para coleta se o provedor não chama a tool forçada', async () => {
    const result = await decideBookingProposal(
      input('Quero corte com João amanhã às 10h'),
      async () => ({
        toolCalls: [],
      }),
    );

    expect(result.toolResult).toBe('tool_not_called');
    expect(result.decision.decisao).toBe('coletar_dados');
  });
});
