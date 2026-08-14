# Missão 031 — Estado composto e pagamento transacional

**DRI:** backend-senior

**Jira:** SCRUM-170

**Apetite:** médio-grande; diff vivo estimado acima de 300 linhas, regido pelo ADR 0037

**Status:** implementação concluída; QA, security e browser locais aprovados. Pendentes Compose
final 2× no CI do head, merge, deploy e golden pós-deploy.

**ADRs relacionados:** 0016, 0018, 0019, 0034 e 0037

## Objetivo

Fazer APIs e mutações comunicarem o estado operacional real do cliente, preservando a independência
entre WAHA, pausa do dono, billing efetivo e suspensão Startap. Corrigir o falso sucesso ao retomar
um bot inadimplente e substituir as duas implementações de pagamento por um núcleo transacional
compartilhado entre webhook e painel.

## Evidência vermelha antes da correção

Base imutável: `73ce4d06679b0ad570d3dcaf032303312fee6c27`.

- CI base `31753155138`, job E2E `94623747599`: duas rodadas frescas com 14/14 cenários de aceite
  em cada, zero egress e teardown integral.
- O contrato known-broken validou exatamente duas falhas. SCRUM-170 falhou pela causa esperada:
  `Expected: 409`, `Received: 200`.
- A prova foi repetida no head documental `f89c75b`: CI `31757860602`, job E2E `94638123740`,
  14/14 cenários em cada uma de duas rodadas, probes de rede/zero egress verdes e SCRUM-170 ainda
  com `Expected: 409`, `Received: 200` antes de qualquer correção de runtime.
- O estado pós-request medido pelo teste atual é alterado para ativo/null; o contrato exige
  preservar `flow_enabled=false` e `suspended_kind='owner_request'` quando billing continua
  bloqueando.
- Instalação limpa local: `npm ci` raiz, exit 0, 231 pacotes; `npm ci` do painel, exit 0,
  128 pacotes.
- Este host não possui Docker/Colima/Podman. `npm run e2e:up` terminou exit 1 antes de criar
  serviço ou volume, com “Docker não está instalado/disponível”. O PM fará a nova prova vermelha
  no CI sobre a branch documental antes de autorizar edição de runtime.
- Baseline focada após build: 7 arquivos, 204/204 testes verdes; painel focado 6/6 verde. Isso
  confirma que a regressão não está coberta pelas suítes unitárias atuais.

## Causa-raiz

### C1 — Retomada decide um eixo e responde por outro

`resumeBotByOwner` autoriza a escrita olhando apenas `owner_request`. O bloqueio efetivo por
inadimplência é derivado separadamente por `resolveSilenceGate`. A rota responde 200 imediatamente
quando o update casa, sem reavaliar o gate nem reler o estado final. O sintoma não é copy errada: é
uma transição inválida que remove a pausa do dono mesmo sem conseguir retomar o atendimento.

### C2 — Estado operacional em cache process-local

`getCloneBySlot` mistura configuração estrutural e campos operacionais em um cache TTL de 60s.
Webhook, portal-api, worker e painel não compartilham memória. Invalidação no writer não alcança os
readers de outros processos; portanto um pagamento correto ainda pode parecer bloqueado por até um
minuto, ou um bloqueio pode ser ignorado pelo mesmo intervalo.

### C3 — Pagamento manual é uma segunda implementação

O webhook confirma cobrança, avança billing e retoma somente kind `billing` numa transação. O
painel faz outro upsert, com aritmética espelhada, mas não executa a transição de suspensão nem a
releitura final. A duplicação permitiu drift funcional e não define uma ordem comum de locks.

## Arquitetura da correção

### 1. Snapshot operacional autoritativo

Adicionar em `@startap/db` uma leitura mínima, por `slot`, sem cache e opcionalmente usando o
`PoolClient` da transação. Ela alimenta todo ponto correctness-critical. Cache existente fica
restrito a configuração estrutural e nunca governa gate, ação permitida ou resultado mutante.

### 2. Projeção composta única

