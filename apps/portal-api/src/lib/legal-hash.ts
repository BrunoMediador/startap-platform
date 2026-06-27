/**
 * legal-hash — fingerprint determinístico do conteúdo legal aceito (SCRUM-31 / ADR 0029).
 *
 * POR QUÊ: a prova de aceite (terms_acceptances) já guarda a VERSÃO ('v1'), mas a versão
 * sozinha não prova QUE TEXTO o titular aceitou — se alguém editar o texto de uma versão
 * sem bumpar, a versão não muda. O `sha256(conteúdo canônico + versão)` é uma impressão
 * digital imutável do texto exato: tamper-evidence + verificação independente da prova.
 *
 * SERVER-SIDE / SERVER-AUTHORITATIVE: o hash é SEMPRE computado/definido no servidor a
 * partir do conteúdo canônico — JAMAIS vem do cliente (a request de aceite é ignorada,
 * igual às versões). Estas funções são PURAS e determinísticas (mesmo doc -> mesmo hash).
 *
 * DETERMINISMO: a serialização canônica é estável e não-ambígua entre blocos (prefixo de
 * tipo + separadores escapados), pra que dois conteúdos diferentes NUNCA colidam por
 * concatenação. A VERSÃO entra na string canônica — o hash muda quando a versão muda,
 * mesmo que o texto seja idêntico (requisito: hash do "conteúdo canônico + versão").
 *
 * SEM dependência de markdown/render: opera sobre a estrutura de dados do documento legal
 * (espelha a forma de apps/portal-web/src/lib/legal.ts — LegalDocument/LegalBlock), por
 * isso o tipo aqui é ESTRUTURAL (LegalDocLike), sem import cross-app (decouple do build).
 */
import { createHash } from 'node:crypto';

/** Forma estrutural mínima de um bloco legal (espelha LegalBlock do portal-web). */
export type LegalBlockLike =
  | { kind: 'p'; text: string }
  | { kind: 'sub'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][] }
  | { kind: 'callout'; text: string };

/** Forma estrutural mínima de um documento legal (espelha LegalDocument do portal-web). */
export interface LegalDocLike {
  slug: string;
  title: string;
  version: string;
  updatedAt: string;
  intro: LegalBlockLike[];
  sections: { heading: string; blocks: LegalBlockLike[] }[];
}

// Escapa os separadores estruturais pra que texto contendo '|'/'~'/'\n' não vire fronteira
// de campo (anti-colisão). Ordem importa: a barra invertida primeiro.
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/~/g, '\\~').replace(/\n/g, '\\n');
}

function serializeBlock(b: LegalBlockLike): string {
  switch (b.kind) {
    case 'p':
    case 'sub':
    case 'callout':
      return `${b.kind}:${esc(b.text)}`;
    case 'ul':
      return `ul:${b.items.map(esc).join('|')}`;
    case 'table':
      return `table:cols=${b.columns.map(esc).join('|')};rows=${b.rows
        .map((r) => r.map(esc).join('|'))
        .join('~')}`;
  }
}

/**
 * Serialização canônica e determinística do documento (inclui a VERSÃO). Estável: a saída
 * só muda se o conteúdo renderável OU a versão mudar — refator de layout/render não afeta.
 */
export function canonicalizeLegalDoc(doc: LegalDocLike): string {
  const lines: string[] = [
    `slug=${esc(doc.slug)}`,
    `version=${esc(doc.version)}`,
    `updatedAt=${esc(doc.updatedAt)}`,
    `title=${esc(doc.title)}`,
    `intro=${doc.intro.length}`,
  ];
  for (const b of doc.intro) lines.push(serializeBlock(b));
  for (const s of doc.sections) {
    lines.push(`section=${esc(s.heading)}`);
    lines.push(`blocks=${s.blocks.length}`);
    for (const b of s.blocks) lines.push(serializeBlock(b));
  }
  return lines.join('\n');
}

/** sha256 hex de uma string UTF-8. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hash de prova de um documento legal = sha256(conteúdo canônico + versão). */
export function computeLegalDocHash(doc: LegalDocLike): string {
  return sha256Hex(canonicalizeLegalDoc(doc));
}
