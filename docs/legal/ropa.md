# RoPA — Registro das Operações de Tratamento de Dados Pessoais

> **Registro of Processing Activities** (LGPD art. 37 — "registro das operações de tratamento").
> Documento vivo, mínimo e honesto. Descreve o que a plataforma **realmente** faz hoje, não o que se planeja fazer.
>
> **Card:** SCRUM-116 · **Área:** legal/LGPD · **Autor:** `18-juridico-lgpd`
> **Criado:** 2026-07-25 · **Última revisão:** 2026-08-21
>
> ⚠️ **NÃO ratificado por advogado humano.** Este RoPA e, em particular, a
> **posição jurídica de OPERADOR** (art. 5º, VII) que ele assume ainda **precisam de
> ratificação por advogado humano** antes de terem valor legal de defesa. Ver a seção
> "Pendências / DoD" ao final e o card SCRUM-116.

---

## 0. Quem é quem (papéis LGPD)

A empresa opera um SaaS de bots de WhatsApp multi-tenant. Cada cliente (dono de
barbearia/salão/consultório) é uma organização distinta que decide **por que** e
**como** trata os dados dos consumidores finais dele.

| Papel | Quem | Base do enquadramento |
|---|---|---|
| **Controlador** (art. 5º, VI) | O **cliente/dono do bot** (ex.: barbearia do Samuel, psicoterapeuta Ingrid, Meduzza). É ele quem determina as finalidades do tratamento dos dados dos consumidores finais dele. | Ele escolhe atender via WhatsApp, define a persona, o catálogo, a agenda e retém a relação com o cliente final. |
| **Operador** (art. 5º, VII) | **A empresa (Startap / plataforma)**. Trata os dados pessoais dos consumidores finais **em nome e por conta do controlador**, conforme as instruções dele (configuração do clone). | ⚠️ **Posição assumida, ainda NÃO ratificada por advogado humano** (SCRUM-116). |
| **Suboperadores** | OpenAI, DeepSeek, Google (Calendar), WAHA/infra, AbacatePay. Ver seção 5. | Contratados pela empresa para executar partes do tratamento. |
| **Titular** (art. 5º, V) | O **consumidor final** que conversa com o bot (cliente da barbearia) **e** o dono do bot enquanto pessoa física (dados de cadastro/pagamento no portal). | — |

> Para os **dados de cadastro e pagamento do próprio dono** no portal
> (`app.startap.tech`) — e-mail, telefone, senha (hash), dados de billing — a
> empresa atua como **controladora** (é ela quem decide tratá-los para viabilizar a
> conta e cobrar a mensalidade B2B).

---

## 1. Operações de tratamento (o que tratamos)

### 1.1 Mensagens de WhatsApp (conversa bot ↔ consumidor final)

- **Dados:** conteúdo das mensagens (texto e áudio transcrito), telefone do
  consumidor final, nome de exibição do WhatsApp, foto de perfil quando
  disponibilizada pela plataforma, `chatId`, timestamps, status de entrega.
- **Origem:** webhook do WAHA a cada mensagem recebida/enviada; para a foto, consulta
  no contexto da sessão do controlador.
- **Finalidade:** operar o atendimento automatizado (agendar, responder dúvidas,
  pré-venda) e, quando o CRM estiver habilitado, identificar o contato na carteira
  do controlador **em nome do controlador**.
- **Base legal (art. 7º):** execução de contrato / legítimo interesse **do
  controlador** perante o titular (o consumidor escolheu falar com aquele
  estabelecimento). A empresa executa como operador.
- **Onde vive:** Postgres (`startap_database`), store do WAHA no mesmo Postgres. A
  foto do CRM fica somente em cache Redis por até 24 horas, escopado por tenant e
  cliente, sem URL pública ou persistência em banco; é invalidada na exclusão do contato.
- **Áudio:** transcrito via OpenAI `gpt-4o-mini-transcribe`; o áudio não é retido
  como arquivo — vira texto e segue o ciclo da mensagem.

### 1.2 Agenda / Google Calendar

- **Dados:** eventos de agenda (data/hora, serviço, nome e telefone do cliente
  final no corpo/descrição do evento), `gcalEventId`.
