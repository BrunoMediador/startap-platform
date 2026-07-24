/**
 * Parser de telefone a partir do payload WAHA.
 *
 * Por que existe: WhatsApp tem 2 modos de endereçamento ("addressingMode"):
 *  - "pn"  → payload.from contém o número de telefone direto
 *  - "lid" → payload.from contém um LID opaco; o número real está em
 *           payload._data.key.remoteJidAlt
 *
 * Esta função abstrai essa lógica. Sempre retorna apenas dígitos (com DDI).
 */
import { createHmac } from 'node:crypto';
import type { WahaWebhookBody } from './types.js';

/** Extrai telefone "real" do payload WAHA. Retorna string de dígitos (ex: 5535999998888) ou null. */
export function extractPhone(body: WahaWebhookBody): string | null {
  const payload = body.payload;
  if (!payload) return null;

  const mode = payload._data?.key?.addressingMode;
  const raw =
    mode === 'pn' ? (payload.from ?? '') : (payload._data?.key?.remoteJidAlt ?? payload.from ?? '');

  const cleaned = raw
    .replace('@c.us', '')
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .replace(/\D/g, '');

  return cleaned.length >= 10 ? cleaned : null;
}

/** Retorna o chat_id original (do campo `from`), preservando @c.us / @lid. */
export function extractChatId(body: WahaWebhookBody): string {
  return body.payload?.from ?? '';
}

// ---------------------------------------------------------------------------
// Resolução LID → telefone (SCRUM-63) — pós-migração LID do WhatsApp
// ---------------------------------------------------------------------------
//
// Depois da migração LID, o store da engine NOWEB fica LID-first: contatos
// migrados são endereçados por `<lid>@lid` (um identificador opaco, NÃO um
// telefone). No INBOUND o número real vem em `_data.key.remoteJidAlt`
// (extractPhone já resolve). Mas o ECO fromMe (e respostas manuais do dono) a um
// contato migrado pode chegar SEM o remoteJidAlt → extractPhone cai no
// pseudo-número do lid. Estes helpers puros detectam o caso e tentam achar o pn
// DIRETO no payload; o fallback REST (GET /lids/{lid}) mora no chamador.

/** Domínios de JID que carregam um número de telefone REAL (pn), em oposição a `@lid`. */
const PN_JID_DOMAINS = ['@s.whatsapp.net', '@c.us'] as const;

/** Limpa um JID/valor para os dígitos puros do telefone (sem domínio, sem não-dígitos). */
function jidToDigits(raw: string): string {
  return raw
    .replace('@c.us', '')
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '')
    .replace(/\D/g, '');
}

/**
 * Retorna os dígitos do LID quando o chat é endereçado por `@lid` (contato migrado
 * cujo `from`/`remoteJid` é `<lid>@lid`), senão null. NÃO é um telefone — é o
 * identificador opaco do WhatsApp; serve só para (a) detectar que precisamos resolver
 * o pn e (b) alimentar o lookup `GET /api/{session}/lids/{lid}`.
 */
export function extractLidDigits(body: WahaWebhookBody): string | null {
  const payload = body.payload;
  if (!payload) return null;
  const from = payload.from ?? '';
  const remoteJid = payload._data?.key?.remoteJid ?? '';
  const lidJid = from.endsWith('@lid') ? from : remoteJid.endsWith('@lid') ? remoteJid : '';
  if (!lidJid) return null;
  const digits = jidToDigits(lidJid);
  return digits.length > 0 ? digits : null;
}

/** true se o chat é endereçado por LID (contato migrado). */
export function isLidAddressed(body: WahaWebhookBody): boolean {
  return extractLidDigits(body) !== null;
}

/**
 * Tenta extrair o telefone REAL (pn) DIRETO do payload do webhook, olhando os campos
 * que o Baileys moderno anexa ao par lid/pn: `remoteJidAlt` (o alternativo do `remoteJid`)
 * e `senderPn`/`participantPn` (em `_data.key`, `_data` ou no topo do payload). Só aceita
 * valor de domínio pn (`@s.whatsapp.net`/`@c.us`) — NUNCA `@lid`. É o MESMO mecanismo que
 * resolve o inbound de contato migrado (extractPhone via remoteJidAlt), reusado para o
 * ramo fromMe onde o remoteJidAlt pode faltar. Retorna dígitos (>=10) ou null.
 */
