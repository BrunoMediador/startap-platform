import { logger } from '@startap/core/logger';
import { ConfigSchema } from './config.schema.js';

export { ConfigSchema } from './config.schema.js';
export type { Config } from './config.schema.js';

const log = logger.child({ service: 'portal-api' });

// parse no boot — lanca ZodError com campo(s) ausente(s) antes de qualquer request.
export const config = (() => {
  const result = ConfigSchema.safeParse(process.env);
  if (!result.success) {
    log.error(
      { issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      'Config invalido — verifique as variaveis de ambiente',
    );
    throw result.error;
  }
  return result.data;
})();