- **Origem:** criados pelo bot ou lidos da agenda do controlador via Service
  Account (ADR 0024). Sync periódico GCal→Faturamento (ADR 0031).
- **Finalidade:** marcar/remarcar/cancelar horários e espelhar no faturamento do
  controlador.
- **Base legal:** execução de contrato do controlador com o consumidor final.
- **Onde vive:** Google Calendar (do controlador) + espelho no Postgres
  (`atendimentos`, `client_billing`). Ver **§ 1.5** sobre o hash do `gcalEventId`.

### 1.3 Dados de agendamento / atendimento

- **Dados:** serviço, profissional, valor, forma de pagamento, comissão, status,
  vínculo ao consumidor final.
- **Finalidade:** gestão operacional e financeira do negócio do controlador
  (registro, não gateway — ADR 0026).
- **Base legal:** execução de contrato / legítimo interesse do controlador.
- **Onde vive:** Postgres (`atendimentos`, ledger de pacotes).

### 1.4 Telefones (identificador transversal)

- **Dados:** número de telefone (DDI+DDD+número, ADR 0028) do consumidor final e
  do dono.
- **Finalidade:** roteamento multi-tenant, identidade do titular na conversa,
  notificações, billing.
- **Base legal:** execução de contrato / legítimo interesse do controlador.
- **LGPD by design:** o núcleo do bot/router **não** persiste telefone em texto
  claro nos logs — telefone é **hasheado** antes de logar (SCRUM-117). Pendência
  residual de PII em log no PORTAL: SCRUM-91.

### 1.5 ⚠️ `gcalEventId` hasheado — metadado ADJACENTE A DADO DE SAÚDE

Este item é destacado por **risco elevado** e merece atenção especial na
ratificação humana.

- **O que é:** ao fazer soft-delete/auditoria do sync GCal→Faturamento (ADR 0031,
  migration 074), a plataforma registra o **hash** do `gcalEventId`, não o id em
  claro, na trilha de auditoria (`deleted_reason` / `deleted_by`).
- **Por que é sensível:** o clone da **psicoterapeuta Ingrid** trata agenda de
  **sessões de psicoterapia**. Um evento de agenda de um psicoterapeuta, mesmo
  reduzido a um identificador, é **metadado adjacente a dado de saúde** (art. 5º,
  II — dado sensível): a mera existência de um agendamento recorrente com aquele
  profissional revela que o titular é paciente de saúde mental.
- **Mitigação atual:** o id é **hasheado** justamente para não expor, na trilha de
  auditoria, um ponteiro direto para o evento de saúde (LGPD art. 12 §2 —
  anonimização/pseudonimização de metadado). O **conteúdo** clínico da sessão
  nunca é tratado pela plataforma; o que transita é agenda (horário) + nome.
- **Consequência de tratamento de dado sensível:** tratamento de dado de saúde
  exige base legal específica (art. 11) e reforça o dever de segurança. Enquanto a
  base do art. 11 aplicável (tutela da saúde por profissional / consentimento) é
  **do controlador** (a psicoterapeuta), a empresa como operador deve garantir que
  o metadado adjacente permaneça pseudonimizado e de acesso restrito.
- ⚠️ **Limite da mitigação (achado de 29/07):** o hash acima cobre a trilha de
  auditoria, mas apuraram-se **três sinks que ainda logavam o id em claro** —
  mensagem de erro do GCal, `reconciliationHook` e `teste_barbearia.ts` — corrigidos
  nas PRs #531/#533. **Logs gravados antes desse fix ainda contêm o id cru** e
  aguardam decisão de purga (§ 4).
- **A ratificar com advogado humano:** se o hash + minimização são suficientes, ou
  se há dever adicional (ex.: contrato específico de operador para dado sensível,
  DPIA/RIPD para o clone de saúde).

---

## 2. Categorias de titulares

- **Consumidores finais** que conversam com os bots (clientes das barbearias/
  salões/consultório).
- **Donos dos bots** (pessoas físicas) enquanto titulares dos dados de cadastro e
  pagamento no portal.
- **Colaboradores** dos donos (barbeiros) com login read-only no painel de
  colaborador.

---

## 3. Base legal (resumo)

