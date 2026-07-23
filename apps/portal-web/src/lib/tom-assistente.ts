'use client';

/**
 * "Tom da conversa do assistente" (SCRUM-92) — dentro de "Meu negócio".
 *
 * O dono ajusta o quão DIRETO ou CALOROSO o assistente fala num slider amigável. Por
 * baixo o backend mapeia a parada escolhida pra temperatura do modelo — o dono NUNCA vê
 * número, só um controle com paradas nomeadas. Aqui vive SÓ o transporte tipado + a lógica
 * pura de mapeamento nível<->posição do slider (sem React/DOM — testável em node).
 *
 * Contrato (portal-api, sendo construído em paralelo; base /portal/tom-assistente):
 *   GET /portal/tom-assistente -> { nivel, niveis: [{ id, label, ordem }] }
 *   PUT /portal/tom-assistente  (body { nivel }) -> 200 { nivel, niveis? }  (novo estado)
 *
 * Gating / degradação graciosa: enquanto o endpoint não existe (ou a feature está off), o
 * GET responde 404 -> normalizado pra { status:'indisponivel' } => a seção SOME (byte-idêntico
 * pros clientes atuais, mesmo critério de lembretes/atendimentos/prompt-builder). Erro REAL
 * (rede/500) propaga (isError) -> a seção mostra ErrorState com retry, NUNCA quebra a página.
 * NUNCA envia slot (o cookie de sessão viaja sozinho via apiFetch credentials:'include').
 */
import { ApiError, apiFetch } from './api';

const BASE = '/portal/tom-assistente';

/**
 * Níveis conhecidos do catálogo (fonte da verdade do tipo). O backend pode reordenar via
 * `ordem`, mas os IDs são estes. Parada nova = estender aqui (contrato + tipo casados).
 */
export const TOM_NIVEIS_CONHECIDOS = [
  'direto',
  'equilibrado',
  'caloroso',
  'bem_descontraido',
] as const;

export type TomNivel = (typeof TOM_NIVEIS_CONHECIDOS)[number];

/** Nível-âncora usado como fallback (parada "do meio", tom neutro) quando o dado falha. */
export const DEFAULT_NIVEL: TomNivel = 'equilibrado';

/** Uma parada do slider. `ordem` (asc) define a posição; `label` é o rótulo do backend. */
export interface TomNivelOpcao {
  id: TomNivel;
  label: string;
  ordem: number;
}

/**
 * Catálogo padrão — usado SÓ como rede de proteção quando o GET vem sem `niveis` válidos
 * (o backend deve enviar). Ordem = posição da parada no slider (esquerda->direita).
 */
export const DEFAULT_NIVEIS: TomNivelOpcao[] = [
  { id: 'direto', label: 'Direto', ordem: 0 },
  { id: 'equilibrado', label: 'Equilibrado', ordem: 1 },
  { id: 'caloroso', label: 'Caloroso', ordem: 2 },
  { id: 'bem_descontraido', label: 'Bem descontraído', ordem: 3 },
];

/**
 * COPY — RASCUNHO (DRAFT). O PM confirma o texto final com o Bruno antes de ir pro ar
 * (rótulos das pontas e ajuda são provisórios). Centralizado aqui pra troca trivial —
 * NÃO espalhar strings soltas no componente.
 */
export const TOM_COPY = {
  titulo: 'Tom da conversa do assistente',
  subtitulo: 'Como o seu assistente conversa com os clientes no WhatsApp.',
  ajuda: 'Ajuste o jeito do assistente conversar — do mais direto ao mais caloroso.',
  ariaSlider: 'Tom da conversa do assistente',
  pontaEsquerda: 'Mais direto e objetivo',
  centro: 'Equilibrado',
  pontaDireita: 'Mais caloroso e conversador',
  atual: 'Tom atual:',
  salvar: 'Salvar',
  salvando: 'Salvando…',
  naoSalvo: 'Você tem alterações não salvas.',
  salvo: 'Tudo salvo. O assistente já conversa nesse tom.',
  sucesso: 'Tom da conversa atualizado.',
  erroInvalido: 'Esse tom não está disponível. Escolha outra parada e tente de novo.',
  erroGenerico: 'Não foi possível salvar. Tente de novo.',
} as const;

// ── Contrato cru (não exportado; a UI consome o estado normalizado) ──────────────

interface RawNivelOpcao {
  id?: unknown;
  label?: unknown;
  ordem?: unknown;
}

interface RawTomResponse {
  nivel?: unknown;
  niveis?: unknown;
}

// ── Estado normalizado ───────────────────────────────────────────────────────────

/** Estado do GET já normalizado. `indisponivel` = 404 (feature off / endpoint ausente). */
export type TomState =
  | { status: 'indisponivel' }
  | { status: 'ok'; nivel: TomNivel; niveis: TomNivelOpcao[] };

// ── Predicados / parsers puros (testáveis) ───────────────────────────────────────

/** É um ID de nível conhecido? (narrow pra TomNivel). */
export function isTomNivel(v: unknown): v is TomNivel {
  return typeof v === 'string' && (TOM_NIVEIS_CONHECIDOS as readonly string[]).includes(v);
}

