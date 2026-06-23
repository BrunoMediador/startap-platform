# ADR 0026 — `atendimentos` como fonte da verdade do financeiro do cliente (faturamento + comissão)

- **Status:** PROPOSTO (aguardando aprovação do Bruno)
- **Data:** 2026-06-23
- **Autor:** 01-arquiteto
- **Aprovado por:** — (pendente Bruno)
- **Relacionados:** ADR 0006 (Google Calendar por clone — dono do horário), ADR 0018 (`tenant_id` por cliente — isolamento), ADR 0023/0024 (`clone_colaboradores`, agenda por profissional), ADR 0025 (pacotes/`package_redemptions` — ledger por `gcal_event_id`), `client_billing`/AbacatePay (mensalidade B2B — domínio SEPARADO).

---

## Contexto

A visão (validada com o Bruno): transformar o portal num **app de gestão de serviço** (referência mental: AppBarber), genérico pra qualquer empresa de serviço — barbearia, salão, manicure, estética, clínica. O operador **registra/conclui o atendimento pelo painel** e captura **quanto entrou, quem atendeu e como foi pago**. Disso nascem dois relatórios que o negócio do cliente precisa: **faturamento** e **comissão por profissional**.

Hoje o sistema não tem fonte da verdade do **dinheiro do negócio do cliente**:

- **Google Calendar** é dono do **horário/slot** (ADR 0006) — mas evento de agenda não é registro financeiro: não carrega valor confiável, forma de pagamento, nem comissão; e nem todo atendimento passa pela agenda (walk-in).
- **`package_redemptions`** (ADR 0025) é ledger de **saldo de pacote** por `gcal_event_id` — não é faturamento.
- **`client_billing` / AbacatePay** é a **mensalidade B2B que o cliente paga PRA NÓS** — não tem nada a ver com o faturamento DELE.

Faltando essa camada, o cliente não consegue fechar caixa do dia, ver faturamento por período/profissional/forma de pagamento, nem calcular quanto deve de comissão. É a feature que falta pro portal virar gestão de verdade.

Restrições que moldam a decisão (constantes do projeto):

- **Sem ORM.** Schema é responsabilidade explícita: migration SQL raw idempotente e aditiva versionada por `schema_migrations` (`scripts/migrate.sh`). Próximo número livre: **058**.
- **Isolamento P0 (ADR 0018):** toda linha nova carrega `slot` (FK → `flow_clones`) + `tenant_id UUID` desde o nascimento — caminho de RLS. Reusa exatamente o padrão de `clone_colaboradores` (053) e `package_redemptions` (056).
- **Reversível e aditivo:** nenhum pagante pode ser afetado. Tabela/rotas novas atrás de flag; a Fase 1 **não toca o fluxo de agendamento em produção**.

---

## Decisão

**Criar a tabela `atendimentos` no Postgres como FONTE DA VERDADE do financeiro do negócio do cliente** (faturamento + comissão). O atendimento é o registro de que **um serviço foi prestado e gerou (ou não) receita**, com **valor, profissional e forma de pagamento**.

Cravamos cinco pontos:

1. **`atendimentos` = dono do DINHEIRO; Google Calendar = dono do HORÁRIO.** Domínios separados que se ligam por `gcal_event_id` **NULLABLE**. NULL é cidadão de primeira classe: cobre o **walk-in** registrado direto no painel, sem agenda. Não duplicamos slot/horário em `atendimentos` — quem quer reagendar mexe no GCal (fluxo atual, ADR 0006); quem quer fechar caixa mexe no atendimento.

2. **Separação dura de domínios financeiros.** `client_billing`/AbacatePay (mensalidade B2B que o cliente paga **pra nós**) e `atendimentos` (faturamento do negócio **dele**) **nunca se misturam** — tabelas, telas e relatórios separados. Um relatório nunca soma uma coluna da outra. Isso é regra de design, não detalhe de implementação.

3. **Comissão (MVP) = percentual fixo por profissional.** `clone_colaboradores` ganha `comissao_pct`. No ato de concluir o atendimento, congelamos `comissao_pct` + `comissao_cents` **na linha do atendimento** (snapshot — mudar o % do profissional amanhã não reescreve o histórico). MVP comissiona sobre o **valor do atendimento** (registramos a regra "bruto vs líquido": bruto no MVP; desconto/líquido vira opção na Fase 2). Comissão por-serviço / variável = Fase 2.

4. **Genérico / multi-vertical.** Nenhuma coluna cita barbearia. Vocabulário neutro: **profissional / serviço / atendimento**. A vertical é só rótulo de UI via `flow_clones.area` (barbearia/salão/manicure/estética/clínica). Mesma tabela serve a todos.

5. **Aditivo e flag-gated.** Migration 058 só **cria** tabela + coluna nova (sem backfill, sem tocar linha existente). Rotas/telas atrás de flag (`ATENDIMENTOS_ENABLED`, default OFF). Flag OFF = produção idêntica a hoje; nenhum pagante afetado.

