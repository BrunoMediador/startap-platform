# ADR 0006: Google Calendar por clone — Service Account JSON por clone

> **Quem escreve:** `arquiteto`
> **Onde fica:** `docs/adr/0006-google-calendar-por-clone.md`
> **Quando usar:** decisão técnica de impacto (mudança >300 linhas, novo pacote, mudança de fronteira entre módulos)

---

**Status:** Aceita
**Data:** 2026-05-17
**Autor:** arquiteto
**Aprovado por:** Bruno (2026-05-18)

---

## Log de revisões

| Data | Autor | O que mudou |
|---|---|---|
| 2026-05-17 | arquiteto | Primeira versão — proposta OAuth refresh token por clone |
| 2026-05-18 | arquiteto | Segunda rodada — Bruno escolheu Service Account JSON upload em vez de OAuth web flow. Defaults assumidos para as 3 questões pendentes. Status alterado para "aceita". |

---

## Contexto

**Estado atual**

`packages/integrations/src/google-calendar/client.ts` instancia o cliente Google Calendar lendo exclusivamente variáveis de ambiente globais: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID`. Não existe campo de credencial por clone em `flow_clones`.

**Por que incomoda**

Todos os clones de barbearia — hoje e futuramente — agendam na mesma agenda (Samuel/Bruno). Isso bloqueia qualquer venda de clone pago de barbearia: o agendamento vai para a agenda errada e o cliente não tem como vincular sua própria agenda.

O princípio 8 do modelo operacional (`docs/produto/modelo-operacional-startap.md`) é explícito: "clone com agenda → obrigatório informar token Google Calendar do cliente."

**Restrições**

- Clientes são pessoas físicas ou pequenas empresas; a maioria usa Gmail pessoal, não Google Workspace.
- A Startap não possui Workspace com domain-wide delegation ativo.
- Publicar no Google Workspace Marketplace é processo burocrático estimado em semanas.
- O JSON da Service Account contém `private_key` — dado sensível (LGPD): decisão sobre criptografia at-rest registrada como débito técnico consciente (ver Decisões assumidas, D1).

---

## Decisão

Cada clone de barbearia armazenará as credenciais de uma **Service Account (SA) JSON** por clone, junto com o `calendar_id` fornecido pelo cliente e metadados de status em colunas dedicadas de `flow_clones`. O cliente Google Calendar em `packages/integrations` será refatorado para aceitar credenciais injetadas via SA JSON em vez de ler apenas o env. O painel-admin ganhará endpoints de upload/status/remoção/teste e UI de conexão por clone. Não há OAuth web flow nem callback público — o upload é feito diretamente no painel autenticado da Startap.

**Fluxo operacional:**

1. Bruno (ou time de vendas) cria 1 SA por cliente no Google Cloud (projeto Startap ou do cliente).
2. Baixa o JSON da SA.
3. No painel, no clone do cliente, clica "Conectar Google Calendar".
4. Cola o JSON ou faz upload do arquivo.
5. Painel parseia, extrai `client_email`, exibe: "compartilhe sua agenda com este email".
6. Cliente compartilha a agenda dele com o `client_email` da SA (permissão "Fazer alterações em eventos").
7. Painel testa a conexão (tenta listar eventos) → marca `gcal_status=active`.
8. Bot do clone usa essa SA para criar eventos.

**Nota sobre `primary`:** SA não acessa `primary` do cliente automaticamente. Cliente deve fornecer o `calendar_id` (ex: email da agenda ou ID custom). Painel exibe dica: "ID da agenda em https://calendar.google.com → Configurações → Integrar agenda → ID da agenda".

---

## Decisões assumidas (questões resolvidas por Bruno em 2026-05-18)

| # | Questão | Decisão assumida | Justificativa |
|---|---------|-----------------|---------------|
| D1 | Criptografar `gcal_credentials_json` at-rest? | **Não criptografar por enquanto** | Banco só acessível por admin via psql/painel (auth obrigatória). Backup do banco já é dado sensível. Criptografar agora cria débito de gestão de chave-mestra sem benefício imediato. **Débito futuro:** quando passar de 10 clientes pagantes OU houver auditoria LGPD, criptografar com `pgcrypto` ou similar. |
| D2 | URL de redirect OAuth | **Não se aplica** | Não há OAuth web flow neste modelo. Upload direto via painel autenticado. |
| D3 | Tipo de OAuth consent | **Não se aplica** | Não há OAuth user-facing. Painel da Startap é autenticado, não precisa de consent screen do Google. |

---

## Schema final

```sql
ALTER TABLE flow_clones ADD COLUMN gcal_credentials_json TEXT;        -- JSON da SA inteiro
ALTER TABLE flow_clones ADD COLUMN gcal_client_email     TEXT;        -- extraído do JSON para exibir no painel
ALTER TABLE flow_clones ADD COLUMN gcal_calendar_id      TEXT;        -- agenda alvo (cliente informa o ID)
ALTER TABLE flow_clones ADD COLUMN gcal_status           TEXT DEFAULT 'pending'; -- pending/active/invalid/disabled
ALTER TABLE flow_clones ADD COLUMN gcal_connected_at     TIMESTAMPTZ;
ALTER TABLE flow_clones ADD COLUMN gcal_last_check_at    TIMESTAMPTZ; -- para retry/expiração futuro
```

6 colunas. Todas nullable (sem default obrigatório que bloqueie tabela grande). Sem `DROP`, sem `TRUNCATE`.

---

## Alternativas consideradas

### Opção A — Token OAuth refresh por clone (primeira proposta — descartada)

- **Como funcionaria:** Colunas `gcal_refresh_token`, `gcal_calendar_id`, `gcal_client_email`, `gcal_status`, `gcal_connected_at` em `flow_clones`. Fluxo OAuth padrão no painel: botão "Conectar Google Calendar" → redirect com `state=slot` → callback grava token → status `active`. Bot instancia client com token do clone.
- **Pros:** cobre Gmail pessoal e Google Workspace sem distinção. Schema simples. Sem dependência de burocracia externa.
- **Contras:** refresh_token é dado sensível. Requer callback público (`/api/clones/:slot/gcal/callback`) acessível pela internet. CSRF via `state` assinado. Se o cliente revogar o acesso no Google, o bot falha silenciosamente. Processo de configuração do app no Google Cloud Console (consent screen, redirect URIs).
- **Descartada porque:** Bruno optou por modelo operacional mais simples — sem callback público, sem OAuth flow, sem dependência de configuração do Google Cloud por ambiente.

### Opção B — Service Account com domain-wide delegation

- **Como funcionaria:** Uma service account da Startap impersona a conta do cliente via DWD.
- **Pros:** token único gerenciado pela Startap; cliente não precisa passar por OAuth.
- **Contras:** requer que o cliente tenha Google Workspace (não funciona com Gmail pessoal). A maioria dos barbeiros usa Gmail pessoal. Inviável como solução geral.
- **Descartada porque:** exclui o público-alvo principal.

### Opção C — Service Account JSON upload por clone (ESCOLHIDA)

- **Como funcionaria:** Bruno cria 1 SA por cliente, baixa o JSON, faz upload no painel. Painel extrai `client_email`, instrui cliente a compartilhar a agenda com esse email. SA usa `calendar_id` informado pelo cliente para criar eventos.
- **Pros:** sem callback público. Sem consent screen do Google. Sem OAuth flow. Upload direto no painel autenticado. Revogação por clone sem afetar outros. Operação manual mas simples para escala atual (poucos clientes).
- **Contras:** operação manual (criar SA por cliente no Google Cloud). JSON da SA contém `private_key` — débito de criptografia registrado. SA não acessa `primary` do cliente — cliente precisa fornecer `calendar_id` explicitamente.
- **Escolhida porque:** operação mais simples para a escala atual, sem infraestrutura de callback/OAuth, compatível com todos os tipos de conta Google do cliente.

### Opção D — App publicado no Google Workspace Marketplace

- **Como funcionaria:** Startap publica um app verificado; cliente instala e autoriza.
- **Pros:** experiência de instalação padrão Google.
- **Contras:** processo de verificação do Google pode levar semanas. Exige política de privacidade, revisão manual, maturidade de produto que não temos agora.
- **Descartada porque:** inviável no prazo da missão 003-L.

---

## Consequências

### Positivas

- Desbloqueio imediato de venda de clones de barbearia pagantes.
- Isolamento real: revogar ou atualizar SA de um clone não afeta nenhum outro.
- Sem callback público exposto na internet — superfície de ataque menor que OAuth flow.
- Sem dependência de configuração do Google Cloud Console por ambiente (sem redirect URIs, sem consent screen).
- Modelo extensível: o mesmo padrão (credencial injetada por clone) pode ser reusado para outras integrações futuras.

### Negativas / trade-offs

- Migration de schema com 6 colunas novas em `flow_clones`.
- Operação manual por cliente: Bruno/time de vendas precisa criar SA no Google Cloud para cada cliente novo.
- `google-calendar/client.ts` precisa de refactor para aceitar SA JSON injetado em vez de apenas env.
- `gcal_credentials_json` armazena `private_key` em texto claro no Postgres — débito de criptografia registrado (D1).
- Cliente pode esquecer de compartilhar a agenda com o `client_email` da SA — mitigação: status `pending` claro no painel + UI explica passo a passo.
- SA tem cota da Google API (10k requests/dia por default) — monitorar e pedir aumento se necessário.

### Neutras (vale registrar mas não muda decisão)

- `GOOGLE_SERVICE_ACCOUNT_JSON` pode continuar no env global para o bot Samuel enquanto a migração não estiver completa — retrocompatibilidade via fallback no client.
- `gcal_last_check_at` existe hoje apenas para retry/expiração futuro — não há lógica de expiração de SA (SAs não expiram por default).

---

## Plano de execução (fases da missão 003-L)

- **L.1 — Migration de schema:** `ALTER TABLE flow_clones ADD COLUMN gcal_*` (6 colunas). Sem código de produto. Migration aplicável sem downtime (colunas nullable sem default obrigatório).
- **L.2 — Endpoints no painel:**
  - `PUT /api/clones/:slot/gcal` — upload do JSON + `calendar_id`; parseia, extrai `client_email`, grava, marca `gcal_status=pending`.
  - `GET /api/clones/:slot/gcal/status` — retorna `{ status, client_email, calendar_id, connected_at, last_check_at }`.
  - `DELETE /api/clones/:slot/gcal` — limpa todas as colunas `gcal_*`, volta a `pending`.
  - `POST /api/clones/:slot/gcal/test` — tenta listar eventos com a SA; atualiza `gcal_status` para `active` ou `invalid` + grava `gcal_last_check_at`.
- **L.3 — Refactor de `packages/integrations/src/google-calendar/client.ts`:** aceitar `{ credentialsJson, calendarId }` injetados. Fallback para env quando não injetado (retrocompatibilidade com Samuel enquanto migração não estiver completa). Tratar `401/403` do Google → marcar `gcal_status=invalid` e logar erro descritivo.
- **L.4 — UI no painel:** botão "Conectar Calendar" no clone, modal para upload JSON + input do `calendar_id`, exibição do `client_email` (instrução de compartilhamento), indicador de status (`pending` / `active` / `invalid` / `disabled`), botão "Testar conexão", botão "Desconectar".
- **L.5 — Smoke test end-to-end:** Bruno conecta SA real num clone de teste → agenda evento → confirma na agenda do Google → confirma no painel que `gcal_status=active`.

---

## Validação

- `flow_clones` tem as 6 colunas `gcal_*` sem erro de migration.
- Clone com `gcal_status=active` agenda evento na agenda do clone, não na agenda global.
- Clone sem SA (`gcal_status=pending`) não chama a API Google e loga erro descritivo.
- `POST /api/clones/:slot/gcal/test` retorna `active` quando SA e `calendar_id` estão corretos.
- Revogar SA de um clone não afeta agendamentos de outros clones.
- `tsc -b packages/integrations` passa após refactor do client.

---

## Rollback

- **Migration:** colunas `gcal_*` são nullable e sem default obrigatório. Se necessário, remover colunas não quebra código legado. Migration de rollback: `ALTER TABLE flow_clones DROP COLUMN gcal_*` — apenas com aprovação explícita do Bruno, fora do fluxo normal.
- **Client refactor:** se fallback para env for mantido (plano L.3), o bot Samuel continua funcionando com as variáveis de env globais mesmo se a feature de SA por clone for desabilitada.
- **Endpoints:** desativar rotas no Express não afeta funcionalidade existente.

---

## Referências

- `packages/integrations/src/google-calendar/client.ts` — contrato atual a ser refatorado
- `docs/produto/modelo-operacional-startap.md` — princípio 8 (clone com agenda)
- `docs/missoes/003-L-google-calendar-por-clone.md` — missão origem
- ADR 0001 — isolamento de memória por clone (padrão de isolamento por clone adotado no repo)
