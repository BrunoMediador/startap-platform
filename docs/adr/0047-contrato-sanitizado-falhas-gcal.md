# ADR 0047 — Contrato sanitizado para falhas do Google Calendar

- **Status:** aceito
- **Data:** 2026-08-26
- **Relacionados:** ADR 0031 (sync GCal→atendimentos), ADR 0046 (confirmação server-first)

## Contexto

O cliente GCal recebe URL de calendário, query de janela/paginação, token de acesso e corpos de
erro de terceiro. Esses dados não são observabilidade segura: podem conter identificadores,
dados pessoais ou segredos. A redação parcial do erro de `gcalFetch` não cobria o paginador
`listEventsPaged`, que retornava texto externo em `incompleteReason`. O worker podia então
classificar esse texto antes de incluí-lo em telemetria. O health-check também aceitava fallback
textual fora do contrato do client.

ADR 0031 exige que listagem incompleta bloqueie a deleção de atendimentos. ADR 0046 exige que a
confirmação server-first trate falhas GCal de modo determinístico e sem propagar informação de
terceiros. Portanto, o sinal de falha precisa ser útil para decisão operacional, mas não pode ser
um canal de transporte de resposta externa.

## Decisão

Dados externos do GCal — corpo HTTP, URL/path, query, token, identificador de calendário, page
token e mensagem de exceção — podem ser lidos somente durante a classificação local. Eles nunca
saem do módulo de integração como `Error.message`, retorno ou campo de log.

`listEventsPaged` devolve somente `GcalListIncompleteReason`, contrato fechado com:

- código para timeout, token, rede, parse inválido ou truncamento;
- em HTTP, endpoint/operação categorizados, status HTTP e classe fechada;
- nenhum texto livre ou identificador externo.

O worker de sync valida o shape em runtime. Qualquer formato inválido ou classe fora da allowlist
vira `unknown`; a listagem permanece incompleta e a deleção continua bloqueada, conforme ADR
0031. O health-check aceita somente a mensagem segura reconstruída a partir de enum/status
allowlisted. Desconhecido vira sentinela inconclusiva e não demove uma agenda.

## Consequências e trade-offs

**Benefícios**

- Impede que telemetria, logs e callers propaguem dados externos sensíveis.
- Mantém diagnóstico operacional por operação, endpoint, status e enum de causa.
- Preserva o fail-safe de ADR 0031: erro, timeout ou contrato desconhecido nunca autoriza
  deleção.
- Preserva a distinção de rate limit transitório, sem rebaixar agenda saudável por HTTP 403.

**Custos aceitos**

- Depuração de um erro GCal exige correlação por categorias/status e ferramentas externas
  autorizadas; o corpo da resposta não está disponível em logs da aplicação.
- Novas causas ou endpoints exigem evolução explícita do contrato e das allowlists, em vez de
  depender de texto livre.

## Rollback

Não há migration, flag, política de tenant ou configuração de cliente nesta decisão. Rollback de
código é revert do commit que introduziu o contrato; isso restaura o comportamento anterior e
também reabre o risco de exposição, portanto só é aceitável para resposta emergencial com revisão
de segurança. O estado de agenda, propostas e confirmações não é modificado por este ADR.

## Aceitação

- Nenhum marcador externo em corpo HTTP, token/OAuth, rede, JSON, calendar ID, query ou page token
  aparece no retorno nem no logger da integração.
- Shape hostil em `incompleteReason` gera somente `unknown` no worker e mantém deleção bloqueada.
- Fallback hostil do health-check gera sentinela inconclusiva e não demove agenda.
- Rate-limit seguro continua transitório; build, Biome e testes relevantes permanecem verdes.

As regressões hostis estão em
`packages/integrations/src/google-calendar/client.paged.test.ts`,
`apps/worker/src/jobs/gcal-atend-sync.test.ts` e
`apps/worker/src/jobs/gcal-healthcheck.test.ts`.