**Escopo do `product_type` na v1:** cobre **individual** (com lista de profissionais — exige popular `clone_colaboradores` no individual, que hoje tem 0 linhas) **e estabelecimento**. Multi-serviço / multi-profissional na mesma comanda = Fase 2.

---

## Modelo de dados (resumido — DDL detalhada vai na migration 058, fora desta PR)

Tabela NOVA `atendimentos`. Toda linha carrega `slot` + `tenant_id` (P0). Mesmo padrão de 053/056.

| Coluna | Tipo | Nota |
|---|---|---|
| `id` | `BIGSERIAL PK` | |
| `slot` | `TEXT NOT NULL` | FK → `flow_clones(slot) ON DELETE CASCADE` |
| `tenant_id` | `UUID NOT NULL` | carimbado na criação (ADR 0018) |
| `gcal_event_id` | `TEXT NULL` | **liga ao horário; NULL = walk-in sem agenda** |
| `cliente_nome` | `VARCHAR(160) NULL` | texto livre v1 (ref a tabela de clientes = futuro) |
| `cliente_contato` | `VARCHAR(64) NULL` | telefone/contato; LGPD: não logar em claro |
| `servico_nome` | `VARCHAR(160) NULL` | snapshot do nome do serviço |
| `valor_cents` | `INTEGER NOT NULL DEFAULT 0` | sempre centavos inteiros (nunca float) |
| `desconto_cents` | `INTEGER NOT NULL DEFAULT 0` | |
| `forma_pagamento` | `VARCHAR(24) NULL` | dinheiro/pix/credito/debito/... (validado no app) |
| `colaborador_id` | `BIGINT NULL` | FK → `clone_colaboradores(id)`; NULL = individual sem profissional |
| `comissao_pct` | `NUMERIC(5,2) NULL` | snapshot do % no ato |
| `comissao_cents` | `INTEGER NOT NULL DEFAULT 0` | snapshot do valor calculado |
| `status` | `VARCHAR(16) NOT NULL DEFAULT 'realizado'` | `agendado` \| `realizado` \| `cancelado` (validado no app) |
| `data` | `DATE NOT NULL` | dia do atendimento (base dos relatórios) |
| `created_at` / `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | |

Índices: `ix_atend_slot(slot)`, `ix_atend_tenant(tenant_id)`, `ix_atend_data(slot, data)` (relatório por período), `ix_atend_colab(colaborador_id)` (comissão por profissional). `gcal_event_id` **sem UNIQUE** (um evento pode em tese gerar 0..1 atendimento; a unicidade fica no app pra não travar correção manual).

`clone_colaboradores` ganha `comissao_pct NUMERIC(5,2) NOT NULL DEFAULT 0` (aditivo). Individual = 0 linhas hoje; v1 do checkout popula essa lista.

**Valores sempre em centavos inteiros** (consistente com `*_cents` do billing). Comissão e desconto idem.

---

## Consequências (positivas)

- Portal vira gestão: cliente fecha caixa, vê faturamento por período/profissional/forma e a comissão a pagar — sem planilha paralela.
- Walk-in deixa de ser invisível: atendimento sem agenda entra no faturamento (`gcal_event_id NULL`).
- Snapshot de `comissao_pct`/`servico_nome`/`valor` na linha → histórico financeiro **imutável** a mudanças de cadastro (mudar o % amanhã não reescreve o passado).
- Isolamento desde o nascimento (`slot` + `tenant_id`) → pronto pra RLS da Fase 2 do ADR 0018, sem reabrir schema.
- Zero risco pra pagante: aditivo + flag OFF default. WAHA/bots intocados.
- Genérico: uma tabela serve barbearia, salão, manicure, estética, clínica — multi-vertical sem coluna específica.

---

## Riscos / Trade-offs

- **Dupla contagem de receita (atendimento × pacote).** Um atendimento pago com **crédito de pacote** (ADR 0025) já teve a venda do pacote contabilizada antes. Se `atendimentos` lançar `valor_cents` cheio nesse caso, a receita é contada 2x. **Mitigação proposta (decidir na Fase 2):** `forma_pagamento='pacote'` lança `valor_cents=0` no atendimento (a receita vive na venda do pacote), OU uma flag `origem_credito` que o relatório de faturamento exclui. Cravado como risco a reconciliar — a ponte bot/pacote→atendimento é Fase 2 justamente por isto.
- **Dois registros do mesmo fato (GCal + atendimento) podem divergir** (ex.: cancelou no GCal, não no painel). v1 trata como independentes: o atendimento é a verdade do dinheiro, o GCal é a verdade do horário. Reconciliação automática = follow-up.
- **`cliente_nome`/`cliente_contato` como texto livre** não dá histórico por cliente final nem dedupe. Aceito na v1 (ref a tabela de clientes do negócio = futuro); evita modelar CRM agora.
- **Bruto vs líquido na comissão:** MVP comissiona sobre o valor cheio. Se o cliente esperar comissão sobre líquido (pós-desconto/taxa de cartão), é re-trabalho. Mitigado por registrar a regra explicitamente e congelar o `comissao_cents` calculado.
- **Popular `clone_colaboradores` no individual** muda um pressuposto de 053 ("individual = 0 linhas"). Risco baixo (aditivo, sem FK nova obrigatória), mas o roteamento por nome do bot (ADR 0023) **não deve** passar a depender dessas linhas no individual — manter os domínios separados.

---

## Alternativas consideradas

### A — Tabela `atendimentos` no Postgres, aditiva e flag-gated ← **ESCOLHIDA**
- **Pros:** fonte da verdade transacional e consultável (SUM por período/profissional/forma em SQL raw); isolamento por `slot`+`tenant_id`; reusa o padrão 053/056; reversível.
- **Contras:** mais uma tabela e o risco de dupla contagem com pacotes (mitigável).

### B — Guardar valor/profissional/pagamento em `extendedProperties` do evento do Google Calendar
- **Pros:** zero schema novo; um lugar só por atendimento.
- **Contras (decisivos):** **não dá relatório** — não existe `SUM`/`GROUP BY` no GCal; cada relatório viraria varredura de API paginada, lenta e sujeita a rate limit/quota; sem transação nem `tenant_id`/isolamento; walk-in sem evento fica de fora; acopla o financeiro a uma API externa e a um formato sem schema. **Descartada:** financeiro precisa de banco relacional, não de metadados de calendário.

### C — Reusar `package_redemptions` / `billing_charges` como registro de faturamento
- **Pros:** nenhuma tabela nova.
- **Contras:** quebra a separação dura de domínios — `package_redemptions` é saldo de pacote, `billing_charges` é a mensalidade B2B nossa. Sobrecarregar qualquer uma com faturamento do cliente garante relatório errado e mistura "o que ele paga pra nós" com "o que ele fatura". **Descartada** pela regra 2.

### D — Cliente usa um app de gestão externo (AppBarber etc.) e a gente só agenda
- **Pros:** zero build.
- **Contras:** abandona a visão de portal-gestão; perde retenção/upsell; não integra com o bot/agenda que já temos. **Descartada** — é justamente o produto que o Bruno quer construir.

---

## Fases (incremental, reversível)

- **Fase 0 — este ADR (decisão).** Sem código.
- **Fase 1 — MVP (atrás de flag).** Migration 058 (`atendimentos` + `clone_colaboradores.comissao_pct`); concluir atendimento pelo painel (valor + profissional + forma de pagamento); **relatório de faturamento** (período / profissional / forma); **relatório de comissão a pagar** por profissional. Não altera o fluxo de agendamento atual.
- **Fase 2 — Integração.** Ponte bot/agenda → `atendimentos` (evento concluído vira atendimento); multi-serviço por comanda; comissão por serviço/variável; bruto vs líquido; **reconciliação da dupla contagem com pacotes** (resolve o risco 1).
- **Fase 3 — Caixa.** Fechamento de caixa, split de pagamento, dashboard financeiro do negócio.

---

## Validação (DoD desta decisão / Fase 1)

- Migration 058 idempotente (roda 2x, 2ª é no-op), aditiva, com bloco de rollback no cabeçalho (release separada, regra de ouro). Nenhum `DROP/DELETE/TRUNCATE` sobre dado existente.
- Toda linha de `atendimentos` nasce com `slot` + `tenant_id` preenchidos (teste de isolamento: query sem `slot`/`tenant_id` não retorna cross-cliente).
- Flag OFF → produção byte-a-byte idêntica a hoje; nenhum pagante afetado; WAHA intocado.
- Relatório de faturamento confere com a soma manual dos atendimentos do período (paridade).
- Comissão: `comissao_cents` congelado bate com `valor_cents * comissao_pct` no ato; alterar o % do profissional depois não muda atendimentos passados.

## O que precisa de decisão/aprovação do Bruno

1. **Aprovar `atendimentos` como fonte da verdade do financeiro** (Postgres, não GCal) e a **separação dura** entre `client_billing` (mensalidade nossa) e `atendimentos` (faturamento dele). — pilar do ADR.
2. **Comissão MVP = % fixo por profissional, sobre o valor bruto, congelado no ato.** Confirmar bruto (não líquido) no MVP; por-serviço/variável fica Fase 2.
3. **Tratamento de atendimento pago com pacote** (risco de dupla contagem): confirmar a regra `forma_pagamento='pacote'` → `valor_cents=0` (receita fica na venda do pacote), a decidir em definitivo na Fase 2.
4. **Popular `clone_colaboradores` no individual** (hoje 0 linhas) pra ter lista de profissionais no checkout — confirmar que isso NÃO deve influenciar o roteamento por nome do bot (ADR 0023), mantendo os domínios separados.
