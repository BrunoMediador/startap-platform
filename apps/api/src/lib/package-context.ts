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
import { type ClientPackageCredit, packages } from '@startap/db';

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
    const base = `${c.nome} — ${coberturaLabel(c)} (${escopoLabel(c)})`;
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
  ].join('\n');
}
