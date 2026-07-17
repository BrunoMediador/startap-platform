# ADR 0031 — Sync periódico GCal→atendimentos (Faturamento espelha a agenda)

## Status
Proposto (aguarda validação PM/Bruno). Depende de: ADR 0027 (billing derivado da agenda), 0026
(atendimentos), 0024 (Service Account por clone), 0030 (gates env→coluna).

## Contexto
O faturamento derivado da agenda (ADR 0027) só é alimentado por HOOKS: bot ao agendar e rotas do
portal (criar/remarcar/cancelar). Evento criado À MÃO no Google Calendar (caso real: 59 recorrências
semanais da Ingrid, R$110 cada, semeadas 17/07) não passa por hook nenhum e nunca vira linha de
atendimento. Bruno (dono, 17/07) decidiu: a AGENDA é a fonte da verdade do Faturamento — evento
novo/alterado entra/atualiza; evento que SUMIU sai do Previsto/Faturado, INCLUSIVE no passado e
INCLUSIVE linha já paga. A salvaguarda "nunca deletar pago" foi derrubada; mitigação aceita = log de
auditoria (warn com slot/evento/valor/forma/data — sem telefone/nome, LGPD) em toda remoção.

## Decisão
Criar um cron no worker (`gcal-atend-sync`, default OFF por `GCAL_ATEND_SYNC_ENABLED`) que, por clone
com o gate `ATEND_FROM_AGENDA` ligado (env `ATEND_FROM_AGENDA_SLOTS` ∪ coluna
`flow_clones.billing_from_agenda_enabled`) e agenda ativa, reconcilia uma janela `[-62d, +60d]`:
1. Lista a agenda GCal PAGINADA (novo `listEventsPaged`, segue `nextPageToken`) com sinal de
   COMPLETUDE.
2. UPSERT de todo evento presente (idempotente, sticky preservado; NÃO passa `formaPagamento` nem
   reprice) — inclusive os manuais, com preço por catálogo e fallback de preço uniforme (caso Ingrid
   "Fulano Atendimento", catálogo uniforme a R$110).
3. DELETE (soft) das linhas `origem='agenda'` cujo evento sumiu — SÓ quando a listagem é COMPLETA
   (sem truncamento/erro/timeout). Deleção auditada em warn. `origem='manual'` (walk-in) é intocável.

Defesas de segurança (as TRÊS acopladas — ver "Consequências"): janela de LISTAGEM > janela de
DELEÇÃO (pad, evita falso-delete de evento arrastado pra borda); grace por `updated_at <
(início_do_ciclo - grace)` (corrida com hooks); FAIL-SAFE (nunca deletar sobre listagem incompleta);
isolamento por clone (try/catch por slot — regra de ouro 7). Ordem crítica: snapshot GCal ANTES de
ler candidatos do banco.

## Consequências
+ Agenda vira fonte da verdade real; eventos manuais entram no billing sem hook.
+ Reversível: gate OFF = zero efeito (cron nem existe); sem migration; sem alterar o caminho quente
  do bot/portal; `listEvents` intocado (só `listEventsPaged` é novo).
- Deleta faturamento (inclusive pago) se o dono mexer no passado — comportamento POR DESIGN, mitigado
  só por log (risco residual aceito pelo dono).
- Job é write-heavy em agenda gigante (upsert por evento) — bounded por teto de páginas/slots e
  paginação; otimização "upsert só do que mudou" fica como follow-up.
- Requer `ATEND_FROM_AGENDA_SLOTS` presente no container `startap-worker` (novo — hoje só no
  api/portal-api), senão só os clones gated por COLUNA seriam reconciliados.

## Alternativas consideradas
1. **Google Calendar push/watch** (webhook incremental por `syncToken`): mais eficiente e
   near-real-time, mas exige endpoint público https válido por SA, renovação de canais e syncToken
   persistido — infra e superfície nova; adiado (o apex ainda tem pendência de cert, SCRUM-40).
   Reconciliação periódica é boring-tech e reversível.
2. **Manter só hooks + mutirão manual de import**: não cobre edição/remoção manual contínua; não
   atende a regra do dono.
3. **Deletar via `events.get(id)` por linha pra confirmar 404**: N chamadas caras; substituído por
   paginação completa + pad + grace.
4. **Bloco all-events em uma chamada sem paginação**: inseguro (trunca em 100) — rejeitado; foi o
   achado que motiva `listEventsPaged`.

## Notas de implementação
- Envs (todas OPCIONAIS no boot, lição #247; parse Zod em `apps/worker/src/config.ts`):
  `GCAL_ATEND_SYNC_ENABLED` (default OFF), `GCAL_ATEND_SYNC_CRON` (default `37 * * * *`),
  `GCAL_ATEND_SYNC_LOOKBACK_DAYS` (62), `GCAL_ATEND_SYNC_LOOKAHEAD_DAYS` (60),
  `GCAL_ATEND_SYNC_LIST_PAD_DAYS` (7), `GCAL_ATEND_SYNC_MAX_PAGES` (20),
  `GCAL_ATEND_SYNC_TIMEOUT_MS` (15000), `GCAL_ATEND_SYNC_DELETE_GRACE_SEC` (120),
  `GCAL_ATEND_SYNC_MAX_SLOTS_PER_RUN` (50). Reusa `ATEND_FROM_AGENDA_SLOTS`.
- SEM migration nova (reusa `atendimentos`/059 e o índice parcial `ux_atend_event_ativo`).
- Estabelecimento (N calendários de colaborador): deleção só se TODOS listaram completo (AND);
  `presentIds` = união; upsert usa o `colaboradorId` do calendário de origem.
