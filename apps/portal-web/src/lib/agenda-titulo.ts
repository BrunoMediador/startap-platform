/**
 * Parser do `titulo` do agendamento (Bloco B — nomes legíveis).
 *
 * O robô grava o evento no Google Calendar com um título concatenado no padrão
 *   "Nome do cliente - Serviço | WhatsApp: 5511999990000"
 * onde " - " separa nome/serviço e " | WhatsApp: " prefixa o telefone (DDI 55).
 * Nem todo evento segue o padrão à risca (agendamentos antigos, criados na mão
 * sem WhatsApp, ou títulos digitados livres no GCal). Por isso o parse é
 * TOLERANTE: o que não casar vira fallback na string crua, sem nunca quebrar.
 *
 * Regras (na ordem):
 *   1. Recorta o sufixo " | WhatsApp: <tel>" (case-insensitive) -> `telefone`.
 *      O telefone fica só com dígitos; "" se ausente/sem dígitos.
 *   2. No que sobrou, o PRIMEIRO " - " separa nome (esquerda) de serviço
 *      (direita). " - " adicionais ficam no serviço (ex.: "Corte - degradê").
 *   3. Sem " - ": tudo vira `nome`, `servico` = "" (ex.: título livre).
 *
 * Tudo aqui é função pura e testável (padrão lib/novo-agendamento.ts).
 */

export interface TituloAgendamento {
  /** Nome do cliente (sempre presente; no pior caso = título cru sem o telefone). */
  nome: string;
  /** Serviço, ou "" quando o título não traz o separador " - ". */
  servico: string;
  /** Só dígitos (com DDI quando o robô gravou); "" quando ausente. */
  telefone: string;
  /** O título original, intacto — usado como `title=`/tooltip e fallback de leitura. */
  raw: string;
}

/** Marcador do telefone no título do robô (case-insensitive, espaços tolerados). */
const WHATSAPP_RE = /\s*\|\s*whatsapp:\s*(.*)$/i;
const SEP_NOME_SERVICO = ' - ';

/**
 * Quebra o `titulo` em nome + serviço + telefone. Tolerante a formatos fora do
 * padrão: nunca lança e sempre devolve um `nome` não-vazio quando há texto.
 */
export function parseTitulo(titulo: string | null | undefined): TituloAgendamento {
  const raw = (titulo ?? '').trim();
  if (raw === '') {
    return { nome: 'Sem nome', servico: '', telefone: '', raw: '' };
  }

  // 1) Recorta o sufixo do WhatsApp (se houver) e extrai só os dígitos.
  let resto = raw;
  let telefone = '';
  const wpp = WHATSAPP_RE.exec(raw);
  if (wpp) {
    telefone = (wpp[1] ?? '').replace(/\D/g, '');
    resto = raw.slice(0, wpp.index).trim();
  }

  // 2) Primeiro " - " separa nome | serviço; o resto do serviço fica intacto.
  const idx = resto.indexOf(SEP_NOME_SERVICO);
  if (idx === -1) {
    return { nome: resto || raw, servico: '', telefone, raw };
  }
  const nome = resto.slice(0, idx).trim();
  const servico = resto.slice(idx + SEP_NOME_SERVICO.length).trim();
  return { nome: nome || resto || raw, servico, telefone, raw };
}

/**
 * Iniciais a partir do título já parseado (usa o NOME, não a string concatenada,
 * pra não pegar a 1a letra do serviço/telefone como "sobrenome"). Até 2 letras.
 */
export function inicialDoTitulo(titulo: string | null | undefined): string {
  const { nome, raw } = parseTitulo(titulo);
  if (raw === '') return '?'; // título realmente vazio (não o placeholder "Sem nome")
  const parts = nome.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
