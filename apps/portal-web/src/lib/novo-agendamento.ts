/**
 * Lógica pura da tela Novo agendamento (Missão 020 F4, Fluxo B do doc
 * docs/missoes/020-ux-onboarding-e-agendamento-manual.md).
 *
 * Tudo aqui é função pura e testável (padrão lib/servicos.ts):
 *   - buildDayStrip: os 14 dias do DayStrip (Hoje/Amanhã/dia da semana), com
 *     `fechado` derivado da grade /portal/horarios (dia ausente = fechado —
 *     mesma regra de lib/horarios.ts). Sem a grade carregada, nada é
 *     desabilitado: o GET /portal/agenda/slots responde `aberto:false` e a
 *     tela mostra "fechado nesse dia".
 *   - máscara/validação do form (nome obrigatório, WhatsApp opcional BR).
 *   - formatação do resumo vivo ("sáb 14/06", "10:00–10:30").
 */
import type { CriarAgendamentoBody, DiaSemana, Horarios, ProductType } from './api-types';

/** Quantos dias o DayStrip mostra (spec B3: hoje + 13). */
export const DIAS_STRIP = 14;

/** Date.getDay() (0=domingo…6=sábado) → chave canônica do contrato /portal/horarios. */
const GETDAY_TO_DIA: DiaSemana[] = [
  'domingo',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado',
];

/** Rótulos curtos por Date.getDay() — fixos (sem depender do ICU do runtime). */
const WD_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WD_LONGO = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

export interface DiaStrip {
  /** 'YYYY-MM-DD' local — vai direto na query do GET /portal/agenda/slots. */
  dateKey: string;
  /** 'Hoje' | 'Amanhã' | 'Sex' (dia da semana curto). */
  label: string;
  /** Número do dia do mês (ex.: 14). */
  diaNum: number;
  /** Acessibilidade: "sexta, 13 de junho". */
  longo: string;
  /** Dia sem expediente na grade de Horários — pill desabilitada. */
  fechado: boolean;
}

/** 'YYYY-MM-DD' do dia LOCAL (não UTC — o tenant opera em hora de parede). */
export function dateKeyLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** True se o dia está fechado na grade (ausente OU fechado OU sem abre/fecha). */
function diaFechado(horarios: Horarios, dia: DiaSemana): boolean {
  const h = horarios[dia];
  if (!h) return true; // dia ausente = fechado (lib/horarios.ts)
  return h.fechado || h.abre == null || h.fecha == null;
}

/**
 * Os 14 dias do strip a partir de hoje. `horarios` undefined (query pendente ou
 * com erro) → nenhum dia desabilitado (o backend ainda valida no GET/POST).
 */
export function buildDayStrip(horarios: Horarios | undefined, now = new Date()): DiaStrip[] {
  const dias: DiaStrip[] = [];
  for (let i = 0; i < DIAS_STRIP; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const wd = d.getDay();
    const label = i === 0 ? 'Hoje' : i === 1 ? 'Amanhã' : WD_CURTO[wd];
    dias.push({
      dateKey: dateKeyLocal(d),
      label,
      diaNum: d.getDate(),
      longo: `${WD_LONGO[wd]}, ${d.getDate()} de ${MESES[d.getMonth()]}`,
      fechado: horarios ? diaFechado(horarios, GETDAY_TO_DIA[wd]) : false,
    });
  }
  return dias;
}

/** "sáb, 14 de junho" — cabeçalho da grade de horários livres. */
export function formatDiaExtenso(dateKey: string): string {
  const d = parseDateKey(dateKey);
  if (!d) return dateKey;
  return `${WD_LONGO[d.getDay()].slice(0, 3)}, ${d.getDate()} de ${MESES[d.getMonth()]}`;
}

