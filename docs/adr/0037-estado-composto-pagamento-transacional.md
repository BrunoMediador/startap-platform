# ADR 0037 — Estado operacional composto e transição transacional de pagamento

- **Status:** **Aceito pelo PM em 2026-08-13**
- **Data:** 2026-08-13
- **Autor:** arquiteto, consolidado por backend-senior
- **Jira:** SCRUM-170
- **Relacionados:** ADR 0016 (gate de silêncio), ADR 0018 (tenant), ADR 0019
  (idempotência), ADR 0034 (agregados transacionais) e Missão 031
- **Nota documental:** o ADR 0014 não existe no histórico versionado de `origin/main`;
  referências antigas a ele não constituem um contrato disponível.

## Contexto

O produto representa quatro eixos independentes em campos e integrações diferentes:

1. conectividade WAHA;
2. pausa solicitada pelo dono (`owner_request`);
3. bloqueio efetivo por cobrança vencida além da carência;
4. suspensão explícita da Startap (`billing`, `manual_other` ou `abuse`).

`flow_enabled` e `suspended_kind` não bastam para descrever o estado efetivo. O bloqueio por
vencimento é derivado no ato pelo `resolveSilenceGate`, sem escrever `flow_enabled`. Por isso, um
clone pode estar simultaneamente pausado pelo dono e inadimplente. Nesse caso, a pausa do dono
suspende a resposta, enquanto a inadimplência suspende todo o processamento.

O `POST /portal/bot/resume` atual chama `resumeBotByOwner`, que limpa `owner_request` sem consultar o
gate de cobrança. A rota retorna 200 antes de verificar se o atendimento continuará bloqueado. O
expected-red do SCRUM-170 prova o falso sucesso: esperava 409, recebeu 200 e o estado persistido
passou de `owner_request` para ativo, embora o vencimento ainda impusesse silêncio.

Há uma segunda causa de inconsistência: `getCloneBySlot` guarda por 60 segundos, em memória local,
campos operacionais de `flow_clones` e `client_billing`. API, portal-api, worker e painel são
processos distintos. Invalidar o mapa do processo que escreveu não invalida o mapa de quem decide
o gate. Logo, cache process-local não pode ser mecanismo de coerência de billing ou suspensão.

O pagamento manual no painel também diverge do webhook. Ele faz um upsert próprio em
`client_billing`, não remove suspensão `billing`, não compartilha a ordem de locks e não relê o
estado final dentro da transação. Duas SQLs parecidas não formam uma operação canônica.

O diff vivo estimado supera 300 linhas e altera ordem de locks e política de consistência. Portanto,
esta decisão exige ADR antes da implementação. Não há necessidade de migration, backfill ou flag.

## Decisão

### D1 — O estado é composto, nunca colapsado numa coluna nova

Não será criada coluna `status_efetivo`. O estado público será uma projeção derivada de uma leitura
operacional autoritativa e do gate canônico. Os eixos permanecem independentes:

| Eixo | Fonte | Projeção pública |
|---|---|---|
| WAHA | status da sessão | `working`, `disconnected`, `failed` ou `unknown` |
| Atendimento | existência/configuração do clone + decisão do gate | processa e/ou responde |
| Pausa do dono | `flow_enabled=false` + `owner_request` | `owner_pause.active` |
| Billing efetivo | resultado de `resolveSilenceGate` | `billing.blocking` |
| Suspensão Startap | `suspended_kind` não-owner | kind `billing`, `manual_other` ou `abuse` |

Uma função pura em `@startap/core` projetará o contrato composto. Ela **chamará**
`resolveSilenceGate`; não copiará a fórmula de carência, valor, vencimento ou precedência.

### D2 — Leitura operacional autoritativa sem cache

`@startap/db` terá um snapshot mínimo, parametrizado por `slot`, lido em uma única query:

- `flow_enabled`;
- `suspended_kind`;
- `next_due_date` normalizada para `YYYY-MM-DD`;
- `billing_amount_cents`;
- somente os metadados estruturais necessários à projeção.

