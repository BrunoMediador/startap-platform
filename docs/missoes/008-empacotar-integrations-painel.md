# Missão 008 — Empacotar @startap/integrations no painel-admin (fix gcal)

**DRI:** dev-back
**Agentes envolvidos:** arquiteto (decide A vs D), dev-back (implementa), infra (Dockerfile/CI), tester (valida)
**Apetite:** pequeno (≤ 1 dia)
**Status:** pendente
**Cliente (persona):** Bruno (Startap) e time de vendas — bloqueia conexão de Google Calendar em qualquer clone de barbearia
**Aberta em:** 2026-05-18
**PR-FAQ:** não precisa (é bugfix de empacotamento, escopo bem definido)

---

## Decisão do arquiteto (2026-05-18)

**Escolha: Opção A — Multi-stage Dockerfile.**

Justificativa:
- O problema é exclusivamente de empacotamento: o código já funciona, o módulo simplesmente não existe no container. Corrigir o Dockerfile é a mudança mínima e reversível.
- Opção D introduziria uma fronteira nova (painel-admin -> apps/api via HTTP) para um único import já existente — custo desproporcional ao ganho. Criaria dependência de rede interna, exigiria ADR e ampliaria surface de falha (apps/api fora do ar = gcal/test quebrado no painel).
- Grep confirmado: `painel-admin/server.js` tem **um único** import cruzado de packages (`server.js:2907` — `../packages/integrations/dist/google-calendar/client.js`). Não há risco de outros imports ocultos que justifiquem refatoração mais ampla.

**ADR:** não necessário — mudança restrita a infra de build (<50 linhas, sem mudança de API contract, sem nova fronteira de módulo).

### Plano de implementação (ordem obrigatória)

1. **`painel-admin/Dockerfile`** — reescrever como multi-stage:
   - Stage `builder` (`node:20-alpine`): `WORKDIR /monorepo`, copia `package.json`, `package-lock.json` e `packages/*/package.json` de todo o monorepo, roda `npm ci`, depois copia `packages/core/` e `packages/integrations/` e roda `npm run build -w @startap/core && npm run build -w @startap/integrations`.
   - Stage `runtime` (`node:20-alpine`): `WORKDIR /app`, copia `painel-admin/package.json` + `painel-admin/package-lock.json`, roda `npm ci --omit=dev`, copia `painel-admin/server.js` e `painel-admin/public/`, copia do stage builder `--from=builder /monorepo/packages/integrations/dist ./packages/integrations/dist` e `--from=builder /monorepo/packages/core/dist ./packages/core/dist`.
   - O path relativo `../packages/integrations/dist/google-calendar/client.js` resolvido de `/app/server.js` vira `/app/packages/integrations/dist/google-calendar/client.js` — correto.

2. **`painel-admin/public/index.html` (função `renderGcalContent`, linha ~5482)** — exibir `data.error` quando `status === 'invalid'` em vez do texto fixo "Verifique se a agenda foi compartilhada". Escopo dev-front, mesmo PR (bonus já mapeado).

3. **`docker-compose.yml` no servidor de produção** (`/root/automacoes/docker-compose.yml`, fora deste repo) — infra altera `build.context` do serviço `painel-admin` de `./painel-admin` para `.` (raiz do clone do repo) e `dockerfile: painel-admin/Dockerfile`. Infra valida localmente antes de qualquer deploy.

4. **CI (`.github/workflows/`)** — se o workflow de CI faz `docker build` do painel-admin com contexto `./painel-admin`, infra atualiza o `context` correspondente no workflow. Checar se há step de build de imagem antes de mergear.

5. **Smoke test local** — dev-back ou infra roda `docker build -f painel-admin/Dockerfile -t painel-test .` a partir da raiz do monorepo e confirma que `docker run --rm painel-test ls /app/packages/integrations/dist/google-calendar/client.js` retorna o arquivo antes de abrir PR.

6. **DoD final** — tester executa checklist completo conforme seção abaixo; infra faz rebuild em produção; Bruno valida `gcal_status=active` no clone `bruno_barbershop`.

### Riscos adicionais (não cobertos no doc original)

- **`node_modules` symlinks do workspace npm:** no stage builder o `npm ci` da raiz cria symlinks em `node_modules/@startap/core`. No stage runtime o `npm ci` do painel-admin não os cria. O `dist/` copiado explicitamente cobre isso para runtime, mas o dev-back deve verificar que `packages/core/dist/` não tem imports que dependam de `node_modules` de dentro do core (pino, zod são deps diretas do core — ok, ficam no `node_modules` do runtime instalado via `package.json` do painel-admin se declarados, ou precisam ser copiados do builder). **Acao:** declarar `pino` e `zod` como deps de runtime em `painel-admin/package.json` se ainda não estiverem, para garantir que `npm ci --omit=dev` os instale no stage final.
- **Cache de layer do CI:** mudar `build.context` para raiz aumenta o contexto enviado ao Docker daemon. Pode aumentar tempo de build em CI. Mitigação: adicionar `.dockerignore` na raiz excluindo `node_modules`, `.git`, `painel-admin/public/node_modules` etc.

---

## Contexto

A fase L.3 do ADR 0006 foi implementada — `packages/integrations/src/google-calendar/client.ts` aceita Service Account JSON injetada, e o painel tem UI + endpoints `/api/clones/:id/gcal/*` em `painel-admin/server.js:2792-2939`. Migration 018_gcal_credentials.sql aplicada em prod.

Mas o teste de conexão falha pra qualquer SA, com o erro mascarado como "Credenciais inválidas". A causa raiz é deploy incompleto:

