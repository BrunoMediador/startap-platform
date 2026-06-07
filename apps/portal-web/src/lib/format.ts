/**
 * Helpers de formatacao pt-BR. Centralizados pra copy consistente com a spec
 * (secao 3): preco "R$ 50,00", telefone mascarado "(11) 9••••-••42", datas
 * "18 de junho", duracao "30 min", tempo relativo "há 2 dias".
 */

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

/** Centavos -> "R$ 50,00". */
export function formatPrecoCents(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

/** "50,00" (string editavel) -> centavos inteiros. Aceita "50", "50.5", "1.234,50". */
export function parsePrecoToCents(input: string): number | null {
  const cleaned = input.trim().replace(/\s/g, '').replace(/r\$/i, '');
  if (cleaned === '') return null;
  // Remove separador de milhar e normaliza virgula decimal.
  const normalized = cleaned.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100);
}

/** "30 min" / "1h" / "1h30". */
export function formatDuracao(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h}h` : `${h}h${String(rest).padStart(2, '0')}`;
}

/** Iniciais de um nome (ate 2 letras). Fallback '?' se vazio. */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Mascara um telefone (apenas digitos) no formato "(11) 9••••-••42".
 * Mostra DDD + os 2 ultimos digitos; o meio vira bullets. LGPD-friendly na UI.
 */
export function maskPhoneDisplay(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  // Remove DDI 55 quando presente (numero BR).
  const local = digits.length > 11 && digits.startsWith('55') ? digits.slice(2) : digits;
  if (local.length < 4) return raw;
  const ddd = local.slice(0, 2);
  const last2 = local.slice(-2);
  const middleLen = Math.max(local.length - 4, 0);
  // Quebra os bullets em dois blocos pra lembrar o formato 9XXXX-XXXX.
  const firstBlock = '•'.repeat(Math.max(middleLen - 2, 1));
  return `(${ddd}) 9${firstBlock}-••${last2}`;
}

/** "YYYY-MM-DD" -> "18 de junho". Retorna null se invalido. */
export function formatDueDate(isoDate: string | null): string | null {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const day = Number(m[3]);
  const monthIdx = Number(m[2]) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return `${day} de ${MESES[monthIdx]}`;
}

/** ISO -> "14:30". */
export function formatHora(iso: string | null): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** ISO -> "hoje" / "amanhã" / "12/06". Comparacao por dia local. */
export function formatDiaRelativo(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(d) - startOf(now)) / 86_400_000);
  if (diffDays === 0) return 'hoje';
  if (diffDays === 1) return 'amanhã';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/**
 * Tempo decorrido desde `iso` ate agora, em pt-BR curto:
 * "agora", "há 5 min", "há 3 h", "há 2 dias", "ontem".
 */
export function formatHaTempo(iso: string | null): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'ontem';
  return `há ${days} dias`;
}

/** "Pausado há 2 dias" a partir do updated_at da pausa. */
export function formatPausadoHa(iso: string): string {
  const ha = formatHaTempo(iso);
  if (ha === 'agora') return 'Pausado agora';
  if (ha === 'ontem') return 'Pausado ontem';
  return `Pausado ${ha}`;
}

/** Saudacao por hora local: Bom dia / Boa tarde / Boa noite. */
export function saudacao(date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return 'Bom dia';
  if (h < 18) return 'Boa tarde';
  return 'Boa noite';
}
