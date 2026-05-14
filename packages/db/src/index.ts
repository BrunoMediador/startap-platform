export * from './client.js';
export * as routing from './queries/routing.js';
export * as pausa from './queries/pausa.js';
export * as chatMemory from './queries/chat-memory.js';
export * as antibot from './queries/antibot.js';
export * as leads from './queries/leads.js';
export * as agendamento from './queries/agendamento.js';
export * as botConfig from './queries/bot-config.js';
export * as modelUsage from './queries/model-usage.js';

// Re-exporta tipos para import direto
export type { ChatTurn, Role } from './queries/chat-memory.js';
export type { RoutingRow } from './queries/routing.js';
export type { SuspectRow } from './queries/antibot.js';
export type { LeadRicardo } from './queries/leads.js';
export type { AgendamentoPendente } from './queries/agendamento.js';
export type { BotConfigRow, Provider } from './queries/bot-config.js';
export type { LogUsageInput, UsageSummaryRow } from './queries/model-usage.js';
