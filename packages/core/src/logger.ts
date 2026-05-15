import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  base: { service: process.env.SERVICE_NAME ?? 'unknown' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

/** Cria child logger com bindings extras (ex: por bot, por sessão). */
export function child(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
