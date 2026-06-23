// package-context — leitura read-only de pacotes do cliente para o bot
// (ADR 0025, pacotes de serviço — BLOCO 2a). Read-only de ponta a ponta.
//
// Faz duas coisas, ambas SEM escrever em lugar nenhum:
//  1. resolveClientPackages(slot, telefone) — hasheia o telefone com o pepper
//     PRÓPRIO de pacotes (packagePhoneHmac, lazy) e devolve os créditos do cliente
//     já calculados server-side (saldo/validade/cobertura/escopo, com estados
//     EXPIRADO/ESGOTADO explícitos). Usado pela tool consultar_pacote E pela
//     injeção do bloco [SEU PACOTE].
//  2. buildSeuPacoteBlock(credits) — monta o bloco de prompt [SEU PACOTE] em texto
//     pronto (o LLM nunca raciocina saldo: lê a linha pronta).
//
// GATE: o CHAMADOR (o bot) só invoca isto quando config.PACOTES_ENABLED === true.
// Com a flag OFF, nada aqui é alcançado — o bot é byte-a-byte o de hoje.
//
// FAIL-SAFE / LGPD: o telefone cru nunca é logado nem retornado; só entra como
// canônico para virar HMAC. Se o pepper de pacotes não está configurado
// (PackagePepperMissingError, validação LAZY — lição #247), degrada para "sem
// pacote" (lista vazia) e loga só um aviso — NUNCA derruba o atendimento.
import { PackagePepperMissingError, packagePhoneHmac } from '@startap/core';
import { logger } from '@startap/core/logger';
import { canonicalE164 } from '@startap/core/phone';
import { type ClientPackageCredit, type RedeemResult, packages } from '@startap/db';

const log = logger.child({ module: 'package-context' });

/**
 * Resolve os pacotes de um cliente (por telefone) num slot. READ-ONLY.
 * `apenasAtivos` (default true) filtra para os créditos utilizáveis; passe false
 * para também listar EXPIRADO/ESGOTADO (o bloco de prompt usa isso para informar
 * "seu pacote expirou em DD/MM").
 *
 * Degrada para [] sem lançar quando: telefone inválido / pepper ausente / erro de DB.
 */
export async function resolveClientPackages(input: {
  slot: string;
  telefone: string;
  apenasAtivos?: boolean;
}): Promise<ClientPackageCredit[]> {
  const apenasAtivos = input.apenasAtivos ?? true;

  const canonical = canonicalE164(input.telefone);
  if (!canonical) {
    // Telefone irrecuperável — sem identidade de pacote. Não loga o número.
    return [];
  }

  let phoneHmac: string;
  try {
    phoneHmac = packagePhoneHmac(canonical);
  } catch (err) {
    if (err instanceof PackagePepperMissingError) {
      // Pepper de pacotes não provisionado ainda → feature degrada para "sem pacote".
      // NÃO derruba o atendimento (lição #247). Só avisa uma vez por chamada.
      log.warn(
        { slot: input.slot },
        'PACKAGE_PHONE_PEPPER ausente — pacotes degradados para vazio (boot não crasha)',
      );
      return [];
    }
    throw err;
  }

  try {
    return apenasAtivos
      ? await packages.listActiveClientCredits({ slot: input.slot, phoneHmac })
      : await packages.listClientCredits({ slot: input.slot, phoneHmac });
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), slot: input.slot },
      'resolveClientPackages: leitura de pacotes falhou — degradando para vazio',
    );
    return [];
  }
}

function formatBR(dataISO: string): string {
  // 'YYYY-MM-DD' -> 'DD/MM/YYYY' sem Date (evita timezone shift).
  const [y, m, d] = dataISO.split('-');
  return d && m && y ? `${d}/${m}/${y}` : dataISO;
}

function escopoLabel(c: ClientPackageCredit): string {
  return c.colaborador_id === null
    ? 'vale com qualquer profissional'
    : 'só com o profissional definido';
}

function coberturaLabel(c: ClientPackageCredit): string {
  if (c.servicos_cobertos.length === 0) return 'sem serviços vinculados';
  return `cobre: ${c.servicos_cobertos.join(', ')}`;
}

/**
 * Formata preco_cents (do template do pacote) em 'R$ X,XX' pt-BR, sem libs (Intl pode variar
 * por runtime). NULL/ausente => '' (sem rótulo de preço). INFORMATIVO: é o preço do PACOTE
 * (caixa do barbeiro), NÃO mexe em client_billing/AbacatePay/MRR (ADR 0025 §5).
 */
function precoLabel(precoCents: number | null): string {
  if (precoCents == null || !Number.isFinite(precoCents)) return '';
  const reais = Math.trunc(precoCents / 100);
  const centavos = String(Math.abs(precoCents % 100)).padStart(2, '0');
  return `R$ ${reais},${centavos}`;
}

/**
 * Monta o bloco de prompt [SEU PACOTE] em texto pronto, com estados explícitos.
 * Recebe a lista COMPLETA (apenasAtivos=false) para poder informar expirado/esgotado.
 * Retorna '' (string vazia) se o cliente não tem nenhum pacote — o caller decide
 * não injetar o bloco nesse caso.
 *
 * O LLM NÃO calcula saldo: cada linha já vem decidida server-side.
 */