Esse snapshot não usa o cache TTL. Todos os callers em que atraso muda correção devem consumi-lo:

- os dois ramos do gate no router;
- worker/antibot;
- `/portal/status` e `/portal/conexao`;
- decisão e releitura final de `/portal/bot/resume`;
- transições de pagamento manual e webhook.

O cache process-local pode continuar para configuração estrutural de baixa volatilidade, como
matriz, horários e serviços. Ele não autoriza nem bloqueia atendimento e não participa da coerência.
Invalidá-lo continua sendo otimização local, sempre depois do commit, nunca garantia distribuída.

### D3 — Núcleo único de pagamento dentro da transação

`@startap/db` terá um núcleo que recebe um `PoolClient` já dentro de uma transação. Esse núcleo é o
único escritor da transição comum aos pagamentos manual e webhook:

1. avança `client_billing.next_due_date` a partir de `max(vencimento, hoje)`;
2. marca billing ativo e `last_payment_at=NOW()`;
3. retoma o fluxo **somente** se `flow_enabled=false AND suspended_kind='billing'`;
4. preserva `owner_request`, `manual_other` e `abuse`;
5. grava `flow_suspension_log` somente quando houve retomada real;
6. relê e devolve billing + snapshot operacional final na mesma transação.

O núcleo não abre transação, não faz commit e não invalida cache. Adaptadores distintos cuidam do
protocolo de entrada, mas chamam o mesmo núcleo:

- webhook: HMAC, parsing, redação, dedupe, amount mismatch, charge paid, first payment e avanço;
- manual: validação do painel, existência do slot, meses, valor/notas opcionais e resposta HTTP.

O painel importará o `dist` compartilhado de `@startap/db` e passará seu próprio pool ao adaptador
manual. Não haverá uma cópia da SQL dentro de `painel-admin/server.js`.

Se a chamada de `COMMIT` falhar, o adaptador não afirma rollback: a resposta do servidor pode ter
se perdido depois da confirmação. Ele descarta a conexão, lança outcome `unknown` e obriga o
caller a reler billing antes de qualquer retry. Criar exactly-once para esse intervalo continua
fora do escopo (SCRUM-173).

### D4 — Ordem de locks nos caminhos correctness-critical desta missão

Os caminhos correctness-critical abrangidos por esta decisão — pagamento manual, webhook,
geração/reemissão de cobrança via `withBillingSlotLock` e owner resume — usam o mesmo namespace
`billing:<slot>` e respeitam a seguinte ordem:

1. `BEGIN`;
2. resolver o `slot` sem row lock, quando ele ainda não é conhecido;
3. adquirir advisory transaction lock pela chave lógica `billing:<slot>`;
4. somente depois adquirir row locks (`SELECT ... FOR UPDATE`);
5. aplicar a transição e fazer a releitura final;
6. `COMMIT` ou `ROLLBACK`;
7. executar efeitos locais pós-commit.

O webhook resolve a cobrança candidata sem lock apenas para descobrir o `slot`. Depois do advisory
lock, ele repete o `SELECT ... FOR UPDATE` e toma todas as decisões sobre esse resultado revalidado.
O primeiro SELECT nunca autoriza crédito nem resume.

O advisory lock usa o mesmo namespace do fluxo de criação de PIX existente. Esses caminhos não
tomam row lock de cobrança/clone antes dele. A ordem fixa evita deadlock manual×webhook e impede
lost update. Locks são por slot: operações de tenants diferentes não se bloqueiam. Este ADR não
afirma que todo writer legado fora da missão já participa desse protocolo.

### D5 — Retomada do dono é uma decisão transacional do gate

`resumeBotByOwner` deixa de ser um `UPDATE` cego. Dentro da ordem de D4, lê o snapshot operacional e
chama `resolveSilenceGate`:

