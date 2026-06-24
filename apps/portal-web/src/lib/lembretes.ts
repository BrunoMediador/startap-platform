/**
 * Lógica pura da config de Lembretes (testável, sem React/DOM).
 *
 * O dono liga/desliga o lembrete automático de agendamento e escolhe QUANDO enviar
 * (uma ou mais janelas, em minutos antes do horário). O worker que ENVIA é backend
 * (PR companheiro); aqui é só a UI de configuração.
 *
 * CONTRATO CONGELADO (backend em paralelo; se divergir, QA reconcilia):
 *   GET   /portal/lembretes -> { enabled: boolean, windows_min: number[] }
 *   PATCH /portal/lembretes body { enabled?, windows_min? } -> estado novo.
 *   Janelas permitidas: 1440 (24h), 180 (3h), 120 (2h), 60 (1h).
 *
 * Tudo aqui normaliza pra esse contrato: descarta janelas fora da lista, deduplica e
 * ordena DESC (a mais distante primeiro — "24h" antes de "1h"), que é também a ordem
 * em que os chips aparecem.
 */
import type { LembretesConfig } from './api-types';

/** Janelas permitidas (minutos antes do agendamento), na ORDEM de exibição (DESC). */
export const JANELAS_PERMITIDAS = [1440, 180, 120, 60] as const;

export type JanelaMin = (typeof JANELAS_PERMITIDAS)[number];

/** Rótulo curto pra cada janela ("24h antes", "1h antes"). */
export const JANELA_LABEL: Record<JanelaMin, string> = {
  1440: '24h antes',
  180: '3h antes',
  120: '2h antes',
  60: '1h antes',
};

/** Default sugerido quando o dono liga sem ter escolhido nada: 24h + 2h. */
export const DEFAULT_WINDOWS: JanelaMin[] = [1440, 120];

const PERMITIDAS_SET = new Set<number>(JANELAS_PERMITIDAS);

export function isJanelaPermitida(min: number): min is JanelaMin {
  return PERMITIDAS_SET.has(min);
}

/**
 * Normaliza uma lista crua de janelas: mantém só as permitidas, deduplica e ordena
 * DESC (segue JANELAS_PERMITIDAS). Usado tanto na entrada (resposta do backend pode
 * vir fora de ordem / com lixo) quanto na saída (payload do PATCH).
 */
export function normalizeWindows(windows: readonly number[] | null | undefined): JanelaMin[] {
  if (!windows) return [];
  const presentes = new Set(windows.filter(isJanelaPermitida));
  return JANELAS_PERMITIDAS.filter((j) => presentes.has(j));
}

/** Estado de UI: enabled + janelas já normalizadas (ordenadas, sem lixo/duplicata). */
export interface LembretesDraft {
  enabled: boolean;
  windows: JanelaMin[];
}

/** Resposta crua do backend -> draft de UI. Tolera campos ausentes/sujos. */
export function toLembretesDraft(data: LembretesConfig | null | undefined): LembretesDraft {
  return {
    enabled: data?.enabled === true,
    windows: normalizeWindows(data?.windows_min),
  };
}

/** Liga/desliga uma janela específica no draft, mantendo a ordem canônica. */
export function toggleWindow(draft: LembretesDraft, janela: JanelaMin): LembretesDraft {
  const tem = draft.windows.includes(janela);
  const next = tem
    ? draft.windows.filter((j) => j !== janela)
    : normalizeWindows([...draft.windows, janela]);
  return { ...draft, windows: next };
}

/**
 * Liga/desliga o lembrete inteiro. Ao LIGAR sem nenhuma janela marcada, semeia o
 * default (24h + 2h) — senão o dono ligaria e não receberia nada. Desligar preserva
 * as janelas escolhidas (volta no mesmo estado se religar antes de salvar).
 */
export function setEnabled(draft: LembretesDraft, enabled: boolean): LembretesDraft {
  if (enabled && draft.windows.length === 0) {
    return { enabled: true, windows: [...DEFAULT_WINDOWS] };
  }
  return { ...draft, enabled };
}

/** Compara dois drafts (ordem já é canônica, então igualdade posicional basta). */
export function isLembretesDirty(a: LembretesDraft, b: LembretesDraft): boolean {
  if (a.enabled !== b.enabled) return true;
  if (a.windows.length !== b.windows.length) return true;
  return a.windows.some((j, i) => j !== b.windows[i]);
}

/**
 * O draft é VÁLIDO pra salvar?
 *   - desligado: sempre ok (windows ignoradas; o que vale é enabled=false).
 *   - ligado: precisa de pelo menos UMA janela (ligar sem janela = não envia nada).
 */
export function isLembretesValido(draft: LembretesDraft): boolean {
  return !draft.enabled || draft.windows.length > 0;
}

/**
 * Draft -> body do PATCH. Sempre manda os dois campos (o backend aceita parcial, mas
 * mandar o estado completo evita ambiguidade entre "limpar" e "não tocar"). Quando
 * desligado, ainda envia as janelas escolhidas pra preservá-las do lado do servidor.
 */
export function toLembretesPatch(draft: LembretesDraft): {
  enabled: boolean;
  windows_min: number[];
} {
  return { enabled: draft.enabled, windows_min: [...draft.windows] };
}