export function extractPnFromPayload(body: WahaWebhookBody): string | null {
  const payload = body.payload;
  if (!payload) return null;
  const key = (payload._data?.key ?? {}) as Record<string, unknown>;
  const data = (payload._data ?? {}) as Record<string, unknown>;
  const top = payload as unknown as Record<string, unknown>;
  const candidates: unknown[] = [
    key.remoteJidAlt,
    key.senderPn,
    key.participantPn,
    data.senderPn,
    data.participantPn,
    top.senderPn,
    top.participantPn,
  ];
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    if (!PN_JID_DOMAINS.some((d) => c.endsWith(d))) continue;
    const digits = jidToDigits(c);
    if (digits.length >= 10) return digits;
  }
  return null;
}

/** Formata um telefone bruto para um chat_id válido WhatsApp (`5535...@c.us`). */
export function toChatId(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}

// ---------------------------------------------------------------------------
// Canonicalização E.164 — identidade única do trial (Missão 020 F1)
// ---------------------------------------------------------------------------

/**
 * Canonicaliza um telefone para a forma de IDENTIDADE única usada pelo
 * trial_ledger (HMAC). Aceita entrada suja: máscara BR "(31) 99999-8842",
 * me.id do WAHA "5531999998842:12@s.whatsapp.net", dígitos puros etc.
 *
 * Regras BR (DDI 55) — o 9º dígito móvel NÃO diferencia identidade
 * (WAHA/Baileys ora entrega com, ora sem o 9 — doc 020):
 *  - 13 dígitos (55 + DDD + 9 + 8): remove o 9 → canônico de 12 dígitos.
 *  - 12 dígitos (55 + DDD + 8): já canônico.
 *  - 10/11 dígitos sem DDI (DDD + 8/9): assume BR, prefixa 55 e aplica a regra.
 *  - Prefixo de operadora/tronco "0" à esquerda é removido.
 *
 * Não-BR: retorna os dígitos como vieram (10-15 dígitos), sem regra especial.
 *
 * Retorna SOMENTE dígitos com DDI (ex: "553199998842") ou null se irrecuperável.
 */
export function canonicalE164(raw: string): string | null {
  if (!raw) return null;
  // Corta sufixos de JID/me.id do WAHA (":device" e "@dominio") antes de limpar.
  const base = raw.split('@')[0]?.split(':')[0] ?? '';
  let digits = base.replace(/\D/g, '');
  // Remove prefixo tronco/operadora (ex: "031..." discado).
  digits = digits.replace(/^0+/, '');
  if (digits.length < 10 || digits.length > 15) return null;

  // 10/11 dígitos = tamanho local BR (DDD + 8/9): assume Brasil e prefixa DDI.
  // Vale inclusive começando com 55 (DDD 55 local) — produto BR, decisão de domínio.
  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  if (digits.startsWith('55')) {
    // BR: 55 + DDD(2) + número(8|9). Fora disso, inválido.
    if (digits.length === 13 && digits[4] === '9') {
      // Móvel com 9º dígito → identidade canônica SEM o 9.
      return digits.slice(0, 4) + digits.slice(5);
    }
    if (digits.length === 12) return digits;
    if (digits.length === 13) return digits; // 9 dígitos não iniciados em 9 (raro) — mantém.
    return null;
  }

  // Internacional não-BR: dígitos como estão.
  return digits;
}

/**
 * Normaliza um `me.id` do WAHA (ou qualquer JID) para os DÍGITOS PUROS do número,
 * PRESERVANDO o 9º dígito móvel BR — diferente de canonicalE164 (que REMOVE o 9 para
 * formar a chave de identidade do trial). É a forma usada na coluna
 * flow_clones.alert_owner_phone, que precisa bater com o destino de envio do WAHA.
 *
 * Por que NÃO reusar canonicalE164: a 050 fez backfill de alert_owner_phone com os
 * dígitos crus de cliente_telefone (regexp_replace, sem tirar o 9). Os clientes
 * pagantes ficaram com 13 dígitos COM o 9 (Cirilo 5511979630828, Samuel
 * 5535991746797). Para o autofill gravar no MESMO formato e não divergir, preservamos
 * o número como veio do me.id, só limpando o envelope.
 *
 * Aceita: "5511979630828@c.us", "+556599453860@c.us", "5531999998842:12@s.whatsapp.net",
 * "(11) 97963-0828". Corta sufixo de device (":n") e de domínio ("@..."), remove o "+"
 * e qualquer não-dígito, e o prefixo de tronco "0" à esquerda.
 *
 * @returns dígitos puros (>= 8) ou null se irrecuperável/curto demais.
 */