- `owner_request` em dia ou dentro da carência: 200, limpa somente a pausa do dono, loga uma vez;
- retry já ativo e em dia: 200 idempotente, sem escrita e sem log;
- vencido além da carência: 409 `billing_overdue`, zero escrita, zero log e zero invalidação;
- já ativo mas overdue: também 409 `billing_overdue`, refletindo o bloqueio efetivo;
- `billing`, `manual_other` ou `abuse`: 409 `suspensao_startap`, com classificação estável e copy
  apropriada; zero escrita;
- slot inexistente: 404, zero escrita.

Toda resposta mutante usa a releitura final intra-transação. A rota não infere sucesso apenas pelo
`rowCount` de um update intermediário.

### D6 — Contrato HTTP aditivo e retrocompatível

Os campos existentes de `/portal/status` e `/portal/conexao` permanecem. Será adicionado um bloco
sem PII nem motivos internos livres, conceitualmente:

```text
operational_state
  waha.state: working | disconnected | failed | unknown
  atendimento.processing: boolean
  atendimento.responding: boolean
  owner_pause.active: boolean
  billing.blocking: boolean
  startap_suspension.active: boolean
  startap_suspension.kind: billing | manual_other | abuse | null
  effective: working | disconnected | paused_by_owner | blocked_billing |
             blocked_startap | unknown
  actions.resume_owner.allowed: boolean
  actions.resume_owner.denied_reason: billing_overdue | startap_billing |
                                      startap_manual_other | startap_abuse | null
```

`processing` e `responding` tornam explícita a regra de negócio: owner pause em dia processa sem
responder; billing/suspensão Startap não processa nem responde. WAHA continua eixo independente.

O `POST /portal/bot/resume` preserva `bot_paused` nas respostas 200. Em 409 explícito da Startap,
preserva `error='suspensao_startap'` e adiciona a classificação. O novo caso derivado usa o código
específico `billing_overdue`. Respostas incluem o snapshot final necessário para o frontend não
adivinhar o resultado.

## Concorrência e atomicidade

| Corrida | Garantia |
|---|---|
| manual × leitura | uma query lê snapshot anterior ou posterior ao commit, nunca meia-transição |
| manual × owner resume | advisory do slot serializa; o segundo reavalia o gate atual |
| webhook × manual, mesmo slot | mesma chave e ordem; ambos avançam a partir do estado revalidado |
| webhook × webhook | dedupe/evento e status da cobrança permanecem atômicos sob a nova ordem |
| slots diferentes | chaves distintas; nenhum lock cross-tenant |
| falha injetada | rollback integral; advisory/row locks liberados pela transação |

Retry manual **não é exactly-once**: o painel não possui uma chave de idempotência compartilhada
com o gateway. Dois registros manuais confirmados representam dois avanços sequenciais. Inventar
uma chave, outbox ou reconciliação gateway/manual pertence ao SCRUM-173 e está fora deste ADR.

## Alternativas consideradas

### A — Invalidar o cache local do painel

Rejeitada. O runtime e o portal vivem em outros processos; o mapa invalidado não é o mapa lido.

### B — Pub/sub Redis para invalidação

Rejeitada neste escopo. Acrescenta entrega/assinatura/recovery para corrigir um dado operacional que
pode ser lido por PK em uma query barata. Cache estrutural continua sem depender de pub/sub.

### C — Duplicar a SQL do webhook no painel

Rejeitada. As duas implementações já divergiram; espelhamento não cria atomicidade compartilhada.

### D — Materializar `effective_status`

Rejeitada. Seria uma nova fonte de verdade que envelhece com o calendário e com a conectividade
WAHA. O estado efetivo é derivado no ato.

### E — Migration/outbox/idempotency key agora

Rejeitada. Resolver timeout gateway→attach e exactly-once manual×gateway é o SCRUM-173. Não é
necessário para corrigir o falso resume e compartilhar a transição local.

## Implementação registrada em 2026-08-13

A decisão foi materializada sem schema, flag ou infraestrutura nova:

- `packages/core/src/operational-state.ts` contém a projeção pública pura e delega a decisão de
  silêncio a `resolveSilenceGate`; sua matriz vive em `operational-state.test.ts`;
