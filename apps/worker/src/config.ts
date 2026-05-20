import { z } from 'zod';

const WorkerConfigSchema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.string().default('info'),
  SERVICE_NAME: z.string().optional(),

  CHAT_MEMORY_RETENTION: z.coerce.number().int().positive().default(30),
  CHAT_STALE_RUNNING_MAX_MINUTES: z.coerce.number().int().positive().default(30),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export const config = WorkerConfigSchema.parse(process.env);
