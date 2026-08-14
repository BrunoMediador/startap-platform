# Missão 031 — Estado composto e pagamento transacional

**DRI:** backend-senior

**Jira:** SCRUM-170

**Apetite:** médio-grande; diff vivo estimado acima de 300 linhas, regido pelo ADR 0037

**Status:** ADR aceito; gate seguinte é a prova expected-red no CI da branch.

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
com `FOR UPDATE`. Manual, webhook e owner resume nunca tomam row lock antes do advisory.

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
11. Rollback libera advisory/row locks e restaura billing, suspensão e log em conjunto.
12. Não existe garantia exactly-once para retry manual sem id compartilhado; não fingir que existe.

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

## Plano de implementação

1. Converter o vermelho do SCRUM-170 em teste de aceite normal sem alterar assertions.
2. Criar projeção pura e matriz unitária no core.
3. Criar snapshot operacional uncached e migrar todos os callers de gate.
4. Tornar owner resume transacional, gate-aware e com releitura final.
5. Extrair lock/núcleo de pagamento e adaptar webhook sem regredir HMAC/dedupe/amount/first payment.
6. Adaptar pagamento manual do painel ao mesmo núcleo e empacotar `@startap/db` no Dockerfile.
7. Projetar estado composto nas rotas backend, mantendo contrato anterior.
8. Atualizar known-broken: remover somente SCRUM-170, `expectedFailures` 2→1, ajustar
   contrato/self-test/validator e preservar SCRUM-137.
9. Rodar suítes focadas, painel, typecheck, integração PG16 e aceitação E2E isolada.

## Concorrência a provar em PostgreSQL 16 real

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
- frontend (`apps/portal-web` e `painel-admin/public`), que recebe o contrato depois;
- cliente real, produção, Dragon ou comunicação externa.

## Observabilidade

- log estruturado com `slot`, `request_id`, origem `manual|webhook`, etapa e duração;
- enum de negação, nunca `suspended_reason` livre;
- lock timeout/contention e rollback com código PG sanitizado;
- métrica/log de pagamento aplicado e `resumed` sem valor, telefone ou payload;
- erro fail-closed se releitura final contradizer o resultado da transição.

## Riscos

- **Deadlock por ordem antiga:** mitigado por advisory antes de qualquer row lock e teste concorrente.
- **Regressão de webhook:** mitigada mantendo HMAC/parsing fora do núcleo e cobrindo todos os outcomes.
- **Staleness residual:** mitigada enumerando e migrando todos os callers correctness-critical.
- **Import do DB no painel:** mitigado por build/container test e uma única instância do pool passada
  ao adaptador.
- **Carga da query uncached:** uma leitura por PK/LEFT JOIN; medir latência, sem reintroduzir cache de
  correção.
- **Duplo pagamento manual:** limite documentado; não mascarar sem chave idempotente compartilhada.

## Definition of Done

- [ ] ADR 0037 aceito antes do runtime.
- [ ] Expected-red da base reproduzido no CI da branch documental.
- [ ] `resolveSilenceGate` permanece fonte única.
- [ ] Snapshot operacional uncached usado por todos os callers correctness-critical.
- [ ] Owner resume obedece à matriz, é idempotente e relê antes de responder.
- [ ] Webhook e painel chamam o mesmo núcleo com o mesmo `PoolClient` da transação.
- [ ] Ordem advisory→row lock provada em PG16, inclusive concorrência e rollback.
- [ ] Pagamento preserva owner/manual_other/abuse e loga só retomada billing real.
- [ ] Contrato composto backend é aditivo, sem PII e suficiente ao frontend.
- [ ] SCRUM-170 virou aceite; somente SCRUM-137 permanece known-broken.
- [ ] Suítes focadas, painel, build/typecheck, integração PG16 e E2E de aceitação verdes.
- [ ] Zero migration, backfill, flag, pub/sub, outbox, produção ou cliente real.

## Rollback

Reverter o PR de código e os artefatos E2E/contrato correspondentes. Não há schema nem dado de
configuração para desfazer. Pagamento confirmado antes do rollback permanece válido; rollback não
retrocede vencimento nem recria suspensão. Se o compartilhamento do painel falhar antes do commit,
a transação volta integralmente e a rota responde erro sem sucesso falso.
