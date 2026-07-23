/**
 * /portal/cartao-config — customização do CARTÃO DE CONFIRMAÇÃO montado em RUNTIME
 * (SCRUM-92 inc.2 / ADR 0032). O dono escolhe TEMPLATE + EMOJIS do cartão que o bot manda
 * antes de marcar. Grava flow_clones.cartao_config (JSONB { template, emojis }).
 *
 * GATE (gate DUPLO, casa o bot): `mode='runtime'` só é exposto quando o kill-switch GLOBAL
 * CARTAO_RUNTIME_ENABLED está ON **E** o clone tem cartao_mode='runtime'. Fora disso → mode='baked'
 * (a UI parada some a seção). PUT só é aceito em modo runtime efetivo (senão 409) — não se
 * customiza um cartão que não está ativo.
 *
 * SEGURANÇA (decisão do security): emoji = ALLOWLIST FECHADA de code points por chave
 * (validateCartaoEmojis: NFC + sequência inteira contra o catálogo — rejeita tag chars/fora do
 * set). `template` = enum fechado. slot SEMPRE da SESSÃO (withTenant) — nunca do body (anti-IDOR).
 *
 * SEED (refinamento Bruno 23/07): clone MIGRADO tem cartao_config.verbatim (cartão legado). O GET
 * pré-preenche o picker com os emojis EXTRAÍDOS desse cartão (extractSeedEmojis) — se o dono não
 * mexer, fica idêntico; se editar, o PUT grava { template, emojis } SEM verbatim → vira o cartão
 * montado com a escolha dele (mudança que ELE pediu).
 *
 * Contrato (casa com apps/portal-web/src/lib/cartao-config.ts):
 *   GET  -> { mode, config:{template,emojis}|null, defaults:{template,emojis}, canDisable:false, preview }
 *   PUT { template, emojis } -> mesmo shape + preview (buildCartaoRuntimeBlock renderizado).
 */
import { cloneColaboradores } from '@startap/db';
// Subpath (não o barrel @startap/integrations): puxa SÓ o módulo puro do cartão, sem instanciar
// o cliente OpenAI (que o barrel carrega no import). Mesmo padrão do apps/api/bots/teste_barbearia.
import * as promptBuilder from '@startap/integrations/prompt-builder';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { requireTenant, withTenant } from '../lib/tenant.js';

