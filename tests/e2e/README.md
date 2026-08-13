# E2E isolado — SCRUM-171

Harness black-box da Startap. Sobe as aplicações reais (`api`, `worker`, `portal-api` e
`portal-web`) com Postgres 16, Redis 7 e fakes stateful de WAHA, Google Calendar,
AbacatePay e LLM. Não usa `.env`, credenciais, dumps, telefones reais, portas públicas
ou hosts de produção.

## Pré-requisitos

- Node 20+
- Docker Engine 28+ com Compose v2 (`gateway_mode_ipv4=isolated`)
- Nenhum serviço local precisa estar rodando

## Comandos

```bash
npm ci --no-audit --no-fund
npm run e2e:validate
npm run e2e:typecheck
npm run e2e:preflight
npm run e2e
```

`npm run e2e` é o caminho canônico: remove apenas o projeto Compose `startap-e2e`,
cria volumes novos, faz build, aguarda readiness, executa Playwright com um worker e
sempre executa teardown com remoção dos volumes. Depois do primeiro verde, recria a
stack e repete a mesma suíte para provar o reset determinístico. Em falha, imprime
somente as últimas 120 linhas dos serviços.

Para depuração controlada:

```bash
npm run e2e:up
npm run e2e:test
npm run e2e:reset
npm run e2e:down
```

`e2e:reset` recria a stack e os volumes; não faz reset parcial de tabelas. Isso mantém
o estado inicial reproduzível e evita que uma limpeza incompleta dê falso-verde.

## O que é provado

- baseline legado 001 + migrations reais 002–080, com 80 registros no ledger;
- readiness de apps, PG, Redis e fakes;
- API inicia por entrypoint test-only que aguarda o singleton Redis real ficar `ready` antes de
  importar o servidor; falha por timeout em vez de aceitar o primeiro webhook em modo degradado;
- inbound originado no fake WAHA, assinatura HMAC válida/inválida/adulterada e router real;
- LLM real via SDK redirecionado para fake stateful, resposta enviada ao journal WAHA;
- efeitos persistidos em `chat_histories`/`model_usage` e dedup isolado no Redis;
- dois tenants homônimos com mesmo chat sem cruzar sessão, provider ou chave Redis;
- fixtures de clientes preservam o prefixo produtivo `clone_` e usam a matriz
  `teste_barbearia`, portanto atravessam a factory dinâmica e os gates reais de clone;
- retry real do mesmo `messageId` após admissão `503 busy:retry` antes do dedup;
- `fromMe` de áudio, PTT e imagem com `body` vazio/ausente e `hasMedia=true`, pausando só
  o tenant correto, sem LLM, outbound ou pausa cross-tenant;
- silêncio inadimplente e pagamento que preserva
  `owner_request` enquanto remove somente suspensão `billing`; depois do pagamento,
  billing volta a responder e a pausa do dono percorre o pipeline até o gate
  `router.owner-paused`, sem memória do bot nem outbound;
- signup real nos quatro formatos, com auto-login, provisionamento em PG, criação da
  sessão WAHA, prompt não vazio vinculado exatamente a cada slot e preço/flags
  server-authoritative; a mesma jornada gera PIX pelo
  `portal-api` e cliente AbacatePay real;
- cliente Google Calendar real e cliente AbacatePay real exercitados por um probe da
  imagem do worker, com journal dos fakes e marcador persistido em PG;
- job real `close-stale-running` exercitado uma vez sobre marcador determinístico;
- portal-web navegado em viewports móvel e desktop e portal-api exercitado por sessões reais;
- equipe de estabelecimento em 0/1/N colaboradores e isolamento entre dois donos;
- journal, estado, reset e fault injection dos fakes.

## Egress e artefatos

A rede Compose usa bridge interna, IPv6 desligado e gateway IPv4 `isolated`. O preflight
falha se o Engine for anterior ao 28. Após o `up`, o script inspeciona a rede e todos os
serviços: uma única rede, nenhuma porta, host network, `extra_hosts`, privilégio ou
`docker.sock`; exige `no-new-privileges` e `cap_drop: ALL` onde a imagem suporta.

