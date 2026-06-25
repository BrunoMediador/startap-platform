import { describe, expect, it } from 'vitest';
import type { ConexaoResponse } from './api-types';
import {
  MSG_SUSPENSAO_STARTAP,
  type PausaSnapshot,
  applyPausaToConexao,
  isAtendimentoLigado,
  isPausaFeatureOff,
  isPausaTravada,
  resolvePausaEstado,
} from './bot-pausa';

// Helpers pra montar os 3 estados (+ feature off) do contrato.
function snap(over: Partial<PausaSnapshot> = {}): PausaSnapshot {
  return { ...over };
}

const ATIVO: PausaSnapshot = { bot_paused: false, pause_self: false, pause_locked: false };
const PAUSADO_SELF: PausaSnapshot = { bot_paused: true, pause_self: true, pause_locked: false };
const PAUSADO_STARTAP: PausaSnapshot = { bot_paused: true, pause_self: false, pause_locked: true };

describe('isPausaFeatureOff', () => {
  it('flag OFF: bot_paused ausente (undefined) => esconde o card', () => {
    expect(isPausaFeatureOff(snap())).toBe(true);
    expect(isPausaFeatureOff(snap({ pause_self: false }))).toBe(true);
  });

  it('flag ON: bot_paused booleano (mesmo false) => card aparece', () => {
    expect(isPausaFeatureOff(ATIVO)).toBe(false);
    expect(isPausaFeatureOff(PAUSADO_SELF)).toBe(false);
    expect(isPausaFeatureOff(PAUSADO_STARTAP)).toBe(false);
  });
});

describe('resolvePausaEstado — 3 estados do contrato', () => {
  it('ATIVO: !bot_paused', () => {
    expect(resolvePausaEstado(ATIVO)).toBe('ativo');
  });

  it('PAUSADO POR VOCE: bot_paused && pause_self', () => {
    expect(resolvePausaEstado(PAUSADO_SELF)).toBe('pausado_self');
  });

  it('PAUSADO PELA STARTAP: bot_paused && pause_locked', () => {
    expect(resolvePausaEstado(PAUSADO_STARTAP)).toBe('pausado_startap');
  });

  it('pause_locked tem prioridade sobre pause_self (nunca vira "retomar")', () => {
    // Estado defensivo: se vier ambos true, NAO oferece retomar ao cliente.
    expect(resolvePausaEstado({ bot_paused: true, pause_self: true, pause_locked: true })).toBe(
      'pausado_startap',
    );
  });

  it('pausado sem self nem locked => conservador: travado pela Startap', () => {
    expect(resolvePausaEstado({ bot_paused: true, pause_self: false, pause_locked: false })).toBe(
      'pausado_startap',
    );
  });
});

describe('isAtendimentoLigado — toggle ON apenas no ATIVO', () => {
  it('ON no estado ativo', () => {
    expect(isAtendimentoLigado(resolvePausaEstado(ATIVO))).toBe(true);
  });

  it('OFF quando pausado (por voce ou pela Startap)', () => {
    expect(isAtendimentoLigado(resolvePausaEstado(PAUSADO_SELF))).toBe(false);
    expect(isAtendimentoLigado(resolvePausaEstado(PAUSADO_STARTAP))).toBe(false);
  });
});

describe('isPausaTravada — so a pausa da Startap trava o toggle', () => {
  it('travada SO no estado pausado_startap', () => {
    expect(isPausaTravada(resolvePausaEstado(ATIVO))).toBe(false);
    expect(isPausaTravada(resolvePausaEstado(PAUSADO_SELF))).toBe(false);
    expect(isPausaTravada(resolvePausaEstado(PAUSADO_STARTAP))).toBe(true);
  });
});

describe('applyPausaToConexao — update otimista', () => {
  const base: ConexaoResponse = {
    enabled: true,
    session: 'sess',
    status: 'WORKING',
    connected: true,
    needs_action: false,
    has_registered_phone: true,
    registered_phone_masked: '55 11 9••••-1234',
    can_reconnect: true,
    reconnect_cooldown_seconds: 30,
    bot_paused: false,
    pause_self: false,
    pause_locked: false,
  };

  it('pause: bot_paused/pause_self true, locked false, resto intacto', () => {
    const next = applyPausaToConexao(base, true);
    expect(next.bot_paused).toBe(true);
    expect(next.pause_self).toBe(true);
    expect(next.pause_locked).toBe(false);
    // NAO mexe no eixo de conexao WAHA.
    expect(next.connected).toBe(true);
    expect(next.status).toBe('WORKING');
  });

  it('resume: bot_paused/pause_self false', () => {
    const next = applyPausaToConexao({ ...base, bot_paused: true, pause_self: true }, false);
    expect(next.bot_paused).toBe(false);
    expect(next.pause_self).toBe(false);
    expect(next.pause_locked).toBe(false);
  });

  it('resolvePausaEstado casa com o estado aplicado (round-trip)', () => {
    expect(resolvePausaEstado(applyPausaToConexao(base, true))).toBe('pausado_self');
    expect(resolvePausaEstado(applyPausaToConexao(base, false))).toBe('ativo');
  });
});

describe('MSG_SUSPENSAO_STARTAP — copy do 409', () => {
  it('menciona suporte sem expor o motivo cru', () => {
    expect(MSG_SUSPENSAO_STARTAP).toContain('suporte');
    expect(MSG_SUSPENSAO_STARTAP).not.toContain('billing');
    expect(MSG_SUSPENSAO_STARTAP).not.toContain('manual_other');
    expect(MSG_SUSPENSAO_STARTAP).not.toContain('abuse');
  });
});
