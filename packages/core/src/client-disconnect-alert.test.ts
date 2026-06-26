/**
 * Testes da copy PURA do auto-aviso de desconexão (renderClientDisconnectMessage).
 */
import { describe, expect, it } from 'vitest';
import {
  CLIENT_DISCONNECT_NEGOCIO_FALLBACK,
  DEFAULT_CLIENT_DISCONNECT_COPY,
  renderClientDisconnectMessage,
} from './client-disconnect-alert.js';

describe('renderClientDisconnectMessage', () => {
  it('substitui {NOME_NEGOCIO} pelo nome do negócio do cliente', () => {
    const out = renderClientDisconnectMessage({ nomeNegocio: 'Seven 7 Barber' });
    expect(out).toContain('Seven 7 Barber');
    expect(out).not.toContain('{NOME_NEGOCIO}');
    // Mantém os elementos-chave da copy (negrito Startap, portal, dica anti-queda).
    expect(out).toContain('*Startap*');
    expect(out).toContain('app.startap.tech');
    expect(out).toContain('QR Code');
  });

  it('cai no fallback genérico quando o nome do negócio é vazio/nulo', () => {
    expect(renderClientDisconnectMessage({ nomeNegocio: null })).toContain(
      CLIENT_DISCONNECT_NEGOCIO_FALLBACK,
    );
    expect(renderClientDisconnectMessage({ nomeNegocio: '   ' })).toContain(
      CLIENT_DISCONNECT_NEGOCIO_FALLBACK,
    );
    expect(renderClientDisconnectMessage({})).toContain(CLIENT_DISCONNECT_NEGOCIO_FALLBACK);
  });

  it('aceita override de copy (futuro: por clone) e ainda substitui a var', () => {
    const out = renderClientDisconnectMessage({
      nomeNegocio: 'Barbearia X',
      copy: 'Oi! O atendimento da {NOME_NEGOCIO} caiu.',
    });
    expect(out).toBe('Oi! O atendimento da Barbearia X caiu.');
  });

  it('a copy default não deixa placeholder cru e tem o passo-a-passo numerado', () => {
    expect(DEFAULT_CLIENT_DISCONNECT_COPY).toContain('{NOME_NEGOCIO}');
    const rendered = renderClientDisconnectMessage({ nomeNegocio: 'Z' });
    expect(rendered).toContain('1️⃣');
    expect(rendered).toContain('2️⃣');
    expect(rendered).toContain('3️⃣');
  });
});
