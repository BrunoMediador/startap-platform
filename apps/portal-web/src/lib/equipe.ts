/**
 * Validação + normalização do formulário de Equipe (colaboradores), no cliente.
 * Espelha as regras do backend (cloneColaboradores em @startap/db): nome 1..160,
 * serviços trim + dedup case-insensitive (<=80 chars/item, <=50 itens). Dar erro
 * inline ANTES de bater na API. Testável sem React (vive aqui, fora da página).
 *
 * Os serviços são SELECIONADOS por checklist a partir do catálogo EXISTENTE do
 * clone (mesmo modelo do painel de gestão). O draft guarda só os NOMES marcados
 * (string[]); a UI nunca deixa digitar serviço inexistente. Sem marcar = vazio =
 * atende todos (preservado do comportamento antigo).
 */
import type { Colaborador } from './api-types';

export interface Draft {
  nome: string;
  /** Nomes dos serviços MARCADOS (subconjunto do catálogo do clone). [] = todos. */
  servicos: string[];
  ativo: boolean;
  /** % de comissão sobre o bruto, como texto editável (0–100). "" = 0. */
  comissao: string;
}

export interface FieldErrors {
  nome?: string;
  comissao?: string;
}

const NOME_MAX = 160;
const SERVICO_MAX = 80;
const SERVICOS_MAX = 50;
const COMISSAO_MIN = 0;
const COMISSAO_MAX = 100;

/**
 * Normaliza uma lista de serviços marcados: trim + corta em SERVICO_MAX, descarta
 * vazios, dedup case-insensitive, limita a SERVICOS_MAX. Espelha o backend e é a
 * última barreira antes do payload (o catálogo já restringe o que dá pra marcar,
 * mas isto garante a forma do array independente da origem).
 */
export function normalizeServicos(servicos: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of servicos) {
    const s = raw.trim().slice(0, SERVICO_MAX);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= SERVICOS_MAX) break;
  }
  return out;
}

/**
 * Liga/desliga um serviço na seleção (dedup case-insensitive). Usado pelo
 * checklist: tocar num chip alterna a marcação. Mantém a ordem de marcação.
 */
export function toggleServico(servicos: string[], nome: string): string[] {
  const alvo = nome.trim();
  if (!alvo) return servicos;
  const key = alvo.toLowerCase();
  const existe = servicos.some((s) => s.toLowerCase() === key);
  if (existe) return servicos.filter((s) => s.toLowerCase() !== key);
  if (servicos.length >= SERVICOS_MAX) return servicos;
  return [...servicos, alvo];
}

/** Um serviço está marcado no draft? (case-insensitive) */
export function isServicoMarcado(servicos: string[], nome: string): boolean {
  const key = nome.trim().toLowerCase();
  return servicos.some((s) => s.toLowerCase() === key);
}

/**
 * Serviços do colaborador que NÃO existem mais no catálogo do clone (ex.: o dono
 * apagou "Sobrancelha" depois de marcá-la). Continuam selecionáveis no editor
 * (chip "legado") pra não sumir a config silenciosamente — o dono decide se mantém
 * ou desmarca. Compara case-insensitive.
 */
export function servicosOrfaos(selecionados: string[], catalogo: string[]): string[] {
  const noCatalogo = new Set(catalogo.map((s) => s.toLowerCase()));
  return selecionados.filter((s) => !noCatalogo.has(s.trim().toLowerCase()));
}

/** "12,5" / "12.5" / "" -> número 0..100, ou null se inválido. "" vira 0. */
export function parseComissao(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s/g, '').replace('%', '').replace(',', '.');
  if (cleaned === '') return 0;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < COMISSAO_MIN || value > COMISSAO_MAX) return null;
  return value;
}

/** Número de comissão -> texto pro input ("0" vira "" pra não poluir). */
export function comissaoToText(pct: number): string {
  return pct > 0 ? String(pct) : '';
}

/**
 * Normaliza uma linha de colaborador como vem da rede pro tipo Colaborador.
 *
 * Boundary de conversão: `clone_colaboradores.id` é BIGSERIAL e o driver pg
 * serializa BIGINT como STRING ("4") no JSON; `comissao_pct` é NUMERIC e também
 * pode chegar como string. Sem este map, o `id` string quebra DOIS fluxos no
 * portal:
 *   1. Editar colaborador: o gate `typeof editing === 'number'` (equipe/page)
 *      fica false pra string → o PATCH nunca dispara.
 *   2. Registrar atendimento: o `colaborador_id` vai como string no POST →
 *      o backend (Zod number) responde 400.
 * Converter aqui, no único ponto onde a linha entra no app, conserta tudo de
 * uma vez (em vez de remendar cada consumidor). `Number(...)` é idempotente:
 * funciona tanto se o backend já mandar number quanto string.
 */
export function mapColaboradorRow(row: Colaborador): Colaborador {
  return {
    ...row,
    id: Number(row.id),
    comissao_pct: Number(row.comissao_pct),
  };
}

/** Colaborador (da API) -> Draft pra editar no form. Mantém os serviços já marcados. */
export function toDraft(c: Colaborador): Draft {
  return {
    nome: c.nome,
    servicos: normalizeServicos(c.servicos),
    ativo: c.ativo,
    comissao: comissaoToText(c.comissao_pct),
  };
}

export type ValidateResult =
  | {
      ok: true;
      value: { nome: string; servicos: string[]; ativo: boolean; comissao_pct: number };
    }
  | { ok: false; errors: FieldErrors };

/** Valida o draft. `nome` e `comissao` podem ter erro bloqueante (serviços normalizam sozinhos). */
export function validate(draft: Draft): ValidateResult {
  const errors: FieldErrors = {};
  const nome = draft.nome.trim();
  if (!nome) errors.nome = 'Informe o nome do profissional.';
  else if (nome.length > NOME_MAX) errors.nome = `Nome muito longo (máx. ${NOME_MAX}).`;

  const comissao = parseComissao(draft.comissao);
  if (comissao === null) errors.comissao = 'Use um número de 0 a 100.';

  if (errors.nome || errors.comissao) return { ok: false, errors };
  return {
    ok: true,
    value: {
      nome: nome.slice(0, NOME_MAX),
      servicos: normalizeServicos(draft.servicos),
      ativo: draft.ativo,
      comissao_pct: comissao ?? 0,
    },
  };
}
