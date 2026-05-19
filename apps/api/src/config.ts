import { ConfigSchema } from './config.schema.js';

export { ConfigSchema } from './config.schema.js';
export type { Config } from './config.schema.js';

// parse no boot — lança ZodError com campo(s) ausente(s) antes de qualquer request
export const config = (() => {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.error('Config inválido — verifique as variáveis de ambiente:\n', result.error.format());
    throw result.error;
  }
  return result.data;
})();
