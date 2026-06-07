export * from './client.js';
export * as routing from './queries/routing.js';
export * as pausa from './queries/pausa.js';
export * as chatMemory from './queries/chat-memory.js';
export * as antibot from './queries/antibot.js';
export * as leads from './queries/leads.js';
export * as agendamento from './queries/agendamento.js';
export * as botConfig from './queries/bot-config.js';
export * as modelUsage from './queries/model-usage.js';
export * as botPrompt from './queries/bot-prompt.js';
export * as botMedia from './queries/bot-media.js';
export * as flowExecutionLog from './queries/flow-execution-log.js';
export * as flowControl from './queries/flow-control.js';
export * as flowClones from './queries/flow-clones.js';
export * as botCourses from './queries/bot-courses.js';
export * as portalConfig from './queries/portal-config.js';
export * as portalUsers from './queries/portal-users.js';
export * as clientBilling from './queries/client-billing.js';

// Re-exporta tipos para import direto
export type { ChatTurn, Role } from './queries/chat-memory.js';
export type { RoutingRow } from './queries/routing.js';
export type { SuspectRow } from './queries/antibot.js';
export type { LeadRicardo } from './queries/leads.js';
export type { AgendamentoPendente } from './queries/agendamento.js';
export type { BotConfigRow, Provider } from './queries/bot-config.js';
export type { LogUsageInput, UsageSummaryRow } from './queries/model-usage.js';
export type { BotMediaRow, MediaType } from './queries/bot-media.js';
export type {
  FlowExecutionLogInput,
  FlowExecutionLogRow,
  FlowLogStatus,
} from './queries/flow-execution-log.js';
export type { FlowControlRow } from './queries/flow-control.js';
export type {
  CloneRow,
  CloneSummary,
  CloneStatus,
  HorarioDia,
  HorariosFuncionamento,
  ServicoConfig,
} from './queries/flow-clones.js';
export type { BotCourseRow } from './queries/bot-courses.js';
export type { PortalPausaRow } from './queries/portal-config.js';
export type { PortalUserRow, PortalUserAuthRow } from './queries/portal-users.js';
export type { ClientBillingRow, BillingStatus } from './queries/client-billing.js';
