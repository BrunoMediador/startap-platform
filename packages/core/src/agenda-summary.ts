/**
 * Fonte ÚNICA de montagem/parse do título ("summary") de evento de agenda.
 *
 * FORMATO: "Nome - Servico | WhatsApp: 55XXXXXXXXXXX" (telefone E.164 BR só-dígitos,
 * COM DDI 55, 9º dígito preservado — ver ADR 0028). Sem telefone: "Nome - Servico"
 * (compat com título legado, sem sufixo de WhatsApp).
 *
 * Consumido por:
 *  - apps/portal-api/src/routes/portal-agendamentos.ts (POST/PATCH manual do dono)
 *  - apps/worker/src/jobs/gcal-atend-sync.ts (reconciliação GCal→atendimentos)
 *  - apps/api/src/bots/teste_barbearia.ts (summary escrito pelo LLM, gated por
 *    AGENDA_SUMMARY_NORMALIZE_ENABLED — o LLM segue escrevendo o summary livre; a
 *    normalização/parse é só do lado do handler, não do prompt)
 *
 * ANTES desta unificação existiam DOIS parsers com implementações divergentes (um em
 * portal-agendamentos.ts, outro em gcal-atend-sync.ts) — mesma semântica na prática,
 * mas duplicados. Esta é a fonte única daqui pra frente.
 *
 * Sem I/O — funções puras, testáveis sem mock de banco/rede.
 */
import { canonicalE164, ensureDddBr } from './phone.js';

export type NormalizePhoneResult =
  | { ok: true; digits: string }
  | { ok: false; reason: 'vazio' | 'invalido' };

/**
 * Normaliza telefone de cliente final para o formato canônico do ADR 0028
 * (E.164 BR só-dígitos, DDI 55, 9º dígito preservado). Delega INTEIRAMENTE a
 * `ensureDddBr` — nunca reimplementar regex de telefone aqui.
 *
 * 🔴 NUNCA trocar por `canonicalE164` — ela remove o 9º dígito e quebraria o
 * pareamento de pagantes que têm o 9 (ver ADR 0028).
 */
export function normalizeClientePhone(raw: string): NormalizePhoneResult {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) return { ok: false, reason: 'vazio' };
  const digits = ensureDddBr(trimmed);
  if (digits == null) return { ok: false, reason: 'invalido' };
  return { ok: true, digits };
}

/**
 * Separadores estruturais do formato — se nome/serviço os contiverem, o parser
 * quebra no lugar errado (ex.: cliente "Ana - Maria" produzia título ambíguo).
 * Colapsa em espaço simples ao montar o summary (correção de bug latente).
 */
function sanitizeSummaryPart(value: string): string {
  return value.replace(/ - /g, ' ').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
}

export interface BuildEventSummaryInput {
  nome: string;
  servico: string;
  /** Já normalizado (dígitos, com DDI) — ver normalizeClientePhone. Ausente = sem WhatsApp no título. */
  telefoneDigits?: string;
}

/**
 * Único lugar do monorepo que concatena o título do evento de agenda. Sem
 * telefone → "Nome - Servico" (compat com título legado, sem sufixo de WhatsApp).
 */
export function buildEventSummary({
  nome,
  servico,
  telefoneDigits,
}: BuildEventSummaryInput): string {
  const nomeSan = sanitizeSummaryPart(nome);
  const servicoSan = sanitizeSummaryPart(servico);
  const base = `${nomeSan} - ${servicoSan}`;
  return telefoneDigits ? `${base} | WhatsApp: ${telefoneDigits}` : base;
}

export interface ParsedEventSummary {
  nome: string;
  servico: string;
  telefone?: string;
}

/**
 * Classe do número BR (a partir do DÍGITO CRU, antes do canonicalE164 remover o 9):
 * fixo (10 díg nacional, 5º dígito 2-5) vs celular (11 díg nacional, 9º prefixo, OU
 * 10 díg com 5º dígito 6-9 — celular já gravado sem o 9). `null` = não deu pra
 * classificar (formato estrangeiro/lixo) — trata como "não fundir" no caller.
 *
 * ACHADO DE SEGURANÇA (security, medido 01/08 — P1, corrigido antes do merge):
 * `canonicalE164` colide fixo com celular quando os 8 dígitos finais coincidem —
 * ex.: fixo "1133334444" e celular "11933334444" caem no MESMO canônico
 * "551133334444" (ela remove o 9 às cegas; a premissa "9 não diferencia identidade"
 * só vale DENTRO da classe celular, nunca entre classes). Sem esta guarda,
 * `mesmoTelefone` vazaria PII cross-cliente (agenda do fixo enxergaria o cliente do
 * celular, ou vice-versa). Medição em prod (01/08): 142 registros, 0 fixos reais,
 * 0 colisões — risco LATENTE, não ativo; corrigido antes de ligar a flag.
 */
