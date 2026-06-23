/**
 * Lógica pura da agenda de ESTABELECIMENTO (multi-profissional). Variante da
 * agenda individual (#332): aqui os eventos vêm marcados com colaborador_id +
 * profissional_nome (o backend agrega as agendas de todos os colaboradores).
 *
 * Tudo aqui é função PURA e testável (sem React/DOM):
 *   - paleta de COR estável por profissional (mesma cor sempre, sem flicker entre
 *     renders/refetches — derivada do colaborador_id, não da ordem da lista);
 *   - lista de profissionais presentes (pra legenda + filtro);
 *   - filtro por profissional;
 *   - agrupamento por horário (eventos no MESMO slot, profissionais distintos,
 *     ficam LADO A LADO — não empilhados como conflito).
 *
 * Por que cor por colaborador_id (e não por índice da lista): o filtro e os
 * refetches mudam a ordem/tamanho da lista; ancorar a cor no id mantém "Bené =
 * roxo" estável a sessão toda. Sem id (evento individual que escapou pra cá, ou
 * agenda mista) cai numa cor neutra determinística pelo nome.
 */
import type { Agendamento } from './api-types';

/**
 * Uma cor de profissional: tokens prontos pra aplicar via style inline (a
 * atribuição é DINÂMICA por profissional — uso legítimo de style calculado).
 * Pensada pro tema escuro do portal (bg #14121c): `solid` vívido pro dot/borda,
 * `soft` translúcido pro fundo do chip, `ink` claro pro texto sobre o soft.
 */
export interface CorProfissional {
  /** Cor "cheia" — usada no dot da legenda, borda-esquerda do chip e barra. */
  solid: string;
  /** Fundo translúcido do chip (contrasta com o texto claro). */
  soft: string;
  /** Cor do texto/realce sobre `soft` (clara, AA no escuro). */
  ink: string;
}

/**
 * Paleta fixa (8 matizes) escolhida pra contrastar entre si E com o fundo escuro.
 * Ordem pensada pra que vizinhos na roda fiquem distantes (roxo→verde→âmbar→…),
 * reduzindo confusão quando há muitos profissionais. `ink` é a versão clara do
 * matiz (≥ AA sobre o `soft`); `soft` é o matiz a ~16% de opacidade.
 */
export const PALETA_PROFISSIONAIS: readonly CorProfissional[] = [
  { solid: '#9a7cf0', soft: 'rgba(154,124,240,0.16)', ink: '#c7b6f8' }, // roxo (brand)
  { solid: '#3fb8a5', soft: 'rgba(63,184,165,0.16)', ink: '#7fd8c9' }, // teal
  { solid: '#e0a23c', soft: 'rgba(224,162,60,0.16)', ink: '#f0c578' }, // âmbar
  { solid: '#e36d8a', soft: 'rgba(227,109,138,0.16)', ink: '#f29db1' }, // rosa
  { solid: '#5b94f0', soft: 'rgba(91,148,240,0.16)', ink: '#9bc0f7' }, // azul
  { solid: '#7bc05a', soft: 'rgba(123,192,90,0.16)', ink: '#abd991' }, // verde
  { solid: '#d57bd0', soft: 'rgba(213,123,208,0.16)', ink: '#e8aee4' }, // magenta
  { solid: '#e0824f', soft: 'rgba(224,130,79,0.16)', ink: '#f0ad88' }, // laranja
] as const;

/** Cor neutra pra eventos sem profissional resolvível (não some, fica sóbrio). */
export const COR_SEM_PROFISSIONAL: CorProfissional = {
  solid: '#7a7390',
  soft: 'rgba(122,115,144,0.16)',
  ink: '#b4aecb',
};

/**
 * Hash determinístico simples (FNV-1a 32-bit) de uma string → índice estável.
 * Usado só como fallback quando não há colaborador_id (anuvia a cor pelo nome).
 */
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Cor ESTÁVEL de um profissional. Ancorada no `colaborador_id` (id estável do
 * banco) → "Bené = roxo" a sessão toda, independente de filtro/refetch/ordem.
 * Sem id, usa o hash do nome (determinístico). Sem id nem nome → cor neutra.
 */
export function corDoProfissional(
  colaboradorId: number | undefined,
  profissionalNome: string | undefined,
): CorProfissional {
  if (typeof colaboradorId === 'number' && Number.isFinite(colaboradorId)) {
    // colaboradorId é 1-based no banco; -1 alinha o id=1 ao 1º matiz da paleta.
    const idx =
      (((colaboradorId - 1) % PALETA_PROFISSIONAIS.length) + PALETA_PROFISSIONAIS.length) %
      PALETA_PROFISSIONAIS.length;
    return PALETA_PROFISSIONAIS[idx];
  }
  const nome = (profissionalNome ?? '').trim();
  if (nome === '') return COR_SEM_PROFISSIONAL;
  return PALETA_PROFISSIONAIS[hashString(nome.toLowerCase()) % PALETA_PROFISSIONAIS.length];
}

