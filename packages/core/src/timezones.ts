/**
 * Validação de fuso horário (IANA) por clone — follow-up da migration 068.
 *
 * A ENGINE de fuso já roda em prod (flow_clones.timezone TEXT NOT NULL DEFAULT
 * 'America/Sao_Paulo' é lida em free-slots/atendimentos/GCal/lembretes; o bot
 * reancora wall-time no fuso do clone). O que faltava era o VALIDADOR no ponto
 * de escrita — a migration 068 anotou "validada NO APP" mas o validador nunca
 * foi escrito. Esta é a fonte única (signup + perfil + gestão consomem daqui).
 *
 * Decisão do Bruno (2026-07-01): fuso do mundo inteiro disponível; DEFAULT
 * 'America/Sao_Paulo'; fonte da verdade de validade = Intl.supportedValuesOf
 * ('timeZone') (Node 20+). Rejeitar qualquer coisa fora desse conjunto. Guardar
 * SEMPRE o nome IANA canônico — nunca offset cru.
 *
 * INVARIANTE DURA: clone que NÃO enviar timezone continua 'America/Sao_Paulo'
 * -> byte-idêntico ao comportamento de hoje (o schema faz .default(SP)).
 */
import { z } from 'zod';

/** Default carimbado pela migration 068 em todo clone existente. */
export const DEFAULT_TIMEZONE = 'America/Sao_Paulo';

/**
 * Conjunto memoizado das timezones IANA suportadas pelo runtime. `Intl
 * .supportedValuesOf` existe no Node 20+ (nosso runtime). O `?? []` é guarda
 * defensiva: se um runtime não suportar, `isValidIanaTimezone` degrada pra
 * "tudo inválido" em vez de crashar no boot (nunca deixa passar offset cru).
 */
let _tzSet: ReadonlySet<string> | null = null;
function supportedTimezones(): ReadonlySet<string> {
  if (_tzSet === null) {
    const values =
      typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    _tzSet = new Set(values);
  }
  return _tzSet;
}

/**
 * `true` só se `tz` é uma string que bate EXATAMENTE com um nome IANA suportado
 * (ex.: 'America/Sao_Paulo', 'America/Cuiaba'). Case-sensitive de propósito — a
 * lista IANA é canônica; 'america/cuiaba' ou 'UTC-3' são rejeitados.
 */
export function isValidIanaTimezone(tz: unknown): tz is string {
  return typeof tz === 'string' && supportedTimezones().has(tz);
}

/**
 * Schema Zod do fuso: DEFAULT 'America/Sao_Paulo' quando ausente (undefined) e
 * REJEITA qualquer valor fora do conjunto IANA suportado com a mensagem
 * `timezone_invalido` (o caller mapeia pra HTTP 400). Guarda SEMPRE o nome IANA.
 */
export const timezoneSchema = z
  .string({ invalid_type_error: 'timezone_invalido' })
  .refine(isValidIanaTimezone, { message: 'timezone_invalido' })
  .default(DEFAULT_TIMEZONE);