/** 404 = feature off / endpoint ainda não existe -> some a seção (não é "erro"). */
export function isTomUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** 400 = nível inválido rejeitado pelo backend (rede de proteção do PUT). */
export function isTomInvalido(err: unknown): boolean {
  return err instanceof ApiError && err.status === 400;
}

/** Nível cru -> TomNivel (fallback DEFAULT_NIVEL quando ausente/desconhecido). */
export function parseNivel(raw: unknown): TomNivel {
  return isTomNivel(raw) ? raw : DEFAULT_NIVEL;
}

/**
 * Catálogo cru -> lista de paradas válidas. Descarta entrada malformada (id desconhecido,
 * label não-string, ordem não-numérica). Vazio após o filtro -> DEFAULT_NIVEIS (o slider
 * sempre tem paradas). Defensivo: nunca confia no shape cru.
 */
export function parseNiveis(raw: unknown): TomNivelOpcao[] {
  if (!Array.isArray(raw)) return DEFAULT_NIVEIS;
  const out: TomNivelOpcao[] = [];
  for (const item of raw) {
    const o = (item ?? {}) as RawNivelOpcao;
    if (!isTomNivel(o.id)) continue;
    if (typeof o.label !== 'string' || o.label.trim().length === 0) continue;
    if (typeof o.ordem !== 'number' || !Number.isFinite(o.ordem)) continue;
    out.push({ id: o.id, label: o.label, ordem: o.ordem });
  }
  return out.length > 0 ? out : DEFAULT_NIVEIS;
}

// ── Mapeamento nível <-> posição do slider (núcleo puro, testado) ────────────────

/** Ordena o catálogo por `ordem` (asc), estável — a posição no slider = índice aqui. */
export function ordenarNiveis(niveis: TomNivelOpcao[]): TomNivelOpcao[] {
  return [...niveis].sort((a, b) => a.ordem - b.ordem);
}

/**
 * Índice (0-based) do nível no catálogo ordenado — a posição do polegar no slider.
 * Nível ausente do catálogo -> índice do DEFAULT_NIVEL; sem ele, a parada do meio; catálogo
 * vazio -> 0. Nunca estoura (não retorna -1).
 */
export function nivelToIndex(nivel: TomNivel, niveis: TomNivelOpcao[]): number {
  const ord = ordenarNiveis(niveis);
  if (ord.length === 0) return 0;
  const i = ord.findIndex((n) => n.id === nivel);
  if (i >= 0) return i;
  const def = ord.findIndex((n) => n.id === DEFAULT_NIVEL);
  if (def >= 0) return def;
  return Math.floor((ord.length - 1) / 2);
}

/**
 * Nível na posição do slider (arredonda + clampa aos limites do catálogo). Catálogo vazio ->
 * DEFAULT_NIVEL. É o inverso de nivelToIndex pros índices válidos.
 */
export function indexToNivel(index: number, niveis: TomNivelOpcao[]): TomNivel {
  const ord = ordenarNiveis(niveis);
  if (ord.length === 0) return DEFAULT_NIVEL;
  const clamped = Math.min(Math.max(Math.round(index), 0), ord.length - 1);
  return ord[clamped].id;
}

/** Rótulo (label do backend) de um nível; fallback pro próprio id se não estiver no catálogo. */
export function labelDoNivel(nivel: TomNivel, niveis: TomNivelOpcao[]): string {
  return niveis.find((n) => n.id === nivel)?.label ?? nivel;
}

// ── Transporte ────────────────────────────────────────────────────────────────────

/**
 * GET do tom atual + catálogo. 404 -> { status:'indisponivel' } (some a seção). Erro real
 * (rede/500) propaga -> a seção mostra ErrorState com retry (não some silenciosamente).
 */
export async function fetchTomAssistente(signal?: AbortSignal): Promise<TomState> {
  try {
    const r = await apiFetch<RawTomResponse>(BASE, { signal });
    return { status: 'ok', nivel: parseNivel(r?.nivel), niveis: parseNiveis(r?.niveis) };
  } catch (err) {
    if (isTomUnavailable(err)) return { status: 'indisponivel' };
    throw err; // erro real -> react-query isError -> ErrorState
  }
}

/**
 * PUT do novo nível. Devolve o estado OK já parseado (o backend responde o novo estado; se
 * não reenviar `niveis`, o chamador reusa o catálogo atual). Lança ApiError em falha (400
 * inválido / 404 feature off / 500) -> o componente ramifica no onError com os predicados.
 */
export async function putTomAssistente(
  nivel: TomNivel,
  signal?: AbortSignal,
): Promise<{ nivel: TomNivel; niveis: TomNivelOpcao[] | null }> {
  const r = await apiFetch<RawTomResponse>(BASE, { method: 'PUT', body: { nivel }, signal });
  return {
    nivel: parseNivel(r?.nivel),
    // Reenviou catálogo? usa; senão null -> o hook preserva o catálogo em cache.
    niveis: Array.isArray(r?.niveis) ? parseNiveis(r.niveis) : null,
  };
}