| Operação | Base legal (LGPD art. 7º / 11º) | Titular do enquadramento |
|---|---|---|
| Mensagens WhatsApp / atendimento | Execução de contrato / legítimo interesse **do controlador** | consumidor final |
| Foto de perfil do WhatsApp no CRM (quando habilitado) | Mesma base do atendimento do controlador | consumidor final |
| Agenda / GCal | Execução de contrato do controlador | consumidor final |
| Agendamento de psicoterapia (§1.5) | ⚠️ Dado de saúde — base do **art. 11** é do controlador (Ingrid) | paciente |
| Cadastro / conta do portal | Execução de contrato (empresa = controladora) | dono |
| Billing / PIX (AbacatePay) | Execução de contrato + obrigação legal (fiscal) | dono |
| Aceite de termos (prova com hash) | Cumprimento de obrigação / exercício de direitos (SCRUM-1) | dono |

> A empresa como **operador** não define base legal própria para os dados dos
> consumidores finais — ela executa sob a base do controlador. As bases acima são
> a leitura **preliminar** da plataforma e dependem de ratificação humana.

---

## 4. Retenção e eliminação

- **Regra atual:** retenção por idade **ATIVA em produção** (SCRUM-136, migration
  076). Medido em 31/07 nos containers `startap-api` e `startap-worker`:
  `CHAT_RETENTION_ENABLED=true`, `CHAT_RETENTION_DAYS=90` — histórico de conversa
  é eliminado após **90 dias**, sem dry-run. Revisão jurídica do prazo segue
  recomendada (ver § 9).
- **Foto de perfil no CRM (quando habilitado):** cache Redis técnico de no máximo 24
  horas, sem URL pública ou cópia persistida em banco, log, métrica ou backup; exclusão
  do contato invalida o cache antes do TTL.
- **Sync GCal (ADR 0031):** espelho **total** da agenda — evento que some do
  Google Calendar sai do Previsto/Faturado, inclusive passado/pago; soft-delete
  com trilha `deleted_reason`/`deleted_by` + id **hasheado** (LGPD art. 12 §2).
- **Backups:** dump diário off-site cifrado com `age` (SCRUM-20). ⚠️ Dumps antigos
  em **texto claro** (com PII: telefones, mensagens, hashes, aceites) ainda no
  repositório de backup — limpeza é decisão destrutiva pendente do Bruno; trava a
  retenção LGPD dos históricos do cliente Seven 7 (churn).
- ⚠️ **Passivo de log com `gcal_event_id` em claro (achado de 29/07, posterior à
  1ª redação deste RoPA):** o hash descrito em § 1.5 cobria o campo do SCRUM-90/91,
  mas em 29/07 apuraram-se **vazamentos residuais do id cru por outros caminhos** —
  mensagem de erro do GCal, `reconciliationHook` e `teste_barbearia.ts` — corrigidos
  nas PRs #531 e #533. Consequência: **logs já gravados antes do fix ainda contêm o
  id em claro**, e o parecer do jurídico interno é que a **purga antecipada desses
  logs é NECESSÁRIA**. Volume e janela **ainda não medidos**. Decisão de purga
  pendente do Bruno.
- **Pendência de retenção viva:** retenção LGPD dos históricos do Seven 7 (churn) e
  a purga do passivo de log acima.

> Este RoPA deve ser **atualizado** quando a purga do passivo de log for executada
> e quando o volume/janela afetados forem medidos.

---

## 5. Compartilhamento / suboperadores (com quem compartilhamos)

Todos são **suboperadores** contratados pela empresa. Transferência internacional
onde indicado (art. 33) — a ratificar as salvaguardas com advogado humano.

