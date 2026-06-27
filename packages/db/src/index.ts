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
export * as cloneColaboradores from './queries/clone-colaboradores.js';
export * as gcalHealth from './queries/gcal-health.js';
export * as botCourses from './queries/bot-courses.js';
export * as portalConfig from './queries/portal-config.js';
export * as portalUsers from './queries/portal-users.js';
export * as clientBilling from './queries/client-billing.js';
export * as billingCharges from './queries/billing-charges.js';
export * as billingWebhookEvents from './queries/billing-webhook-events.js';
export * as trialLedger from './queries/trial-ledger.js';
export * as alerts from './queries/alerts.js';
export * as tenant from './queries/tenant.js';
export * as tenantReadRollup from './queries/tenant-read-rollup.js';
export * as packages from './queries/packages.js';
export * as atendimentos from './queries/atendimentos.js';
export * as reminders from './queries/reminders.js';
export * as termsAcceptance from './queries/terms-acceptance.js';

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
  CloneAlertOwner,
  CloneDisconnectAlertTarget,
  GoogleAccountRow,
  HorarioDia,
  HorariosFuncionamento,
  ServicoConfig,
} from './queries/flow-clones.js';
export type {
  ProductType,
  ColaboradorRow,
  CloneScope,
  CreateColaboradorInput,
  UpdateColaboradorInput,
} from './queries/clone-colaboradores.js';
// Classe de erro de regra (seat_cap/homônimo) — re-export de VALOR para o caller
// (portal/gestão) usar `instanceof` no tratamento de 409.
export { ColaboradorRuleError } from './queries/clone-colaboradores.js';
export type { BotCourseRow } from './queries/bot-courses.js';
export type { PortalPausaRow } from './queries/portal-config.js';
export type { PortalUserRow, PortalUserAuthRow } from './queries/portal-users.js';
export type { ClientBillingRow, BillingStatus } from './queries/client-billing.js';
export type { BillingChargeRow, ChargeStatus } from './queries/billing-charges.js';
export type {
  BillingWebhookEventRow,
  PaidWebhookOutcome,
  PaidWebhookResult,
  ApplyPaidWebhookInput,
} from './queries/billing-webhook-events.js';
export type {
  TrialLedgerRow,
  TrialLedgerStatus,
  TrialStatus,
  TrialCloneInfo,
} from './queries/trial-ledger.js';
export type {
  AlertRecipientRow,
  AlertConfigRow,
  AlertState,
  AlertStateRow,
  MonitoredSession,
} from './queries/alerts.js';
export type {
  ClientRollupRow,
  ClientRollupResult,
  RollupMode,
  ParityReport,
  ParityClientDiff,
  ParityFieldDiff,
} from './queries/tenant-read-rollup.js';
export type {
  PackageState,
  ServicePackageTemplate,
  ClientPackageCredit,
  RedeemMotivo,
  RedeemResult,
  RedeemForBookingInput,
  RefundForBookingInput,
  RefundResult,
  SuspectDoubleRedeem,
  NovaValidade,
  RecargaInput,
  RecargaResult,
  MudarVencimentoInput,
  MudarVencimentoResult,
  CancelarCreditoInput,
  CancelarCreditoResult,
} from './queries/packages.js';
export type {
  AtendimentoStatus,
  AtendimentoRow,
  AtendimentoListRow,
  AtendimentoListResult,
  CreateAtendimentoInput,
  AtendimentoEventInput,
  FaturamentoReport,
  FaturamentoPorFormaRow,
  FaturamentoPorProfissionalRow,
  ComissaoReport,
  ComissaoPorProfissionalRow,
} from './queries/atendimentos.js';
export type {
  ReminderConfigRow,
  SetReminderConfigInput,
  DueReminderRow,
  ClaimedReminder,
} from './queries/reminders.js';
export type {
  TermsAcceptanceRow,
  RecordTermsAcceptanceInput,
} from './queries/terms-acceptance.js';