Dois probes complementares falham se houver rota default/egress: um exercita
`fetch`/HTTP/HTTPS/TCP/DNS e o guard test-only; o outro, sem guard, tenta IP público,
metadados AWS/Azure, bridge padrão e canário HTTP do host, enquanto prova que o DNS
interno de `postgres` segue funcionando. O guard redireciona OpenAI/DeepSeek/GCal aos
fakes e bloqueia destinos fora da allowlist. O probe usa o mesmo OpenAI SDK e
`node-fetch` da imagem da API para provar OpenAI e DeepSeek no journal do fake, além da
contraprova externa pelo mesmo transporte. O runtime não é alterado.

O runner é construído de um contexto limpo que contém só config/specs/lockfile; não
monta o checkout, `.git` ou credenciais. Playwright não grava trace, vídeo ou screenshot.
Fakes aplicam allowlist de campos e labels de rota, redação de chat/e-mail/token/credencial,
limite de 64 KiB por entrada e 200 registros por journal. Paths desconhecidos — inclusive
percent-encoded — nunca reaparecem em journal, faults ou 404. O validator enumera arquivos
tracked e untracked sem depender de `git diff HEAD`: percorre toda a árvore E2E, workflow,
missão e configs por skip/PII/host, além de varrer toda a árvore textual por segredos.

## Fakes

Todos expõem:

- `GET /health`
- `GET /__admin/state` — journal ordenado, estado e faults ativos
- `POST /__admin/reset` — limpa somente o fake
- `POST /__admin/faults` — `{ "path": "/rota", "status": 503, "times": 1 }`

O fake WAHA mantém o nome de sessão cru somente como chave interna do contrato. POST, listagem,
journal e estado administrativo usam uma projeção allowlisted `{ nameTag, status }`; o nome nunca
cruza a fronteira HTTP, mesmo quando é curto demais para a redação heurística. O `nameTag` SHA-256
truncado permite provar unicidade e correspondência com os slots provisionados. Esta listagem
tag-only é deliberadamente insuficiente para testar o monitor WAHA por nome; esse job fica desligado
no Compose e exigirá um contrato isolado próprio se entrar no escopo futuro.

O fake WAHA também expõe `POST /__admin/inbound`; ele assina o envelope e o envia à API,
de modo que o teste não “finge” que o webhook foi aceito.

## Limites explícitos

`known-broken.json` lista comportamentos de SCRUM-137/170 que a fundação não conta como
aceite. Eles não são skips: depois da suíte de aceite, o runner executa duas expectativas
vermelhas em configuração separada, valida Jira, título, causa anotada e fragments exatos
da assertion de cada item, e publica JSON
sanitizado em `/artifacts/known-broken-results.json`. Se uma passar ou surgir outra falha,
o wrapper falha e exige atualização explícita do manifest/report.

Nenhum P0 usa `skip`, `fixme` ou `.only`; `e2e:validate` falha se qualquer um aparecer em
código da árvore. A operação completa OFF→ON→OFF, individual↔estabelecimento e rollback
atômico de prompt/cartão continuam dependentes do runtime transacional do ADR 0034 e não
são alegados como verdes nesta missão. Estados WAHA reais além do `STARTING` sintético
também permanecem fora: não há engine WAHA real neste harness isolado.

A suíte usa um worker e modo serial somente porque o cenário de backpressure configura
`WEBHOOK_MAX_INFLIGHT=1`. Isso evita concorrência acidental sobre o semáforo testado; não
cria dependência de dados. Cenários usam message IDs/chats/contas próprios. Cada fromMe usa
telefone exclusivo e exige uma nova pausa com timestamp do próprio teste; equipe provisiona
seus dois estabelecimentos dentro do próprio cenário.