| Suboperador | O que recebe | Finalidade | Local | Obs. |
|---|---|---|---|---|
| **OpenAI** | Texto das mensagens (e áudio para transcrição via `gpt-4o-mini-transcribe`), contexto da conversa | Gerar respostas do bot + transcrever áudio | EUA (transf. internacional) | Modelo `gpt-4o`/`gpt-5.4`. Inclui conversas do clone de psicoterapia (§1.5). |
| **DeepSeek** | Texto das mensagens/contexto (apenas bot de prospecção próprio "Lola") | Gerar respostas | fora do BR (transf. internacional) | Usado só na Lola (prospecção própria), não nos clones de cliente. |
| **Google (Calendar)** | Eventos de agenda: data/hora, nome, telefone, serviço | Ler/gravar a agenda do controlador via Service Account | EUA (transf. internacional) | Credencial (JSON da SA) cifrada AES-256-GCM por clone (ADR 0024). |
| **WAHA / infra WhatsApp** | Todas as mensagens, telefone, mídia | Ponte técnica com o WhatsApp (envio/recebimento) | VPS própria (`187.77.242.220`, BR) + protocolo do WhatsApp/Meta | WAHA CORE self-hosted; o WhatsApp/Meta é o transporte subjacente. |
| **AbacatePay** | Dados de billing do **dono** (PIX, identificação para cobrança) | Processar a mensalidade B2B | BR | Só dados do dono; consumidor final não passa por gateway. |
| **VPS / hospedagem** | Todos os dados em repouso (Postgres, backups) | Hospedar a plataforma | BR (VPS) + off-site do backup | Backup cifrado `age` (SCRUM-20). |

> **Não** compartilhamos dados de um controlador com outro (isolamento
> multi-tenant, `tenant_id`; sem RLS ainda — P2). **Não** vendemos dados. **Não** há
> outros destinatários além dos suboperadores acima.

---

## 6. Medidas de segurança (art. 46 — resumo)

- SSH chave-only; NPM admin só em `127.0.0.1` (túnel); app roda como role Postgres
  CRUD-only (não superuser); segredos fora do compose; `.env` chmod 600
  ([[hardening-seguranca-2026-07-10]], SCRUM-45/71/72).
- Telefone **hasheado** no log do núcleo bot/router (SCRUM-117).
- Credenciais Google SA cifradas AES-256-GCM por clone.
- Backups cifrados com `age` (SCRUM-20).
- Isolamento multi-tenant por `tenant_id` (⚠️ **sem RLS ainda** — P2, dívida).
- **Dívidas conhecidas:** PII em log do portal (SCRUM-91); RLS ausente; dumps
  antigos em claro; `ADMIN_PASS` fraco do gestão (SCRUM-118).

---

## 7. Direitos dos titulares (art. 18)

- **Consumidor final:** o exercício de direitos (acesso, correção, eliminação) é
  primariamente perante o **controlador** (o dono do bot). A empresa, como
  operador, apoia o controlador a atender a requisição.
- **Dono:** exerce direitos diretamente perante a empresa (controladora dos dados
  de conta/billing). Portal tem troca de senha self-service, edição de perfil e
  exclusão de clone (que remove sessão WAHA + limpa órfãos).
- **Canal:** ⚠️ **a definir** — não há canal formal de requisição de titular
  documentado. A ratificar com advogado humano (encarregado/DPO — art. 41).

---

## 8. Pendências / DoD do card SCRUM-116

- [ ] 🔴 **Ratificação da posição de OPERADOR por advogado HUMANO** — é o DoD
  central do card. Este documento **assume** o enquadramento operador (§0) mas
  **não** tem valor de defesa até um advogado humano confirmar (ou corrigir para
  controlador/co-controlador conforme o caso, especialmente para o dado de saúde
  do §1.5).
- [ ] Definir e nomear **encarregado/DPO** (art. 41) e canal de titular (§7).
- [ ] Avaliar necessidade de **contrato de operador** específico e de **DPIA/RIPD**
  para o clone de psicoterapia (dado de saúde, §1.5).
- [ ] Revisar **salvaguardas de transferência internacional** (OpenAI, DeepSeek,
  Google — §5).
- [x] Ligar a **retenção por idade** (SCRUM-136) — ATIVA, 90 dias, medido em prod
  31/07; §4 atualizada.
- [ ] Revisar juridicamente se **90 dias** é o prazo adequado por categoria de dado.
- [ ] Decidir destino dos **dumps antigos em claro** (retenção LGPD Seven 7).
- [ ] Decidir a **purga do passivo de log com `gcal_event_id` em claro** (achado de
  29/07, §4) e medir volume/janela afetados.

---

*Este RoPA é um artefato de conformidade interno, mínimo e vivo. Deve ser revisado
a cada nova operação de tratamento, novo suboperador ou mudança de base legal, e
**ratificado por advogado humano** antes de ser usado como peça de defesa perante a
ANPD.*
