/**
 * agenda-degrade.ts — DEGRADE ELEGANTE da agenda por-clone (ADR 0030 D3, Onda 3).
 *
 * Um clone que escolheu AGENDA no signup pode ficar num intervalo em que o time
 * ainda NÃO conectou a Service Account do Google (etapa manual, ADR 0024). Nesse
 * intervalo o bot NÃO pode prometer horário — degrada pra ATENDENTE (coleta lead +
 * encaminha, sem tool de agenda, sem [HORARIOS]) até a agenda ficar de pé.
 *
 * A derivação é de RUNTIME, NUNCA um flip do valor armazenado (a INTENÇÃO
 * `agenda_automatica` fica gravada). Ao conectar a SA, `gcalConfigured` vira true e
 * o efetivo resolve pra agenda naturalmente, sem migração de estado e sem tocar
 * clones já conectados (Cirilo/Samuel/dragon têm gcal → nunca entram no degrade).
 *
 * Helpers PUROS (sem I/O): quem chama já carregou o clone + o estado do gcal e só
 * combina os booleanos aqui — fácil de testar, sem acoplamento a banco/env.
 */

/**
 * INTENÇÃO de agenda automática do clone, a partir do valor cru de
 * `personalizacao.agenda_automatica` (JSONB guarda string 'true'/'false' no pipeline,
 * mas pode ter boolean cru vindo do gestão/SQL).
 *
 * DEFAULT true por AUSÊNCIA: só `false`/`'false'` explícito = modo atendente. Espelha
 * EXATAMENTE a regra já usada em getPerfilBySlot e no gate do bot (teste_barbearia.ts)
 * — mesma normalização em 1 lugar só, sem divergência entre consumidores.
 */
export function isAgendaAutomaticaIntent(raw: unknown): boolean {
  return !(raw === false || raw === 'false');
}

/**
 * Comportamento EFETIVO de agenda (ADR 0030 D3): a conjunção da INTENÇÃO com a
 * disponibilidade real da agenda Google.
 *
 *     efetivoAgenda = agendaIntent && gcalConfigured
 *
 * - true  → o bot opera com agenda (tools de agenda + [HORARIOS]) — caminho de hoje.
 * - false → o bot degrada pra atendente (sem tool de agenda) OU já é atendente por
 *           escolha (agendaIntent=false). O caller (bot) roteia pro processAtendente.
 */
export function resolveEffectiveAgenda(agendaIntent: boolean, gcalConfigured: boolean): boolean {
  return agendaIntent && gcalConfigured;
}