export function buildSeuPacoteBlock(credits: ClientPackageCredit[]): string {
  if (credits.length === 0) return '';

  const linhas = credits.map((c) => {
    const preco = precoLabel(c.preco_cents);
    const precoSuffix = preco ? ` [preço do pacote: ${preco}]` : '';
    const base = `${c.nome} — ${coberturaLabel(c)} (${escopoLabel(c)})${precoSuffix}`;
    switch (c.estado) {
      case 'ATIVO':
        return `- ${base}: ${c.sessoes_restantes} de ${c.sessoes_total} sessões restantes, válido até ${formatBR(c.data_expiracao)}.`;
      case 'EXPIRADO':
        return `- ${base}: EXPIRADO em ${formatBR(c.data_expiracao)} — NÃO pode ser usado.`;
      case 'ESGOTADO':
        return `- ${base}: ESGOTADO (0 sessões restantes) — NÃO pode ser usado.`;
      case 'CANCELADO':
        return `- ${base}: CANCELADO — NÃO pode ser usado.`;
    }
  });

  return [
    '[SEU PACOTE]',
    'Pacotes pré-pagos deste cliente (saldo já calculado — NÃO recalcule, apenas leia):',
    ...linhas,
    'Regras: só desconta sessão de pacote ATIVO que cobre o serviço pedido. ' +
      'Serviço fora da cobertura, ou pacote EXPIRADO/ESGOTADO, é atendimento avulso (não usa o pacote). ' +
      'Você NUNCA dá baixa no saldo — apenas informa; o desconto é feito pelo sistema ao agendar.',
    'Seja PROATIVO: quando o cliente pedir um serviço e tiver pacote ATIVO, NÃO decida sozinho. ' +
      'Se o serviço ESTÁ coberto, PERGUNTE antes de agendar: "Quer usar seu pacote (X de Y sessões, vence DD/MM) ou pagar avulso?". ' +
      'Se o serviço NÃO está coberto pelo pacote, avise que esse serviço fica avulso e ofereça o avulso. ' +
      'Quando o cliente perguntar quantas sessões tem, quando vence, o que cobre, ou quanto custou o pacote, ' +
      'responda com os números/data/preço já prontos acima — nunca invente nem recalcule.',
  ].join('\n');
}

/**
 * DEDUZ uma sessão de pacote para um agendamento JÁ criado no GCal (ADR 0025 BLOCO 2b).
 * Wrapper de packages.redeemForBooking que cuida do telefone -> HMAC (pepper PRÓPRIO,
 * canônico E.164) e DEGRADA com segurança: telefone inválido / pepper ausente / qualquer
 * erro -> "avulso" (não desconta) SEM lançar. O evento no GCal já existe; falha de pacote
 * NUNCA derruba o atendimento (lição #247).
 *
 * O SERVIDOR re-valida cobertura+saldo+validade dentro de redeemForBooking — `usaPacote`
 * é só a SUGESTÃO do LLM (cliente pode optar por pagar avulso); nunca FORÇA desconto.
 *
 * GATE: o chamador (o bot) só invoca isto com config.PACOTES_ENABLED === true. Telefone
 * cru nunca é logado nem retornado.
 */
export async function deduzirPacoteNoAgendamento(input: {
  slot: string;
  tenantId?: string;
  telefone: string;
  gcalEventId: string;
  servicoNome: string;
  colaboradorId?: number | null;
  usaPacote?: boolean;
}): Promise<RedeemResult> {
  const avulso: RedeemResult = {
    descontou_do_pacote: false,
    avulso: true,
    motivo: 'sem_pacote',
    sessoes_restantes: null,
  };

  const canonical = canonicalE164(input.telefone);
  if (!canonical) return avulso; // telefone irrecuperável — sem identidade de pacote.

  let phoneHmac: string;
  try {
    phoneHmac = packagePhoneHmac(canonical);
  } catch (err) {
    if (err instanceof PackagePepperMissingError) {
      log.warn(
        { slot: input.slot },
        'PACKAGE_PHONE_PEPPER ausente — dedução degrada para avulso (atendimento intacto)',
      );
      return { ...avulso, motivo: 'pepper_ausente' };
    }
    throw err;
  }

  try {
    const r = await packages.redeemForBooking({
      slot: input.slot,
      tenantId: input.tenantId,
      phoneHmac,
      gcalEventId: input.gcalEventId,
      servicoNome: input.servicoNome,
      colaboradorId: input.colaboradorId ?? null,
      usarPacote: input.usaPacote ?? true,
    });
    // Dívida cancelar+reagendar (ADR 0025 dívida 5): deixa rastro p/ job futuro quando descontou.
    if (r.descontou_do_pacote && r.credit_id != null) {
      packages.reconciliationHook({
        slot: input.slot,
        gcalEventId: input.gcalEventId,
        creditId: r.credit_id,
        servicoNome: input.servicoNome,
      });
    }
    return r;
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err), slot: input.slot },
      'deduzirPacoteNoAgendamento: dedução falhou — agenda avulso (atendimento intacto)',
    );
    return { ...avulso, motivo: 'erro' };
  }
}

/**
 * Extrai o nome do serviço do summary "Nome - Servico | WhatsApp: numero" como FALLBACK
 * quando o LLM não passar o param `servico` explicitamente. Determinístico, sem PII no log.
 * Retorna '' se não conseguir isolar (server re-valida cobertura: '' não cobre nada).
 */
export function servicoFromSummary(summary: string): string {
  // "Nome - Servico | WhatsApp: 5531..."  -> pega o trecho após o primeiro " - " e antes do " | ".
  const semWhats = summary.split('|')[0] ?? summary;
  const idx = semWhats.indexOf(' - ');
  if (idx < 0) return '';
  return semWhats.slice(idx + 3).trim();
}
