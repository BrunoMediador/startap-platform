import { describe, expect, it } from 'vitest';
import { getOverlayPortalTarget } from './overlay-portal';

describe('getOverlayPortalTarget', () => {
  it('portala pro document.body quando há document (client)', () => {
    const body = { tagName: 'BODY' } as unknown as HTMLElement;
    const doc = { body } as unknown as Document;
    // Garante que o Overlay teleporta pro <body> — fora de qualquer ancestral
    // transformado (.stagger) que cortaria o sheet com a página rolada.
    expect(getOverlayPortalTarget(doc)).toBe(body);
  });

  it('retorna null sem document (SSR/node) — componente não portala', () => {
    expect(getOverlayPortalTarget(undefined)).toBeNull();
  });

  it('retorna null se document existir mas sem body', () => {
    const doc = { body: null } as unknown as Document;
    expect(getOverlayPortalTarget(doc)).toBeNull();
  });
});