Adicionar função pura em `@startap/core` que recebe snapshot + estado WAHA e chama
`resolveSilenceGate`. Ela projeta processamento, resposta, owner pause, billing bloqueante,
suspensão Startap, estado efetivo e permissão de retomar. Não haverá segunda fórmula de carência.

### 3. Núcleo transacional de pagamento

Extrair para `@startap/db` uma função in-transaction que recebe `PoolClient`, aplica billing,
retoma somente `suspended_kind='billing'`, loga apenas retomada real e relê o snapshot final. O
webhook e o painel são adaptadores do mesmo núcleo, não implementações espelhadas.

O painel importa o `dist` de `@startap/db` empacotado no Dockerfile e passa seu pool ao adaptador
manual. A rota não abre conexão para um helper e outra para a própria escrita.

### 4. Ordem de locks

```text
BEGIN
  → resolve slot sem row lock, quando necessário
  → advisory xact lock "billing:<slot>"
  → SELECT ... FOR UPDATE / revalidação
  → núcleo compartilhado
  → releitura final intra-transação
COMMIT
  → invalidação/efeito local opcional
```

Webhook resolve o candidato antes do advisory apenas para descobrir o slot; depois repete a leitura
com `FOR UPDATE`. Nos caminhos correctness-critical desta missão, manual, webhook, geração/
reemissão e owner resume nunca tomam row lock antes do advisory. Writers legados fora deste recorte
não são declarados cobertos por esta missão.

## Invariantes

1. Toda query, lock e log da operação carrega `slot`; nenhum slot vem do body do portal.
2. `resolveSilenceGate` é a única decisão de silêncio total e `respond`.
3. Owner pause e billing podem coexistir; remover um eixo não remove o outro.
4. Pagamento só retoma `suspended_kind='billing'`.
5. `owner_request`, `manual_other`, `abuse`, WAHA, prompt, agenda e colaboradores são preservados.
6. Negação de resume produz zero escrita, zero `flow_suspension_log` e zero invalidação.
7. Log `resume` existe somente quando `flow_enabled` mudou de false para true.
8. Resposta mutante só sai depois da releitura final na mesma transação.
9. Cache nunca é lido para decidir gate, resume ou resultado de pagamento.
10. Efeito pós-commit nunca é executado antes do commit.
11. Rollback confirmado libera advisory/row locks e restaura billing, suspensão e log em conjunto.
12. Erro ao confirmar `COMMIT` tem outcome desconhecido: descarta conexão e exige releitura antes
    de retry; nunca afirmar que houve rollback.
13. Não existe garantia exactly-once para retry manual sem id compartilhado; não fingir que existe.

## Matriz funcional

| Estado inicial | Retomar dono | Escrita | Resultado efetivo |
|---|---:|---:|---|
| owner, em dia | 200 | limpa owner + 1 log | processa e responde |
| owner, dentro da carência | 200 | limpa owner + 1 log | processa e responde |
| owner, overdue além da carência | 409 `billing_overdue` | nenhuma | silêncio total; owner preservado |
| ativo, em dia | 200 idempotente | nenhuma | processa e responde |
| ativo, overdue além da carência | 409 `billing_overdue` | nenhuma | silêncio total |
| Startap `billing` | 409 classificado | nenhuma | silêncio total |
| Startap `manual_other` | 409 classificado | nenhuma | silêncio total |
| Startap `abuse` | 409 classificado | nenhuma | silêncio total |
| slot inexistente | 404 | nenhuma | inexistente |

| Estado inicial | Pagamento manual/webhook | Suspensão final |
|---|---|---|
| `billing` | avança billing | retomada + um log |
| `owner_request` | avança billing | owner preservado, sem log resume |
| `manual_other` | avança billing | suspensão preservada, sem log resume |
| `abuse` | avança billing | suspensão preservada, sem log resume |
| ativo | avança billing | ativo, sem log resume |

## Contrato backend para o frontend

Preservar campos atuais e adicionar `operational_state` em `/portal/status` e
`/portal/conexao`. O bloco deve conter, sem PII:

- WAHA normalizada: `working|disconnected|failed|unknown`;
- atendimento: `processing` e `responding`;
- owner pause: `active`;
- billing efetivo: `blocking` e dias restantes necessários à copy;
- suspensão Startap: `active` + `billing|manual_other|abuse|null`;
- estado efetivo;
- `resume_owner.allowed` e `denied_reason` enum.

