/**
 * Validador determinístico anti-redundância/anti-injeção da persona gerada (SCRUM-92).
 *
 * Camada 2 do belt-and-suspenders (camada 1 = regra dura do meta-agente; camada 3 = runtime,
 * onde o dado canônico é sempre o do contextBlock). Roda sobre `persona_prompt` ANTES de virar
 * preview OU de ser persistido no approve. Heurística por regex — remove linhas com:
 *  - dados operacionais que NÃO podem entrar na persona (vêm de campos estruturados em runtime):
 *    CEP, telefone, moeda, faixa de horário, logradouro, e nomes de serviço do catálogo do clone;
 *  - tokens ESTRUTURAIS do fluxo (cartão/SIM/nomes de ferramenta/marcadores) — o bloco estrutural
 *    é colado por CÓDIGO no approve; a persona nunca deve carregar (nem tentar remover) a mecânica;
 *  - PII do cliente final (e-mail, CPF) — a persona é durável (bot_prompt_versions), não pode vazar.
 *
 * Além disso: `sanitizeOrphanPlaceholders` limpa `{var}` fora da whitelist (evita placeholder órfão
 * que o renderPrompt entregaria cru ao modelo).
 *
 * NÃO é a garantia da mecânica de agendamento — essa é o BLOCO_ESTRUTURAL colado server-side. Este
 * validador é defesa em profundidade; o pior caso de um vazamento residual é info duplicada, nunca
 * quebra do fluxo.
 */

/** Placeholders que o renderPrompt (apps/api/src/lib/render-prompt.ts) sabe substituir. */
const PLACEHOLDER_WHITELIST = new Set(['nome', 'telefone', 'data_atual']);

/** Persona precisa sobrar com o mínimo de substância após a limpeza pra ser aprovável. */
export const MIN_PERSONA_CHARS = 40;
export const MAX_PERSONA_CHARS = 4000;
/** Teto do prompt FINAL (persona + bloco estrutural) — proteção do renderPrompt/custo. */
export const MAX_FINAL_PROMPT_CHARS = 12_000;

// ── Regex de dados operacionais / PII (rejeitam a LINHA inteira) ─────────────────
const REJECT_LINE_PATTERNS: Array<{ tag: string; re: RegExp }> = [
  { tag: 'cep', re: /\b\d{5}-?\d{3}\b/ },
  { tag: 'moeda', re: /R\$\s?\d/i },
  // faixa/horário: "das 9 às 18", "9h às 18h", "09:00"
  { tag: 'horario', re: /\bdas?\s?\d{1,2}\s?(?:h|:\d{2})?\s?(?:à|a)s?\s?\d/i },
  { tag: 'horario', re: /\b\d{1,2}\s?h\s?(?:à|a)s?\s?\d{1,2}\s?h?\b/i },
  { tag: 'horario', re: /\b\d{1,2}:\d{2}\b/ },
  // logradouro / endereço
  {
    tag: 'logradouro',
    re: /\b(rua|av\.?|avenida|travessa|alameda|rodovia|estrada|pra[çc]a|bairro|cep|logradouro)\b/i,
  },
  { tag: 'logradouro', re: /\bn[ºo°]\.?\s?\d/i },
  // telefone BR (com/sem DDD, com/sem 9º dígito)
  { tag: 'telefone', re: /(?:\+?55\s?)?(?:\(?\d{2}\)?[\s.-]?)?9?\d{4}[\s.-]?\d{4}\b/ },
  // PII cliente
  { tag: 'email', re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i },
  { tag: 'cpf', re: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/ },
  // tokens estruturais do fluxo (a mecânica é colada por código, não pela persona)
  {
    tag: 'estrutural',
    re: /(inserir_agendamento|remarcar_agendamento|cancelar_agendamento|cart[ãa]o\s+de\s+confirma|\[horarios|\[servicos|\bpe[çc]a?\s+["']?sim|responda\s+sim\b|marcador(?:es)?\b)/i,
  },
];

export interface PersonaValidationResult {
  /** Persona limpa (linhas ofensivas removidas + placeholders órfãos limpos). */
  cleaned: string;
  /** Tags do que foi removido (pra log/observabilidade, SEM o conteúdo). */
  removedTags: string[];
  /** true se sobrou substância suficiente pra ser uma persona aprovável. */
  ok: boolean;
}

/** Escapa uma string pra uso literal em RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Limpa placeholders `{var}` fora da whitelist: remove as chaves (`{promo}` -> `promo`),
 * evitando que o renderPrompt entregue `{promo}` cru ao modelo. Whitelist preservada intacta.
 */
export function sanitizeOrphanPlaceholders(text: string): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) =>
    PLACEHOLDER_WHITELIST.has(key) ? match : key,
  );
}

/**
 * Redação de PII inline (não só linha inteira): e-mail e CPF viram [removido]. Roda ANTES do
 * corte por linha; garante que um e-mail no meio de uma frase legítima suma sem apagar a frase.
 */
export function stripPII(text: string): string {
  return text
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[removido]')
    .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[removido]');
}

/**
 * Valida e LIMPA a persona. `servicos` = nomes do catálogo do clone (flow_clones.servicos):
 * uma linha que cite um serviço do catálogo é removida (o dado vem do contextBlock em runtime).
 */
export function validatePersona(
  persona: string,
  opts: { servicos?: string[] } = {},
): PersonaValidationResult {
  // Boundary unicode-aware (não ASCII `\b`): nomes de serviço acentuados ("Corte Degradê")
  // terminam em letra fora de [A-Za-z0-9_], onde `\b` NÃO casa. Lookbehind/lookahead por
  // letra/número (flag `u`) resolve sem over-match tipo "corte" em "cortesia".
  const servicoPatterns = (opts.servicos ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length >= 3)
    .map((s) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(s)}(?![\\p{L}\\p{N}])`, 'iu'));

  const removedTags = new Set<string>();
  const kept: string[] = [];

  for (const rawLine of persona.split('\n')) {
    const line = rawLine.replace(/\s+$/g, '');
    if (line.trim() === '') {
      kept.push('');
      continue;
    }
    let hit: string | null = null;
    for (const { tag, re } of REJECT_LINE_PATTERNS) {
      if (re.test(line)) {
        hit = tag;
        break;
      }
    }
    if (!hit) {
      for (const re of servicoPatterns) {
        if (re.test(line)) {
          hit = 'servico_catalogo';
          break;
        }
      }
    }
    if (hit) {
      removedTags.add(hit);
      continue;
    }
    kept.push(line);
  }

  // Colapsa múltiplas linhas em branco e apara pontas.
  const cleaned = sanitizeOrphanPlaceholders(
    kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );

  const nonEmpty = cleaned.split('\n').filter((l) => l.trim() !== '').length;
  const ok = cleaned.length >= MIN_PERSONA_CHARS && nonEmpty >= 2;

  return { cleaned, removedTags: [...removedTags], ok };
}