// Body do PUT: template obrigatório (enum fechado) + emojis parcial (validado contra a allowlist
// FECHADA no handler, NÃO por regex/grapheme). .strict() → chave desconhecida = 400 (anti
// mass-assignment). emojis é `record` cru aqui; a allowlist real é validateCartaoEmojis.
const putSchema = z
  .object({
    template: z.enum(['padrao', 'compacto', 'detalhado']),
    emojis: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type Modo = 'agenda' | 'estabelecimento';

/** Resolve o modo do cartão a partir do product_type do clone (individual → agenda). */
async function resolveModo(slot: string): Promise<Modo> {
  const productType = await cloneColaboradores.getProductType(slot);
  return productType === 'estabelecimento' ? 'estabelecimento' : 'agenda';
}

/**
 * Monta o payload do contrato (GET e PUT compartilham). `effectiveMode` já resolvido pelo caller
 * (gate DUPLO). Deriva defaults por área, a config efetiva (com SEED do verbatim de clone migrado)
 * e o preview via buildCartaoRuntimeBlock com a config ATUAL do clone.
 */
function buildPayload(args: {
  effectiveMode: 'baked' | 'runtime';
  modo: Modo;
  area: string | null;
  nomeNegocio: string | null;
  cartaoConfig: {
    template?: 'padrao' | 'compacto' | 'detalhado';
    emojis?: Record<string, string>;
    verbatim?: string;
  } | null;
}): Record<string, unknown> {
  const { effectiveMode, modo, area, nomeNegocio, cartaoConfig } = args;
  const defaultsEmojis = promptBuilder.resolveDefaultCartaoEmojis(modo, area);
  const defaults = { template: 'padrao' as const, emojis: defaultsEmojis };

  // config efetiva pro picker: null quando o clone não tem config. Clone MIGRADO (verbatim) →
  // SEED os emojis do cartão legado (extractSeedEmojis) pra pré-preencher o picker.
  let configOut: { template: string; emojis: Record<string, string> } | null = null;
  if (cartaoConfig) {
    const template = cartaoConfig.template ?? 'padrao';
    const seed =
      typeof cartaoConfig.verbatim === 'string' && cartaoConfig.verbatim.trim() !== ''
        ? promptBuilder.extractSeedEmojis(cartaoConfig.verbatim)
        : (cartaoConfig.emojis ?? {});
    configOut = { template, emojis: { ...defaultsEmojis, ...seed } };
  }

  // preview = o cartão que o RUNTIME emitiria pra este clone AGORA (verbatim se migrado, senão
  // montado da config; sem config → defaults por área). É o texto real do bloco (contrato).
  const preview = promptBuilder.buildCartaoRuntimeBlock({
    modo,
    area,
    config: cartaoConfig,
    nomeNegocio: nomeNegocio ?? undefined,
  });

  return { mode: effectiveMode, config: configOut, defaults, canDisable: false, preview };
}

export const portalCartaoConfigRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portal/cartao-config', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const { area, cartaoMode, cartaoConfig, nomeNegocio } =
      await cloneColaboradores.getAreaPromptCustomCartao(slot);
    // Gate DUPLO (casa o bot): runtime só quando a flag GLOBAL está ON E a coluna é 'runtime'.
    const effectiveMode: 'baked' | 'runtime' =
      config.CARTAO_RUNTIME_ENABLED && cartaoMode === 'runtime' ? 'runtime' : 'baked';
    const modo = await resolveModo(slot);
    return reply
      .code(200)
      .send(buildPayload({ effectiveMode, modo, area, nomeNegocio, cartaoConfig }));
  });

  app.put('/portal/cartao-config', { preHandler: withTenant }, async (req, reply) => {
    const { slot } = requireTenant(req);
    const parsed = putSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'dados_invalidos' });

    // Allowlist FECHADA de emoji (NFC + sequência inteira). Fora do catálogo / chave desconhecida
    // → 400 com a chave ofensora (a UI não deveria chegar aqui; é a 2ª trava, server-side).
    const emojiCheck = promptBuilder.validateCartaoEmojis(parsed.data.emojis);
    if (!emojiCheck.ok) {
      return reply.code(400).send({ error: 'emoji_invalido', campo: emojiCheck.invalidKey });
    }

    const { area, cartaoMode, nomeNegocio } =
      await cloneColaboradores.getAreaPromptCustomCartao(slot);
    const effectiveMode: 'baked' | 'runtime' =
      config.CARTAO_RUNTIME_ENABLED && cartaoMode === 'runtime' ? 'runtime' : 'baked';
    // Não se customiza um cartão que não está ativo em runtime (evita gravar config morta e
    // dá sinal claro à UI). Clone baked (ou flag global OFF) → 409.
    if (effectiveMode !== 'runtime') {
      return reply.code(409).send({ error: 'cartao_baked' });
    }

    // Edição do dono = cartão MONTADO com a escolha dele: grava { template, emojis } SEM verbatim
    // (dropa o legado — mudança que ELE pediu). setCartaoConfigBySlot é escopado ao slot da SESSÃO.
    const novaConfig = { template: parsed.data.template, emojis: emojiCheck.emojis };
    const ok = await cloneColaboradores.setCartaoConfigBySlot(slot, novaConfig);
    if (!ok) return reply.code(404).send({ error: 'fluxo nao encontrado' });

    const modo = await resolveModo(slot);
    return reply.code(200).send(
      buildPayload({
        effectiveMode,
        modo,
        area,
        nomeNegocio,
        cartaoConfig: novaConfig,
      }),
    );
  });
};
