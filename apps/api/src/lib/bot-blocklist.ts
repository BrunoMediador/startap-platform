/**
 * bot-blocklist — blocklist GLOBAL de números internos da operação.
 *
 * Por quê: o número remetente da sessão `ALERTAS` (553598373138) é NOSSO — dispara
 * avisos pro time e pros donos. Quando esse número manda mensagem pra QUALQUER bot
 * cliente (ex.: o alerta de cancelamento que chega no próprio número da barbearia),
 * o bot NÃO deve responder (nem chamar IA/GCal) — senão dois sistemas internos ficam
 * conversando entre si (loop/eco). O filtro vale pra TODOS os clones (atuais e
 * futuros) porque mora no router compartilhado, ANTES de chegar nos bots.
 *
 * Configuração: env OPCIONAL `BOT_BLOCKLIST_NUMBERS` (lista separada por vírgula).
 * Default já inclui o remetente atual da ALERTAS (553598373138) — sem depender de
 * setar a env em prod. Env OPCIONAL com default = NÃO é env obrigatória nova no boot
 * (lição do incidente #247: env nova nunca derruba a api). A env soma números extras.
 *
 * NOTA (Missão pós-023): o número ANTIGO 553599247411 ("7411") NÃO é mais o remetente
 * de alertas e foi LIBERADO do blocklist — o Bruno vai reusá-lo pra outros fins, então
 * o bot PRECISA poder interagir com ele. Quem bloqueia agora é o remetente ATUAL.
 *
 * IMPORTANTE — NÃO bloquear números do time/teste: o Bruno testa os bots com o
 * número dele (ex.: 5519981018908) e com 553598877248. Esses NÃO entram aqui. Só
 * o(s) número(s) OPERACIONAL(is) interno(s) que enviam alerta (a sessão ALERTAS).
 *
 * Comparação: só dígitos. Para tolerar o 9º dígito móvel BR (a WAHA/Baileys ora
 * entrega com, ora sem o 9), comparamos tanto os dígitos crus quanto a forma
 * canônica E.164 (canonicalE164) de cada lado.
 */
import { canonicalE164 } from '@startap/core/phone';

/** Número remetente atual da sessão ALERTAS — bloqueado por DEFAULT (sem precisar de env). */
export const DEFAULT_BLOCKLIST_NUMBER = '553598373138';

/**
 * Parseia a env `BOT_BLOCKLIST_NUMBERS` (CSV) em um Set de números normalizados.
 * O default (remetente da ALERTAS) é SEMPRE incluído, mesmo que a env traga outros:
 * é uma base de segurança, unida ao que vier da env. Cada item é normalizado
 * (dígitos + canônico).
 */
function parseBlocklist(rawEnv: string | undefined): Set<string> {
  const out = new Set<string>();
  const add = (value: string): void => {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 8) return; // ignora lixo/entradas vazias
    out.add(digits);
    const canon = canonicalE164(digits);
    if (canon) out.add(canon);
  };

  // Default de segurança (sempre presente).
  add(DEFAULT_BLOCKLIST_NUMBER);

  // Itens adicionais da env (CSV). Ausente/vazia = só o default.
  if (rawEnv && rawEnv.trim().length > 0) {
    for (const part of rawEnv.split(',')) {
      add(part);
    }
  }

  return out;
}

/**
 * Set normalizado, parseado UMA vez no load do módulo (lista estática, não muda em
 * runtime — não precisa de toggle a quente). Lê process.env direto, mesmo padrão
 * dos gates de flag do router.
 */
const blocklist = parseBlocklist(process.env.BOT_BLOCKLIST_NUMBERS);

/**
 * true se o telefone (dígitos do extractPhone) está na blocklist de números internos.
 * Compara dígitos crus E forma canônica dos dois lados (tolera 9º dígito BR).
 */
export function isBlockedNumber(telefone: string): boolean {
  const digits = (telefone ?? '').replace(/\D/g, '');
  if (digits.length < 8) return false;
  if (blocklist.has(digits)) return true;
  const canon = canonicalE164(digits);
  return canon != null && blocklist.has(canon);
}

/** Exposto só para teste — reconstrói o Set a partir de um valor de env arbitrário. */
export function __buildBlocklistForTest(rawEnv: string | undefined): (telefone: string) => boolean {
  const set = parseBlocklist(rawEnv);
  return (telefone: string): boolean => {
    const digits = (telefone ?? '').replace(/\D/g, '');
    if (digits.length < 8) return false;
    if (set.has(digits)) return true;
    const canon = canonicalE164(digits);
    return canon != null && set.has(canon);
  };
}