- `packages/db/src/queries/operational-state.ts` fornece a leitura uncached e a variante de lock;
  `getCloneBySlot`/`getCloneBySession` preservam o contrato legado mesclando esse snapshot ao cache
  apenas estrutural;
- `packages/db/src/queries/billing-payments.ts` implementa advisory por slot, núcleo
  in-transaction e adaptador manual; `flow-clones.ts` usa a mesma ordem no owner resume;
- `billing-webhook-events.ts` agora descobre o slot sem row lock, toma o advisory, revalida a
  cobrança `FOR UPDATE` e delega a transição aplicada ao núcleo compartilhado;
- `painel-admin/server.js` passa seu próprio pool ao adaptador do DB; o Dockerfile compila e copia
  o `dist` e o `package.json` de `@startap/db`, sem SQL manual duplicada no ramo
  `register_payment`; o build da imagem importa o dist real como smoke antes de publicar;
- portal status/conexão/resume, router e worker usam snapshot autoritativo nos pontos em que
  staleness mudaria a decisão; o contrato HTTP recebeu apenas `operational_state` aditivo;
- `billing-state.integration.test.ts` executa a matriz e as corridas reais sob PostgreSQL 16;
  SCRUM-170 saiu do known-broken e manteve suas assertions no aceite normal.

O painel/webhook conservam adaptadores distintos porque seus protocolos são diferentes. O que é
compartilhado de verdade é a mutação comum dentro da mesma transação e do mesmo `PoolClient`.

## Consequências

### Positivas

- uma regra de gate e uma operação de pagamento;
- resultado HTTP corresponde ao estado persistido final;
- consistência entre processos sem infraestrutura nova;
- isolamento por `slot` em query, lock e log;
- nenhuma alteração de WAHA, prompt, agenda, colaboradores ou configuração do cliente.

### Trade-offs

- o hot path faz uma query operacional indexada em vez de aceitar até 60 segundos de staleness;
- webhook precisa reconsultar a cobrança após adquirir o advisory lock;
- o painel passa a empacotar/importar `@startap/db`, aumentando a disciplina do Dockerfile;
- manual retry segue não-exactly-once, agora documentado e observável.

## Observabilidade

Logs estruturados usam `slot` e `request_id` quando o protocolo o fornece, sem telefone, PII,
`suspended_reason` livre ou payload de gateway. O painel registra sucesso manual com `resumed` e
duração. Falha antes de `COMMIT` é `not_applied`; falha ao confirmar `COMMIT` é `unknown`, retorna
503 com `requires_reread=true`/`retry_safe=false` e nunca é descrita como revertida. O webhook
mantém outcomes/dedupe/underpaid e o portal mantém os eventos de mutação. Negações são observáveis
por códigos HTTP/enum estáveis e pela ausência de `flow_suspension_log`. Espera/contenda de
advisory fica observável pelas visões padrão do PostgreSQL; não foi criado um segundo mecanismo de
lock nem métrica process-local.

Uma releitura final ausente é erro fail-closed e causa rollback. O teste PG16 injeta rollback,
prova liberação do advisory e verifica que cache estrutural não antecipa commit nem deixa o eixo
operacional stale após ele.

Não serão logados payload, brCode, CPF, telefone, e-mail ou credenciais.

## Rollout e rollback

Não há migration, backfill, env obrigatória nova ou feature flag. Rollout é por código, depois de
suítes focadas, integração PG16 e E2E Compose. Rollback é revert do PR: restaura os adaptadores
anteriores sem reversão de schema. Pagamentos já confirmados não são desfeitos pelo rollback.

## Critérios para aceitar este ADR

- núcleo único comprovadamente usado pelos dois adaptadores;
- ordem advisory→row lock verificada por teste PG16 real;
- todos os callers correctness-critical fora do cache operacional;
- matriz de estado composto e códigos de negação aprovada;
- expected-red do SCRUM-170 convertido em aceitação verde sem relaxar assertion;
- SCRUM-137 continua como única falha conhecida;
- zero migration, pub/sub, outbox ou mudança de modelo.
