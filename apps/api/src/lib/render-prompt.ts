import { logger } from '@startap/core/logger';
/**
 * renderPrompt: carrega prompt do banco (bot_prompt) e substitui placeholders {key}.
 *
 * O prompt vem EXCLUSIVAMENTE do banco. Se o slot não tiver prompt cadastrado,
 * lança erro explícito — o bot não deve responder ao cliente nesse caso.
 * NÃO há fallback para template hardcoded em código (decisão Bruno 2026-05-21).
 *
 * Placeholders simples: `{nome}`, `{telefone}`, `{data_atual}` etc.
 */
import { botPrompt } from '@startap/db';

export interface RenderOpts {
  slot: string;
  vars?: Record<string, string>;
}

function applyVars(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{${key}}`;
  });
}

export async function renderPrompt(opts: RenderOpts): Promise<string> {
  const stored = await botPrompt.getPrompt(opts.slot).catch((err: unknown) => {
    logger.error({ err, slot: opts.slot }, 'renderPrompt: falha ao buscar prompt do banco');
    throw new Error(
      `Prompt do slot "${opts.slot}" não pôde ser carregado do banco. Cadastre no painel antes de usar.`,
    );
  });
  if (!stored) {
    throw new Error(
      `Prompt do slot "${opts.slot}" não foi encontrado no banco. Cadastre no painel antes de usar.`,
    );
  }
  return applyVars(stored, opts.vars ?? {});
}