```
$ curl -u admin:*** -X POST https://gestao.startap.tech/api/clones/2/gcal/test
{"ok":false,"status":"invalid",
 "error":"Falha ao carregar cliente GCal: Cannot find module
  '/packages/integrations/dist/google-calendar/client.js'
  imported from /app/server.js"}
```

O `painel-admin/Dockerfile` só copia `package.json`, `server.js`, `public/` — o pacote `@startap/integrations` (que tem o cliente Google Calendar) não vai pro container. O import dinâmico em `server.js:2906` quebra em runtime.

Bonus bug menor (UX): o frontend em `painel-admin/public/index.html:5482+` mostra "Credenciais inválidas — verifique se a agenda foi compartilhada" para QUALQUER erro do backend. Mascara erro técnico real (módulo não encontrado, JSON malformado, network, etc).

## Solução proposta

Duas opções viáveis — **arquiteto decide antes de codar**:

### Opção A — Multi-stage Dockerfile no painel-admin (recomendada)

1. Mudar `painel-admin/Dockerfile` para multi-stage:
   - Stage 1 (build): `WORKDIR /monorepo`, copia raiz do monorepo, `npm ci` no workspace, `npm run build -w packages/integrations` (e core, que é dep).
   - Stage 2 (runtime): copia `painel-admin/` + `packages/integrations/dist/` + `packages/core/dist/` + `node_modules` filtrados (apenas runtime deps: pino, zod, openai etc).
2. Alterar `docker-compose.yml` (produção, fora deste repo) ou ajustar `build.context` do serviço painel-admin de `./painel-admin` para `.` (raiz do monorepo).
3. Garantir que o import dinâmico em `server.js:2906` continua resolvendo (`../packages/integrations/dist/google-calendar/client.js` relativo a `/app/server.js`).

### Opção D — Refatorar pra chamar apps/api (alternativa)

1. Criar `POST /internal/gcal/test` em `apps/api` que aceita `{ credentialsJson, calendarId }` e retorna `{ ok, error? }`.
2. Painel-admin chama esse endpoint via HTTP (mesma rede docker, `http://startap-api:3040`) em vez de import dinâmico.
3. Remove a dependência cruzada painel↔packages.
4. Requer ADR pequeno (mudança de fronteira de módulo).

**Por que A é a recomendação:** muda só infra/empacotamento, não código. Não cria endpoint novo, não move responsabilidade. Mais rápido pra desbloquear.

### Bonus (mesmo PR)

Em `painel-admin/public/index.html` na função `renderGcalContent`, exibir `data.error` (vem do `testResult.error`) quando `status` é `invalid`, em vez do texto fixo "Verifique se a agenda foi compartilhada".

## Definition of Done (DoD)

- [ ] `curl -u admin:*** -X POST https://gestao.startap.tech/api/clones/2/gcal/test` retorna `{"ok":true,"status":"active"}` com a SA `gcal-startap-barbershop` e agenda `startapsuporte@gmail.com`.
- [ ] `docker exec automacoes-painel-admin-1 ls /app/packages/integrations/dist/google-calendar/client.js` retorna o arquivo (em A) **ou** painel-admin chama apps/api com sucesso (em D).
- [ ] Bot do clone `bruno_barbershop` consegue criar evento de teste na agenda (smoke test: agendar evento via conversa de teste no WAHA, conferir que apareceu em `startapsuporte@gmail.com`).
- [ ] Frontend mostra mensagem de erro detalhada (não mais texto genérico) quando teste falha.
- [ ] Build local passa: `npm run build --workspaces` + `docker compose build painel-admin`.
- [ ] Tester rodou checklist completo (✅).
- [ ] PR mergeada pelo Bruno.
- [ ] Deploy validado em produção: clone `bruno_barbershop` com `gcal_status=active`.

## Fora de escopo

- Criptografar `gcal_credentials_json` no banco (débito técnico D1 do ADR 0006 — fica pra depois de 10 clientes pagantes ou auditoria LGPD).
- Retry automático quando SA dá `invalid` (futuro, baseado em `gcal_last_check_at`).
- UI de erro detalhado pra outros endpoints (só Calendar nesta missão).

## Dependências

- Nenhuma — migration 018 e código já estão em prod, só falta empacotar o cliente.

## Riscos

- **Mudar `build.context` do docker-compose pra raiz:** pode quebrar o cache de build do CI. **Mitigação:** infra valida em ambiente local + staging antes de mergear, e checa que o GitHub Actions ainda passa.
- **Bundle do painel ficar maior:** o `dist/` do packages/integrations é pequeno (só client.ts). **Mitigação:** garantir que `node_modules` de dev não vão pro stage final.
- **Regressão em outros endpoints do painel:** não há outro import cruzado, mas vale `grep -r "packages/" painel-admin/server.js` pra confirmar antes do PR.

## Evidências coletadas (2026-05-18)

- Erro reproduzido:
  ```
  curl -u admin:*** -X POST https://gestao.startap.tech/api/clones/2/gcal/test
  # {"ok":false,"status":"invalid","error":"Falha ao carregar cliente GCal: Cannot find module..."}
  ```
- Container sem o pacote:
  ```
  docker exec automacoes-painel-admin-1 ls /app/packages
  # ls: /app/packages: No such file or directory
  ```
- Clone afetado: `id=2`, `slot=clone_bruno_barbershop`, `matriz=teste_barbearia`.
- SA criada e agenda compartilhada corretamente (verificado por Bruno via Google Calendar UI antes do reporte) — descartado problema de configuração externa.

## Atualizações (log)

- **2026-05-18:** Aberta após reporte do Bruno durante teste de conexão Calendar no clone `bruno_barbershop`.
- **2026-05-18:** Arquiteto decidiu pela Opção A (multi-stage Dockerfile). Plano de implementação adicionado na seção "Decisão do arquiteto".