export function meIdToDigits(raw: string): string | null {
  if (!raw) return null;
  const base = raw.split('@')[0]?.split(':')[0] ?? '';
  const digits = base.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 8 ? digits : null;
}

/**
 * DDDs BR oficiais (Anatel). Whitelist usada por ensureDddBr para NÃO inferir
 * DDI 55 em cima de número ambíguo/estrangeiro. Lista fechada — só códigos reais.
 */
const BR_DDD = new Set<string>([
  // SP
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  // RJ/ES
  '21',
  '22',
  '24',
  '27',
  '28',
  // MG
  '31',
  '32',
  '33',
  '34',
  '35',
  '37',
  '38',
  // PR/SC
  '41',
  '42',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  // RS
  '51',
  '53',
  '54',
  '55',
  // DF/GO/TO/MT/MS/AC/RO
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '67',
  '68',
  '69',
  // BA/SE
  '71',
  '73',
  '74',
  '75',
  '77',
  '79',
  // PE/AL/PB/RN/CE/PI
  '81',
  '82',
  '83',
  '84',
  '85',
  '86',
  '87',
  '88',
  '89',
  // PA/AM/RR/AP/MA
  '91',
  '92',
  '93',
  '94',
  '95',
  '96',
  '97',
  '98',
  '99',
]);

/**
 * Garante DDI 55 num telefone BR de forma CONSERVADORA para uso como destino de
 * pareamento/envio WAHA. NUNCA adiciona nem remove o 9º dígito móvel — ao contrário
 * de canonicalE164 (que REMOVE o 9 p/ a chave de identidade do trial). Preserva
 * exatamente o número que veio; só decide se prefixa o DDI 55.
 *
 * Motivação: flow_clones.cliente_telefone tem formatos inconsistentes. O request-code
 * do WAHA recebe o número CRU; sem o DDI 55 (ex.: dragon "3599247411", real
 * "553599247411") o pareamento FALHA. Os pagantes têm 13 díg COM o 9
 * (Cirilo 5511979630828, Samuel 5535991746797) e NÃO podem ser tocados.
 *
 * Regras (reusa a limpeza de envelope do meIdToDigits — corta ":device" e "@dominio",
 * tira "+"/não-dígitos e o tronco "0" à esquerda):
 *  - 12-13 dígitos JÁ começando com '55' → retorna como está (não toca no 9).
 *  - 10-11 dígitos SEM '55' (nacional sem DDI) → valida o DDD e prefixa '55'.
 *  - Em ambos os casos os 2 dígitos após o '55' (o DDD) precisam estar na whitelist
 *    BR oficial; fora dela → null (não adivinha).
 *  - Qualquer outro tamanho (JID de grupo de 18 díg, prefixo estrangeiro, curto/vazio)
 *    → null. O chamador trata null como "telefone inválido" (não tenta parear com lixo).
 *
 * @returns dígitos COM DDI 55 (ex.: "553599247411") ou null se inválido/ambíguo.
 */
export function ensureDddBr(raw: string): string | null {
  // Reusa a limpeza de envelope/tronco do meIdToDigits (corta @, :, +, 0 à esquerda).
  const digits = meIdToDigits(raw);
  if (!digits) return null;

  // 10-11 dígitos sem DDI = número nacional (DDD + 8/9). Valida o DDD e prefixa 55.
  if (digits.length === 10 || digits.length === 11) {
    const ddd = digits.slice(0, 2);
    if (!BR_DDD.has(ddd)) return null;
    return `55${digits}`;
  }

  // 12-13 dígitos COM DDI 55 = já tem DDI. Valida o DDD (após o 55) e devolve intacto
  // (NÃO toca no 9 — preserva pagantes de 13 díg e dragon de 12).
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    if (!BR_DDD.has(ddd)) return null;
    return digits;
  }

  // Qualquer outro caso (JID de grupo 18 díg, estrangeiro, 11 díg começando com 55
  // que daria DDD inválido, etc.) → não adivinha.
  return null;
}

/**
 * Hint mascarado para suporte/ops (LGPD — doc 020): "+55 31 •••••-••42".
 * NUNCA loga/grava o número completo; só DDD + 2 últimos dígitos.
 */
