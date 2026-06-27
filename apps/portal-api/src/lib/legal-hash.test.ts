/**
 * Testes do fingerprint de prova de aceite (SCRUM-31).
 *
 * Cobre: determinismo, sha256 conhecido, sensibilidade à VERSÃO (hash muda no bump mesmo
 * com texto idêntico), anti-colisão por fronteira de bloco, e pin (golden) dos hashes v1
 * server-authoritative (legal-version.ts) — qualquer alteração silenciosa das constantes
 * quebra o teste, forçando bump consciente de versão.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type LegalDocLike,
  canonicalizeLegalDoc,
  computeLegalDocHash,
  sha256Hex,
} from './legal-hash.js';
import { PRIVACY_HASH, TERMS_HASH } from './legal-version.js';

const baseDoc: LegalDocLike = {
  slug: 'termos',
  title: 'Termos',
  version: 'v1',
  updatedAt: '26/06/2026',
  intro: [{ kind: 'p', text: 'Olá' }],
  sections: [
    {
      heading: '1. Início',
      blocks: [
        { kind: 'p', text: 'Parágrafo' },
        { kind: 'ul', items: ['a', 'b'] },
        { kind: 'table', columns: ['C1', 'C2'], rows: [['x', 'y']] },
        { kind: 'callout', text: 'Atenção' },
      ],
    },
  ],
};

describe('sha256Hex', () => {
  it('bate com o sha256 hex de referência', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('canonicalizeLegalDoc + computeLegalDocHash', () => {
  it('é determinístico (mesmo doc -> mesma string/hash)', () => {
    expect(canonicalizeLegalDoc(baseDoc)).toBe(canonicalizeLegalDoc(structuredClone(baseDoc)));
    expect(computeLegalDocHash(baseDoc)).toBe(computeLegalDocHash(structuredClone(baseDoc)));
  });

  it('inclui a VERSÃO: bump muda o hash mesmo com texto idêntico', () => {
    const v2 = { ...baseDoc, version: 'v2' };
    expect(canonicalizeLegalDoc(v2)).toContain('version=v2');
    expect(computeLegalDocHash(v2)).not.toBe(computeLegalDocHash(baseDoc));
  });

  it('o hash é o sha256 da string canônica', () => {
    const canon = canonicalizeLegalDoc(baseDoc);
    expect(computeLegalDocHash(baseDoc)).toBe(
      createHash('sha256').update(canon, 'utf8').digest('hex'),
    );
  });

  it('mudar qualquer texto renderável muda o hash', () => {
    const edited = structuredClone(baseDoc);
    edited.sections[0].blocks[0] = { kind: 'p', text: 'Parágrafo EDITADO' };
    expect(computeLegalDocHash(edited)).not.toBe(computeLegalDocHash(baseDoc));
  });

  it('escapa separadores: blocos diferentes não colidem por concatenação', () => {
    const a: LegalDocLike = {
      ...baseDoc,
      sections: [{ heading: 'h', blocks: [{ kind: 'p', text: 'a|b' }] }],
    };
    const b: LegalDocLike = {
      ...baseDoc,
      sections: [{ heading: 'h', blocks: [{ kind: 'ul', items: ['a', 'b'] }] }],
    };
    expect(computeLegalDocHash(a)).not.toBe(computeLegalDocHash(b));
  });
});

describe('hashes v1 server-authoritative (golden — pino contra alteração silenciosa)', () => {
  it('TERMS_HASH/PRIVACY_HASH são sha256 hex de 64 chars', () => {
    expect(TERMS_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(PRIVACY_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('TERMS_HASH e PRIVACY_HASH são distintos e batem com o v1 publicado', () => {
    expect(TERMS_HASH).not.toBe(PRIVACY_HASH);
    // Golden: derivados do conteúdo v1 de portal-web/src/lib/legal.ts via canonicalizeLegalDoc.
    // Se o texto legal mudar, RECOMPUTE e BUMPE a versão (ver legal-version.ts).
    expect(TERMS_HASH).toBe('214f5c8e5230edd9a9b483458ec03ce851ae49b24bb1ce57fc5e414f0db9a7bd');
    expect(PRIVACY_HASH).toBe('63e04f55b713f5c422ec22df3a5cf7aba14f08368d21e9e9fade86ea33eb4d8d');
  });
});
