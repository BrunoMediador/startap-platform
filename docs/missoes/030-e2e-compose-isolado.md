# Missão 030 — Fundação E2E Compose isolada

**DRI:** backend-senior

**Jira:** SCRUM-171

**Apetite:** médio (harness aditivo de teste/CI; zero runtime/schema de produção)

**Status:** implementação pronta; gates estáticos locais verdes, Compose aguarda execução no CI

**ADRs relacionados:** 0018, 0019, 0023, 0024, 0030 e 0034

## Objetivo

Transformar regressões críticas multi-serviço em prova reproduzível: ambiente limpo,
tenant isolado, inbound WAHA assinado, API/runtime, resposta outbound, efeitos em Postgres
e Redis, seguido de teardown total. A suíte deve falhar alto se depender de internet,
segredo, dado vivo ou comportamento não implementado.

## Escopo

- Compose próprio com API, worker, portal-api, portal-web, PG16 e Redis7.
- Fakes modulares/stateful de WAHA, GCal, AbacatePay e LLM com journal e fault injection.
- Baseline 001 e migrations versionadas 002–080 em banco novo.
- Playwright serial (um worker), incluindo portal-web e prova vertical black-box.
- Matriz P0: tenants homônimos/cross-tenant, HMAC, retry, inbound/fromMe,
  billing×suspensão×processamento, owner pause pós-pagamento e silêncio inadimplente.
- Signup real nos quatro formatos, portal-web em dois viewports, portal-api autenticado,
  job real do worker e clientes reais GCal/AbacatePay contra fakes.
- Guard de egress test-only, probe de rede sem guard e validação estática de skips,
  hosts, PII, segredos, workflow, missão, diff e Compose.
- Scripts locais e job obrigatório no CI, ambos com teardown.

## Fora de escopo

- Alterar runtime, schema, migrations históricas ou dados de produção.
- Implementar a operação de formato do ADR 0034 ou corrigir SCRUM-170 pelo teste.
- Substituir smoke humano pós-deploy, testar WAHA real ou usar cliente como canário.
- Prometer verde local sem Docker.

## Arquitetura

A rede bridge é `internal:true`, IPv6 OFF e usa gateway IPv4 `isolated` (Docker 28+),
sem portas publicadas. Apps usam suas imagens reais; um
preload montado somente no Compose intercepta `fetch`: hosts conhecidos são enviados aos
fakes e os demais são rejeitados. O preload também barra HTTP/HTTPS/TCP/DNS; um probe sem
preload prova a barreira de rede contra IP público, metadata, bridge e host. O migrator
aplica a cadeia real antes dos apps. O runner Playwright fala apenas por DNS da rede.

O runner não recebe bind mount do repositório: uma imagem de staging copia somente
lockfile, configs, scripts de controle e specs. Containers compatíveis rodam non-root,
read-only, com tmpfs, `cap_drop: ALL` e `no-new-privileges`; PG/Redis preservam o usuário
das imagens e recebem o hardening comprovadamente compatível.

Reset é recriação de volumes (`down --volumes` + `up`), nunca limpeza parcial. O comando
canônico executa a suíte, recria a stack e executa a mesma suíte novamente. Os fakes
mantêm estado em memória e fornecem reset administrativo para isolamento dentro de uma
execução. Journals são ordenados e sanitizados na entrada.

Playwright permanece serial por causa do semáforo global intencional
`WEBHOOK_MAX_INFLIGHT=1`, necessário à prova de backpressure. A serialização não substitui
isolamento de fixture: message IDs, chats e contas são exclusivos; cada caso fromMe exige
linha nova/timestamp próprio e equipe provisiona seus donos no próprio cenário. Journals,
faults e 404 usam somente labels de rota allowlisted, nunca path arbitrário refletido.

## Estratégia de testes

1. Preflight de Docker 28+, inspeção estrutural da rede/serviços e probes negativos reais.
2. Readiness de todas as dependências e contagem exata das migrations.
3. Fake WAHA assina e envia mensagem; API valida HMAC e executa o clone real.
4. OpenAI SDK alcança o fake LLM pelo guard; WAHA fake registra o outbound.
5. Playwright confirma efeitos no PG e chave `(sessão,messageId)` no Redis.
6. Backpressure real reproduz `503` antes do dedup e o retry do mesmo ID termina uma vez.
7. A mesma superfície exercita fromMe de mídia, isolamento e silêncio.
8. Webhook AbacatePay real prova assinatura ausente/errada/adulterada/query inválida e,
   no caminho válido, os eixos independentes owner/billing e o processamento
   posterior: billing volta a responder; owner alcança o gate `router.owner-paused` e
   continua sem memória do bot nem outbound.
9. Signup real prova os quatro formatos em PG/WAHA e usa sessão real do portal para PIX.
10. Worker-once fecha uma execução stale; integration-probe usa clientes GCal e AbacatePay reais.
11. Browser navega cadastro em móvel/desktop; portal equipe prova 0/1/N e cross-tenant.
12. A stack e os volumes são recriados e a suíte completa repete o mesmo resultado.

P1 de transição de formato e UI composta são testes expected-red reais, executados em
config separada e validados por Jira, título, causeId e assertion específica no relatório.
Continuam ligados a SCRUM-137/170 e fora do aceite. OFF→ON→OFF completo,
individual↔estabelecimento e rollback de prompt/cartão dependem da operação transacional
ausente do ADR 0034. O harness não corrige runtime nem transforma isso em skip. P0 não
admite skip/quarentena.

## Riscos

- **Imagem/lock Playwright divergirem:** versão exata é compartilhada entre npm e imagem.
- **Egress por cliente não-`fetch`:** guard cobre built-ins e o probe sem guard prova a rede.
- **Falso reset:** mitigado por volume novo a cada execução canônica.
- **Fake permissivo:** rota desconhecida devolve 404; chamadas ficam no journal; faults são
  consumidos por contagem explícita.
- **Custo de CI:** job separado, timeout de 20 minutos e um worker evitam paralelismo ruidoso.

## Definition of Done

- [x] Comandos únicos de up, test, reset, down e ciclo completo com teardown.
- [x] Compose sem `container_name`, `ports`, `env_file` ou rede externa.
- [x] Apps reais + PG16/Redis7 + quatro fakes stateful.
- [x] Migrations 001–080 e seed sintético sem dump/PII.
- [x] Specs da prova vertical e matriz P0 sem skip/fixme/only.
- [x] Guard de egress e fakes sanitizados.
- [x] Runner staging sem checkout/.git/credencial montada e containers hardenizados.
- [x] Job CI com permissão read-only, checkout sem credencial persistida, typecheck e preflight.
- [x] Expected-red executável e reportável de SCRUM-137/170 fora do aceite.
- [ ] Execução Compose verde em host com Docker (Mac atual não possui Docker).
- [ ] Reviews qa-tester e security.

O DoD integral permanece aberto até o job Compose executar. A cobertura P1 transacional
citada acima também não é contabilizada como verde.

## Rollback

Reverter os artefatos de `tests/e2e`, scripts do `package.json`, dependência Playwright,
job `e2e` do CI e esta missão. Não há migration, env produtiva, flag ou dado para desfazer.

## Waiver de ADR

Waiver ratificado para esta missão: a mudança é infraestrutura de CI aditiva, isolada e
sem contrato de produção. Um ADR passa a ser obrigatório se o harness governar deploy,
introduzir serviço/runtime produtivo, mudar migrations históricas ou permitir egress real.