export function phoneHint(canonical: string): string {
  const digits = canonical.replace(/\D/g, '');
  const last2 = digits.slice(-2);
  if (digits.startsWith('55') && digits.length >= 12) {
    const ddd = digits.slice(2, 4);
    return `+55 ${ddd} •••••-••${last2}`;
  }
  return `+${digits.slice(0, 2)} •••••-••${last2}`;
}

const LOG_PEPPER_ENV = 'LOG_PHONE_PEPPER';
const LOG_PEPPER_MIN_LENGTH = 16;

/**
 * Tag ESTÁVEL e MASCARADA de um telefone para uso em LOG (SCRUM-117; Regra de Ouro
 * nº6 do CLAUDE.md: "logs nunca persistem CPF/telefone sem hash"). NUNCA devolve o
 * número em claro. É o helper canônico que todo log do núcleo bot/router deve usar no
 * lugar do telefone cru.
 *
 * Formato: `+55 31 •••••-••42` (máscara sancionada de suporte/ops — phoneHint), com um
 * sufixo opaco de correlação `#<8 hex>` ANEXADO quando `LOG_PHONE_PEPPER` (≥16 chars)
 * está configurada. O sufixo é os 8 primeiros hex de HMAC-SHA256(pepper, E.164
 * canônico): estável por-número (mesma conversa → mesmo sufixo) e não-reversível — dá
 * correlação forte SEM a colisão de "DDD + 2 últimos dígitos" da máscara sozinha, e SEM
 * expor o número.
 *
 * BOOT-SAFE: `LOG_PHONE_PEPPER` é OPCIONAL — lida lazy, só no ponto de uso. Sem ela,
 * degrada para SÓ a máscara (que já é LGPD-safe); o boot NUNCA crasha e nenhum caminho
 * quebra pela ausência. Pepper PRÓPRIO de propósito: reusar TRIAL/PACKAGE_PHONE_PEPPER
 * permitiria JOIN entre o log e o trial_ledger/pacotes pelo mesmo hash — a linkability
 * cross-finalidade que a ADR 0025 §4 desencoraja.
 *
 * Aceita entrada suja: dígitos crus do extractPhone, chatId "55…@c.us", máscara BR.
 * Sem dígitos aproveitáveis (grupo/lid/vazio) → `[no-phone]` (nunca lança).
 *
 * ⚠️ NÃO use a saída como identidade de decisão (anti-eco/pausa/roteamento) — só LOG.
 */
export function phoneLogTag(raw: string | null | undefined): string {
  if (!raw) return '[no-phone]';
  const canonical = canonicalE164(raw);
  const digits = canonical ?? raw.replace(/\D/g, '');
  if (digits.length < 4) return '[no-phone]';
  const masked = phoneHint(digits);
  const pepper = process.env[LOG_PEPPER_ENV];
  if (canonical && pepper && pepper.trim().length >= LOG_PEPPER_MIN_LENGTH) {
    const tag = createHmac('sha256', pepper.trim())
      .update(canonical, 'utf8')
      .digest('hex')
      .slice(0, 8);
    return `${masked}#${tag}`;
  }
  return masked;
}

/**
 * Detecta se um payload WAHA é de um grupo (não chat 1:1).
 *
 * Critérios (qualquer um basta):
 *  1. payload.from termina em @g.us  — chatId explícito de grupo
 *  2. payload.from começa com 120363 — JID de grupo padrão NOWEB/Baileys
 *  3. payload.participant está presente e não vazio — campo só existe em msgs de grupo
 *
 * IDs de ~22+ dígitos (ex: 5592813522781591200729) são LIDs malformados gerados
 * pelo NOWEB para participantes de grupo — eles SEMPRE vêm acompanhados de
 * `participant`, portanto já são capturados pelo critério 3.
 *
 * @returns true se for mensagem de grupo — deve ser ignorada pelo router.
 */
export function isGroupChat(body: WahaWebhookBody): boolean {
  const payload = body.payload;
  if (!payload) return false;

  const from = payload.from ?? '';

  // Critério 1: @g.us explícito
  if (from.endsWith('@g.us')) return true;

  // Critério 2: JID de grupo NOWEB começa com 120363 (antes de @)
  const jidLocal = from.split('@')[0] ?? '';
  if (jidLocal.startsWith('120363')) return true;

  // Critério 3: campo participant presente — exclusivo de mensagens em grupo
  const p = payload as Record<string, unknown>;
  const participant = p['participant'];
  if (typeof participant === 'string' && participant.length > 0) return true;

  return false;
}
