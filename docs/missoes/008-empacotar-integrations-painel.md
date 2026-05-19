# Missão 008 — Empacotar @startap/integrations no painel-admin (fix gcal)

**DRI:** dev-back
**Agentes envolvidos:** arquiteto (decide A vs D), dev-back (implementa), infra (Dockerfile/CI), tester (valida)
**Apetite:** pequeno (≤ 1 dia)
**Status:** pendente
**Cliente (persona):** Bruno (Startap) e time de vendas — bloqueia conexão de Google Calendar em qualquer clone de barbearia
**Aberta em:** 2026-05-18
**PR-FAQ:** não precisa (é bugfix de empacotamento, escopo bem definido)

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