O `POST /portal/bot/resume` mantém `bot_paused` nos 200, devolve o snapshot final e usa 409
`billing_overdue` para vencimento derivado. Suspensões explícitas mantêm
`error='suspensao_startap'` para compatibilidade e acrescentam classificação segura.

## Implementação entregue

1. `packages/core/src/operational-state.ts` projeta os eixos sem copiar a fórmula do gate.
2. `packages/db/src/queries/operational-state.ts` lê o snapshot autoritativo e sem cache;
   `flow-clones.ts` separa cache estrutural de campos operacionais e implementa o owner resume.
3. `packages/db/src/queries/billing-payments.ts` concentra advisory, avanço, retomada condicional,
   log e releitura final no `PoolClient` recebido.
4. `billing-webhook-events.ts` e `painel-admin/server.js` são adaptadores do mesmo núcleo; o
   webhook preserva HMAC/dedupe/amount/first payment e o painel retorna billing + estado final.
   O Dockerfile preserva o package scope ESM de `@startap/db` e faz import smoke durante o build.
5. Portal status/conexão/resume, os dois caminhos do router e o worker consomem leitura uncached
   quando atraso afetaria correção; APIs preservam campos legados e acrescentam o bloco composto.
6. O caso SCRUM-170 foi movido, com as mesmas assertions, para `tests/e2e/specs/vertical.spec.ts`;
   somente SCRUM-137 permanece em `known-broken.json` e `expectedFailures` passou de 2 para 1.
7. Portal web e painel legado consomem o estado composto, distinguem owner/billing/Startap sem
   inferir por uma coluna isolada e tratam resultado manual ambíguo com releitura antes de retry.

## Concorrência coberta em PostgreSQL 16 real

- manual × leitura: nenhum snapshot misto;
- manual × owner resume no mesmo slot: serialização e reavaliação do gate;
- webhook × manual no mesmo slot: nenhum lost update;
- duas operações em slots distintos: ausência de lock cross-tenant;
- falha após cada etapa mutante: rollback integral e lock liberado;
- cache aquecido em outro processo lógico: decisão operacional segue estado do banco;
- invalidação/efeito observado somente depois do commit.

## Estratégia de testes

### Unitários

- matriz completa da projeção composta, incluindo flag billing OFF;
- owner resume feliz, overdue, Startap, já ativo e slot ausente;
- núcleo de pagamento: happy path + rollback, todos os kinds preservados e log condicional;
- adaptador webhook preserva dedupe, orphan, already paid, underpaid, fallback external id,
  first payment e modelo de vencimento;
- contrato do painel prova import do núcleo compartilhado, sem SQL duplicada.

### Integração PG16

- executar funções reais com schema isolado e pools concorrentes;
- afirmar ordem de lock por comportamento, atomicidade, ausência de bloqueio cross-slot e release
  no rollback;
- aquecer cache estrutural antes da mutação e provar que o snapshot operacional não fica stale.

### E2E Compose

- mover o caso SCRUM-170 de `known-broken` para a suíte normal;
- provar 409 + estado owner intacto em overdue e 200 + retomada dentro da carência;
- pagamento manual e webhook atravessam o mesmo núcleo e preservam os demais eixos;
- manter duas rodadas frescas, zero egress, teardown e todos os P0 existentes;
- known-broken final contém somente SCRUM-137 (`expectedFailures=1`).

## Fora de escopo

- migration, backfill, RLS, novo `tenant_id` ou coluna de estado;
- pub/sub Redis, cache distribuído ou invalidação interprocesso;
- outbox, reconciliação gateway→banco ou exactly-once manual×gateway (SCRUM-173);
- mudanças em WAHA/HMAC, prompt, agenda, GCal, colaboradores ou configuração de clone;
- cliente real, produção, Dragon ou comunicação externa.

## Observabilidade

- painel usa Pino estruturado com `slot`, `request_id`, operador, `resumed` e duração no sucesso;
- falha manual antes de `COMMIT` registra `not_applied`; confirmação de `COMMIT` perdida registra
  `unknown`, devolve 503 com releitura obrigatória e nunca promete rollback/retry seguro;
