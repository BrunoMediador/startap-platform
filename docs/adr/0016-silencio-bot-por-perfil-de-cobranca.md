# ADR 0016 — Silêncio do bot unificado pelo perfil de cobrança do cliente

- Status: PROPOSTO (aprovado pelo Bruno 2026-06-10)
- Data: 2026-06-10
- Autor: 01-arquiteto
- Supersede (parcial): ADR 0014 §F e a premissa "suspensão DESACOPLADA do pagamento". O comentário-fonte em `packages/db/src/queries/client-billing.ts:6-9` ("status é INFORMATIVO, NÃO silencia o bot — isso continua sendo flow_enabled") deixa de valer: o gate passa a derivar silêncio TAMBÉM do vencimento.
- Relacionado: ADR 0014 (billing por data de vencimento), ADR 0007 (isolamento por clone), ADR 0015 (reconexão WAHA — feature paralela). Feature 30/05 (toggle suspender fluxo).

## Contexto
Hoje "estar vencido" nunca cala o bot. O gate (`apps/api/src/router.ts:374-406`, passo 6b) só silencia quando `flow_clones.flow_enabled === false`, e só para slots `clone_*`. `flow_enabled=false` só é setado pelo toggle manual do gestão (`painel-admin/server.js` ~4020 → `suspendClone` em `flow-clones.ts:494-536`). `computeBillingState` (`client-billing.ts:183-197`) calcula `state='vencido'` mas é só informativo. Cron F4 gera/reconcilia/expira cobrança, nunca suspende. Auto-resume ao pagar (`billing-webhook-events.ts:239-251`) reativa só `flow_enabled=false AND suspended_kind='billing'`.
Decisão do Bruno: o silêncio passa a ser controlado pelo PERFIL de cobrança. Bot MUDO quando perfil SUSPENSO (manual) OU VENCIDO além de carência (manual=data no passado, ou automático por inadimplência). Toggle de suspender fluxo funde no mesmo eixo. Perdão=data pro futuro → volta sozinho. Pagar → volta sozinho.
Achados técnicos herdados: `suspendClone` não seta `suspended_kind`; `getCloneBySlot` (`flow-clones.ts:463-468`) não carrega `suspended_kind`; o gate já chama `getCloneBySlot` (cache TTL 60s).

## Decisão (modelo de estado)
Silêncio DERIVADO no ato, a cada mensagem:
suspensaoManual = (flow_enabled === false)
temBilling = (next_due_date != null && amount_cents > 0)
vencidoComCarencia = temBilling && diasRestantes < -GRACE_DAYS
silenciado = suspensaoManual OR vencidoComCarencia
Onde diasRestantes = daysUntilDue(next_due_date, hoje) (já existe em client-billing.ts:147; ancora hoje em UTC meia-noite). GRACE_DAYS=3. Carência "cala só do 4º dia" (hoje > due+3d): vencido há 0/2/3 dias → RESPONDE; 4+ dias → CALA. Condição estrita `diasRestantes < -3`.
Destino de flow_enabled/suspended_kind: MANTER flow_enabled como sinal de suspensão MANUAL e ADICIONAR a condição de vencimento como segundo termo derivado (OR). NÃO unificar em estado persistido. Vencimento é puramente derivado, NUNCA escreve flow_enabled → não há dois controles brigando. Perdão (data pro futuro) volta o bot SEM nenhum UPDATE (recalcula falso). Auto-resume de pagamento e flow_suspension_log inalterados.

## Query do gate (sem N+1)
LEFT JOIN client_billing (1 linha por slot) no MESMO SELECT de getCloneBySlot (flow-clones.ts:463). CloneRow ganha next_due_date, billing_amount_cents (e opcionalmente suspended_kind). Cache 60s já cobre (vencimento muda 1x/dia). Gate 6b passa a: silenciado = flow_enabled===false || (temBilling && daysUntilDue(next_due_date) < -GRACE_DAYS). Log distingue `router.flow-suspended` (manual) de `router.billing-overdue`.

## Reconciliação
Toggle manual (suspendClone/resumeClone): mantido, único que escreve flow_enabled, segue logando. Gate: vira o ponto de decisão (OR). Cron F4: NÃO precisa suspender (silêncio é derivado). Webhook de pagamento: auto-resume INALTERADO (resolve o caso suspenso-manual-por-billing que pagou; limpa flow_enabled+log). Coexistem sem brigar porque o gate é OR e vencimento nunca escreve flow_enabled.

## Carência
GRACE_DAYS=3 constante exportada em client-billing.ts (junto de BILLING_WINDOW_DAYS). Promover a env (BILLING_GRACE_DAYS) só se Bruno quiser ajustar sem deploy. Por-cliente fora da v1.

## Owner-pause preservada
flow_pauses / pausa.isFlowPaused (gate passo 6) NÃO é tocado. Eixo distinto (dono digitando no número pessoal), anterior ao gate de billing. NÃO unificar.

## Migração
Nenhum schema novo. Ajuste do SELECT de getCloneBySlot (LEFT JOIN), GRACE_DAYS constante, e (opcional, aditivo) suspendClone setar suspended_kind + getCloneBySlot carregá-lo.

## Rollout
Feature flag BILLING_OVERDUE_SILENCE (env) default false (= comportamento atual). 1) deploy off; 2) ligar em Dev/Carlos, validar tabela de aceitação; 3) ligar em prod monitorando router.billing-overdue. Guard duro: só cala se temBilling (next_due_date E amount_cents>0); slot sem billing → responde, nunca cala. Cirilo em-dia (diasRestantes>0) nunca entra na condição. Reverter = desligar flag (sem migração).

## Critérios de aceitação
1. billing vencido há 4d (-4) + flag on → mudo (ignored:billing-overdue). 2. vencido há 2d → responde. 3. vencido há 3d → responde (último dia de carência). 4. suspenso manual (flow_enabled=false) → mudo. 5. data movida pro futuro → próxima msg responde (sem UPDATE em flow_enabled). 6. sem billing (next_due_date null OU amount_cents=0) → responde, nunca cala. 7. pausa-do-dono inalterada. 8. Cirilo (em-dia, diasRestantes>0) → responde com flag on. 9. webhook de pagamento de slot kind='billing' → auto-resume inalterado. 10. flag false → idêntico ao de hoje.