/** Um profissional presente na agenda (pra legenda + filtro). */
export interface ProfissionalNaAgenda {
  /** colaborador_id do banco; null = bucket "sem profissional". */
  id: number | null;
  nome: string;
  cor: CorProfissional;
  /** Quantos eventos desse profissional na janela atual. */
  count: number;
}

/** Chave de bucket por profissional: o id quando existe, senão 'sem'. */
function profKey(ag: Agendamento): string {
  return typeof ag.colaborador_id === 'number' ? `id:${ag.colaborador_id}` : 'sem';
}

/**
 * Lista os profissionais presentes na janela (dedup por colaborador_id), com cor
 * e contagem. Ordenada por nome (locale pt-BR) pra a legenda/filtro ficarem
 * estáveis. O bucket "sem profissional" (se houver) vai pro fim.
 */
export function profissionaisNaAgenda(agendamentos: Agendamento[]): ProfissionalNaAgenda[] {
  const map = new Map<string, ProfissionalNaAgenda>();
  for (const ag of agendamentos) {
    const key = profKey(ag);
    const existente = map.get(key);
    if (existente) {
      existente.count += 1;
      continue;
    }
    const id = typeof ag.colaborador_id === 'number' ? ag.colaborador_id : null;
    const nome = ag.profissional_nome?.trim() || (id === null ? 'Sem profissional' : `#${id}`);
    map.set(key, {
      id,
      nome,
      cor: corDoProfissional(id ?? undefined, ag.profissional_nome),
      count: 1,
    });
  }
  const lista = [...map.values()];
  lista.sort((a, b) => {
    // "Sem profissional" sempre por último.
    if (a.id === null) return 1;
    if (b.id === null) return -1;
    return a.nome.localeCompare(b.nome, 'pt-BR');
  });
  return lista;
}

/**
 * Filtra a lista por colaborador_id. `null` (o valor sentinela do filtro "Todos")
 * não filtra. Um id específico mantém só os eventos daquele profissional.
 */
export function filtrarPorProfissional(
  agendamentos: Agendamento[],
  colaboradorId: number | null,
): Agendamento[] {
  if (colaboradorId === null) return agendamentos;
  return agendamentos.filter((ag) => ag.colaborador_id === colaboradorId);
}

/** Um grupo de eventos que começam no MESMO horário (profissionais distintos). */
export interface GrupoHorario {
  /** Chave do horário ('YYYY-MM-DDTHH:mm' local, ou 'sem' pros sem início). */
  chave: string;
  /** ISO de início (o do 1º evento) — null pros sem horário. */
  inicio: string | null;
  /** Eventos paralelos nesse horário, ordenados por nome do profissional. */
  eventos: Agendamento[];
}

/**
 * Chave de minuto local de um evento (agrupa "paralelos" = mesmo dia+hora+minuto).
 * Eventos sem início viram a chave 'sem' (vão pro fim, num grupo só).
 */
function chaveMinuto(inicio: string | null): string {
  if (!inicio) return 'sem';
  const d = new Date(inicio);
  if (Number.isNaN(d.getTime())) return 'sem';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${mi}`;
}

/**
 * Agrupa os eventos por horário de início. Eventos no MESMO minuto (profissionais
 * diferentes) caem no MESMO grupo → a UI os mostra LADO A LADO (paralelos), não
 * empilhados como conflito. Grupos ordenados por horário ASC; dentro do grupo,
 * por nome do profissional (estável). O grupo 'sem' (sem horário) vai pro fim.
 *
 * Espera a lista JÁ filtrada/ordenada como vier; é estável e idempotente.
 */
export function agruparPorHorario(agendamentos: Agendamento[]): GrupoHorario[] {
  const map = new Map<string, GrupoHorario>();
  for (const ag of agendamentos) {
    const chave = chaveMinuto(ag.inicio);
    const g = map.get(chave);
    if (g) {
      g.eventos.push(ag);
    } else {
      map.set(chave, { chave, inicio: chave === 'sem' ? null : ag.inicio, eventos: [ag] });
    }
  }

  const grupos = [...map.values()];
  // Ordena por horário; 'sem' (inicio null) vai pro fim.
  grupos.sort((a, b) => {
    if (a.inicio === null) return 1;
    if (b.inicio === null) return -1;
    return a.inicio.localeCompare(b.inicio);
  });
  // Dentro de cada grupo, ordena por nome do profissional (estável p/ paralelos).
  for (const g of grupos) {
    g.eventos.sort((x, y) =>
      (x.profissional_nome ?? '').localeCompare(y.profissional_nome ?? '', 'pt-BR'),
    );
  }
  return grupos;
}