function classeNumeroBr(digitsComDdi: string): 'fixo' | 'celular' | null {
  // digitsComDdi já tem 55 + DDD + número (12 ou 13 dígitos) — o formato que
  // canonicalE164/ensureDddBr produzem antes de qualquer remoção do 9.
  const semDdi = digitsComDdi.startsWith('55') ? digitsComDdi.slice(2) : digitsComDdi;
  const numero = semDdi.slice(2); // corta o DDD (2 díg)
  if (numero.length === 9) return 'celular'; // 9º dígito presente (prefixo 9 do celular)
  if (numero.length === 8) {
    const primeiro = numero[0];
    if (primeiro >= '6' && primeiro <= '9') return 'celular'; // celular gravado sem o 9
    if (primeiro >= '2' && primeiro <= '5') return 'fixo';
    return null; // '0'/'1' não é DDD nem prefixo válido de linha BR — não classifica
  }
  return null;
}

/**
 * Compara dois telefones por IDENTIDADE (não por escrita) — normaliza os DOIS lados
 * por `canonicalE164` (que REMOVE o 9º dígito de propósito, pra unificar COM-9/SEM-9
 * do MESMO CELULAR) e compara exato. `false` se qualquer lado não canonicalizar —
 * dois `null` NUNCA contam como "o mesmo cliente".
 *
 * 🔴 GUARDA DE CLASSE (P1 do security, 01/08): antes de aceitar `ca === cb`, confirma
 * que os dois lados são da MESMA CLASSE (fixo x fixo, ou celular x celular) —
 * `canonicalE164` por si só funde um fixo de 10 díg com um celular de 11 quando os
 * 8 dígitos finais batem. Classes diferentes → SEMPRE false, mesmo com canônico igual.
 * Sem classificar (formato ambíguo) → false (fail-safe: não funde na dúvida).
 *
 * Uso: casar o remetente da conversa (WAHA, formato variável) contra o telefone
 * gravado no título de um evento (formato variável também) — nunca `.includes()`
 * de substring, que casa por acidente em duração/preço/horário embutido no summary
 * (ex.: "...14:00 | WhatsApp: 5531999998842" casaria busca "3199999").
 *
 * 🔴 Fronteira do ADR 0028 nos DOIS sentidos: `ensureDddBr` pra ESCREVER/ENVIAR
 * (preserva o 9); `canonicalE164` pra COMPARAR/IDENTIFICAR (remove o 9 — é o
 * propósito dela, só dentro da classe celular). Não trocar os papéis.
 */
export function mesmoTelefone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ca = canonicalE164(a);
  const cb = canonicalE164(b);
  if (ca == null || cb == null) return false;
  if (ca !== cb) return false;

  // Guarda de classe: classifica pelo INPUT CRU (ensureDddBr/dígitos originais), não
  // pelo canônico (que já perdeu a informação de classe ao remover o 9). Um dos dois
  // formatos costuma preservar o comprimento original o bastante pra classificar.
  const classeA = classeNumeroBr(ensureDddBr(a) ?? '');
  const classeB = classeNumeroBr(ensureDddBr(b) ?? '');
  if (classeA != null && classeB != null && classeA !== classeB) return false;

  return true;
}

/**
 * Quebra o summary ("Nome - Servico | WhatsApp: numero") em partes. Tolerante:
 * sem match do formato, devolve o texto inteiro como `nome` e serviço vazio
 * (semântica escolhida entre os dois parsers pré-existentes — ambos eram
 * equivalentes nesse ponto; esta é a fonte única daqui pra frente).
 */
export function parseEventSummary(summary: string): ParsedEventSummary {
  let telefone: string | undefined;
  let resto = summary;
  const waIdx = resto.indexOf('| WhatsApp:');
  if (waIdx >= 0) {
    const tel = resto
      .slice(waIdx + '| WhatsApp:'.length)
      .trim()
      .replace(/\D/g, '');
    telefone = tel.length > 0 ? tel : undefined;
    resto = resto.slice(0, waIdx).trim();
  }
  const sep = resto.indexOf(' - ');
  if (sep >= 0) {
    return { nome: resto.slice(0, sep).trim(), servico: resto.slice(sep + 3).trim(), telefone };
  }
  return { nome: resto.trim(), servico: '', telefone };
}
