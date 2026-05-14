/**
 * renderPrompt: carrega prompt do banco (com cache em bot_prompt) e substitui placeholders {key}.
 *
 * Se não existe prompt no banco, usa o `fallback` recebido como argumento (defaults dos bots).
 *
 * Placeholders simples: `{nome}`, `{telefone}`, `{data_atual}` etc.
 */
import { botPrompt } from '@startap/db';

export interface RenderOpts {
  slot: string;
  fallback: string;
  vars?: Record<string, string>;
}

function applyVars(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : `{${key}}`;
  });
}

export async function renderPrompt(opts: RenderOpts): Promise<string> {
  const stored = await botPrompt.getPrompt(opts.slot).catch(() => null);
  const tpl = stored ?? opts.fallback;
  return applyVars(tpl, opts.vars ?? {});
}