- webhook mantém outcome/event id/slot e alertas underpaid já redigidos; HMAC e redação não mudaram;
- negações usam enum público, nunca `suspended_reason` livre, e não geram log de mutação;
- releitura final ausente falha fechada e reverte; advisory/row locks são visíveis no PostgreSQL.

## Riscos

- **Deadlock por ordem antiga:** mitigado por advisory antes de qualquer row lock e teste concorrente.
- **Regressão de webhook:** mitigada mantendo HMAC/parsing fora do núcleo e cobrindo todos os outcomes.
- **Staleness residual:** mitigada enumerando e migrando todos os callers correctness-critical.
- **Import do DB no painel:** mitigado por build/container test e uma única instância do pool passada
  ao adaptador; `package.json` acompanha o dist e o Dockerfile importa a exportação real no build.
- **Resposta de COMMIT perdida:** outcome fica explícito como desconhecido; conexão é descartada e
  o operador precisa reler antes de novo envio. Exactly-once permanece no SCRUM-173.
- **Carga da query uncached:** uma leitura por PK/LEFT JOIN; medir latência, sem reintroduzir cache de
  correção.
- **Duplo pagamento manual:** limite documentado; não mascarar sem chave idempotente compartilhada.

## Definition of Done

- [x] ADR 0037 aceito antes do runtime.
- [x] Expected-red da base reproduzido no CI da branch documental.
- [x] `resolveSilenceGate` permanece fonte única.
- [x] Snapshot operacional uncached usado por todos os callers correctness-critical.
- [x] Owner resume obedece à matriz, é idempotente e relê antes de responder.
- [x] Webhook e painel chamam o mesmo núcleo com o mesmo `PoolClient` da transação.
- [x] Ordem advisory→row lock provada em PG16, inclusive concorrência e rollback.
- [x] Pagamento preserva owner/manual_other/abuse e loga só retomada billing real.
- [x] Contrato composto backend é aditivo, sem PII e suficiente ao frontend.
- [x] SCRUM-170 está na suíte normal e somente SCRUM-137 permanece known-broken.
- [x] Suítes backend focadas, painel, build/typecheck e integração PG16 verdes.
- [x] Dockerfile preserva package scope ESM e contém import smoke sem acesso a produção.
- [x] Frontend consome o contrato composto e passou por QA, security e browser responsivo local.
- [ ] Aceitação E2E Compose final 2× verde no CI do head.
- [ ] Merge, deploy e golden pós-deploy executados pelo PM.
- [x] Zero migration, backfill, flag, pub/sub, outbox, produção ou cliente real.

## Evidência de validação da implementação

- QA local aprovado em PostgreSQL 16.14: suíte raiz 232/232 arquivos e 3.630/3.630 testes;
- matriz backend focada 69/69, incluindo 14/14 de concorrência/rollback/locks em PG real;
- rotas backend 155/155; painel legado 342/342;
- portal web 46/46 arquivos e 804/804 testes;
- build dos 7 workspaces verde, incluindo 39/39 páginas do Next.js;
- migrations verdes: baseline 001 + 79/79 aplicadas em PostgreSQL 16 vazio;
- harness verde: validate inspecionou 29 arquivos relevantes + 927 tracked/untracked,
  typecheck passou e self-test known-broken passou 9/9;
- lint do delta sem diagnósticos novos;
- security aprovado: 14 arquivos/251 testes e painel 22/22, sem findings;
- browser aprovado em 320 px, 390 px e 1.440 px, incluindo contrastes;
- Compose final 2× no CI do head ainda não executado; merge, deploy e golden pós-deploy seguem
  pendentes, sem resultado presumido.

## Rollback

Reverter o PR de código e os artefatos E2E/contrato correspondentes. Não há schema nem dado de
configuração para desfazer. Pagamento confirmado antes do rollback permanece válido; rollback não
retrocede vencimento nem recria suspensão. Se o compartilhamento do painel falhar antes do commit,
a transação volta integralmente e a rota responde erro sem sucesso falso.
