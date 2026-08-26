# ADR 0046 — Confirmação de agendamento server-first

- **Status:** aceito para implementação, rollout desligado
- **Data:** 2026-08-25
- **Relacionados:** ADR 0024, ADR 0033, ADR 0039, ADR 0044

## Contexto

O cartão e o SIM estavam somente como instrução do prompt. Assim, o modelo podia omitir
campos, interpretar uma mensagem fora de ordem e continuar a responder depois de uma tool;
o bloqueio de conflito do GCal evitava a escrita errada, mas não garantia uma interação clara.

## Decisão

`propor_agendamento` valida horário, serviço e profissional no servidor, persiste uma proposta
pseudonimizada com TTL de 15 minutos e retorna um cartão renderizado pelo servidor. A proposta
tem `tenant_id`, `slot`, HMAC exclusivo do contato, serviço, intervalo, profissional, status e
event id determinístico; nunca telefone, nome, texto, cartão ou summary.

Somente `SIM` literal interceptado antes da LLM move `pending -> confirming` com CAS. A
confirmação reconsulta a agenda do profissional ativo, cria pelo event id determinístico e
finaliza `booked`. Conflito, expiração, troca de mensagem e estado ambíguo recebem texto terminal
do servidor. Em timeout/409 a recovery usa `GET eventId`; sem prova do evento não reenvia POST.

Antes de expor `propor_agendamento`, o guard usa uma decisão estruturada e validada por schema:
`pronta_para_proposta`, `coletar_dados(campos_faltantes)` ou
`conversa_segura(topico=saudacao|disponibilidade|pergunta|cancelamento|remarcacao)`. A
classificação roda com temperatura zero e tool forçada; tool ausente, shape inválido, erro ou
deadline fecham em coleta de dados. `coletar_dados` devolve uma pergunta determinística apenas
para os campos faltantes, sem chamar o agente de agenda. `conversa_segura` pode receber resposta
normal e apenas capabilities read-only; ela nunca recebe `propor_agendamento`, tools legadas
mutantes nem `tool_choice` mutante. Antes de sair, a resposta livre passa por filtro fail-closed:
cartão, confirmação, agendamento/remarcação/cancelamento, shape de cartão e CTA `SIM` retornam
um fallback server-side sem alteração. Persona e conteúdo inbound não podem contornar essa barreira.

Somente `pronta_para_proposta` chama o agente de agenda, também com `tool_choice` forçando
`propor_agendamento`. Assim, uma intenção completa não depende do comportamento `auto` do
modelo; saudação, disponibilidade, pergunta, cancelamento e remarcação não viram proposta, e
dados ausentes não recebem a mesma resposta genérica.

A classificação tem deadline fixo de quatro segundos e não faz retry. Ela é estritamente
read-only; o resultado tardio é consumido e não pode acionar nenhuma tool de proposta. A escrita
continua exclusivamente no fluxo existente de proposta persistida e CAS, preservando a
idempotência frente a reentrega/concorrência do webhook.

O renderer canônico atual atende `cartao_mode=runtime`. Para baked existe agora o contrato
explícito `flow_clones.confirmation_card_contract`: uma sequência versionada de segmentos
`literal|field` e o SHA-256 do cartão baked revisado. Os cinco campos fechados (`dia`, `horario`,
`servico`, `valor`, `profissional`) ocorrem uma única vez. O servidor preserva cada segmento
literal e só preenche esses valores canônicos.

O contrato nunca é inferido do `bot_prompt`: ele é revisado/configurado por slot. A extração do
cartão baked é usada exclusivamente como precondição de hash; mudança no cartão, shape, hash ou
contagem de campos fecha novas propostas do guard. Se já houver `pending`, o HMAC de escopo
continua derivável e a próxima mensagem a invalida com resposta terminal; ela nunca retorna às
tools legadas mutantes. `NULL` sem proposta anterior continua baked atual, byte a byte.

## Rollout e rollback

`BOOKING_CONFIRMATION_GUARD_SLOTS` começa vazio. Mesmo allowlisted, ausência de
`BOOKING_CONFIRMATION_PHONE_PEPPER` (mínimo 16), contrato nulo, hash diferente ou campos
inválidos fecha o guard. Nenhum contrato de cliente é escrito nesta entrega.

Antes do canário, executar apenas o dry-run `scripts/validate-confirmation-card-contract.ts` com
tenant, slot e arquivo de contrato revisado. Ele emite somente hash, contagem e status; nunca
prompt, cartão ou literal. A futura aplicação deve ser uma transação separada: lock do clone,
snapshot reversível do baked, checagem do hash, persistência do contrato e flip de rollout
aprovado. Rollback operacional é limpar a allowlist; rollback de dado restaura o snapshot em
release separada. Não há DELETE/DROP.

## Segurança e observabilidade

Todas as queries carregam `tenant_id + slot + contact_hmac`. Logs só carregam slot/status/IDs
técnicos protegidos. O action-lock passa a usar HMAC com `ACTION_LOCK_PHONE_PEPPER`; sem esse
pepper não escreve identidade em Redis e degrada como Redis indisponível.

A classificação recebe somente os últimos três turnos `human|ai` e a mensagem atual, com teto de
caracteres e redação de telefone, e-mail, CPF, URL e apresentação do cliente. Mensagens `system`
e histórico anterior não são enviados. Serviço e profissional permanecem apenas quando
necessários à classificação. O executor é chamado sem telefone, portanto o preflight não grava
contato em `model_usage`.

A telemetria da decisão registra somente `purpose`, enum de classificação, tópico seguro quando
existir, tipo de `tool_choice`, nome allowlisted de ferramenta, resultado classificado e latência.
Texto da conversa, argumentos,
histórico, contato, calendário e payload de terceiro não entram nesses logs nem em uso de modelo.

O contrato pode conter copy comercial do próprio clone, portanto não é incluído em telemetria,
logs, testes de integração ou saída do dry-run. O hash não é fonte de verdade de histórico: é
somente uma precondição de imutabilidade entre a revisão humana e a ativação por slot.