/** "sáb 14/06" — resumo vivo e toast de sucesso. */
export function formatDiaCurto(dateKey: string): string {
  const d = parseDateKey(dateKey);
  if (!d) return dateKey;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${WD_LONGO[d.getDay()].slice(0, 3)} ${dd}/${mm}`;
}

/** 'YYYY-MM-DD' → Date local (meia-noite). null se inválido. */
function parseDateKey(dateKey: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'HH:mm' + duração → 'HH:mm' (wrap em 24h só por segurança; backend valida a janela). */
export function addMinutosHora(hora: string, minutos: number): string {
  const [h, m] = hora.split(':').map(Number);
  const total = (((h * 60 + m + minutos) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

// ── Form do cliente (nome obrigatório + WhatsApp opcional) ────────────────────

/** Só os dígitos, cap em 11 (DDD + 9 dígitos — celular BR). */
export function telefoneDigits(input: string): string {
  return input.replace(/\D/g, '').slice(0, 11);
}

/**
 * Máscara BR progressiva pra digitação: "(11) 99999-9999" (celular, 11 dígitos)
 * ou "(11) 9999-9999" (fixo, 10). Aceita colar com pontuação.
 */
export function formatPhoneBR(input: string): string {
  const d = telefoneDigits(input);
  if (d.length === 0) return '';
  if (d.length <= 2) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export interface NovoAgendamentoDraft {
  nome: string;
  /** Telefone como exibido (mascarado) — a validação extrai os dígitos. */
  telefone: string;
}

export interface NovoAgendamentoErrors {
  nome?: string;
  telefone?: string;
}

export interface NovoAgendamentoCliente {
  cliente_nome: string;
  /** DDI 55 + DDD + número (formato que o bot grava no título do evento). */
  cliente_telefone?: string;
}

/**
 * Valida o bloco Cliente do form. Espelha o criarAgendamentoSchema do backend:
 * nome obrigatório (<=80), telefone opcional com 10-11 dígitos BR — enviado com
 * DDI 55 na frente pra casar com o formato que o robô usa nos títulos de evento
 * ("Nome - Serviço | WhatsApp: 5511…"), permitindo reconhecer o cliente depois.
 */
export function validateNovoAgendamento(
  d: NovoAgendamentoDraft,
): { ok: true; value: NovoAgendamentoCliente } | { ok: false; errors: NovoAgendamentoErrors } {
  const errors: NovoAgendamentoErrors = {};
  const nome = d.nome.trim();
  if (nome.length === 0) errors.nome = 'Diga o nome do cliente';
  else if (nome.length > 80) errors.nome = 'Nome muito longo (máx. 80 letras)';

  const digits = telefoneDigits(d.telefone);
  if (digits.length > 0 && digits.length < 10) {
    errors.telefone = 'Confere o número? Faltou dígito';
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      cliente_nome: nome,
      ...(digits.length > 0 ? { cliente_telefone: `55${digits}` } : {}),
    },
  };
}

// ── Profissional (só estabelecimento) ────────────────────────────────────────

/**
 * Monta o body do POST /portal/agendamentos casando com o gating do backend.
 *
 *  - estabelecimento: `colaborador_id` é OBRIGATÓRIO. Sem ele o backend responde
 *    422 colaborador_obrigatorio, então travamos antes e devolvemos o erro do
 *    seletor de profissional.
 *  - individual/SOLO: `colaborador_id` NUNCA é enviado (1 agenda só) — o body sai
 *    byte-a-byte igual ao de hoje.
 *
 * Função pura/testável (não conhece React) — a tela só decide produto/seleção.
 */
export function buildCriarAgendamentoBody(args: {
  productType: ProductType;
  base: { servico: string; data: string; hora: string } & NovoAgendamentoCliente;
  colaboradorId: number | null;
}): { ok: true; body: CriarAgendamentoBody } | { ok: false; error: 'colaborador_obrigatorio' } {
  const { productType, base, colaboradorId } = args;
  if (productType === 'estabelecimento') {
    if (colaboradorId == null) return { ok: false, error: 'colaborador_obrigatorio' };
    return { ok: true, body: { ...base, colaborador_id: colaboradorId } };
  }
  // individual: nunca manda colaborador_id (comportamento de hoje preservado).
  return { ok: true, body: { ...base } };
}
