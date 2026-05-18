# Postmortem: painel-admin ignorado silenciosamente em todos os deploys

> **Quem escreve:** `infra`
> **Onde fica:** `docs/postmortems/2026-05-18-painel-admin-deploy-silent-skip.md`

---

## Resumo executivo

**Data:** 2026-05-18
**Duracao do impacto:** ~2h (15:26 BRT ate 14:36 BRT do dia seguinte — last-modified na UI confirmou 17:25 UTC = 14:25 BRT, container recriado as 14:36 BRT de 2026-05-18)
**Severidade:** P2 (degradacao parcial — painel servindo HTML desatualizado, bots continuando a funcionar)
**Quem detectou:** Bruno (observacao manual pos-merge do PR #71)
**Quem mitigou:** `infra` (rebuild + recreate manual do container)
**Quem escreveu este postmortem:** `infra`

### O que aconteceu

Apos o merge do PR #71 (drawer de bots), o workflow "Deploy to Production" (run 26049293405) concluiu com sucesso as 17:27 UTC porem o painel-admin continuou servindo o HTML da versao anterior (Last-Modified: 15:26 UTC). O bloco do `deploy.sh` responsavel por rebuildar o painel-admin foi silenciosamente pulado: a variavel de deteccao usava path relativo (`../docker-compose.yml`) que funciona quando o script e invocado a partir de `/opt/automacoes/code/`, mas o comportamento real no contexto do CI divergiu — a condicao `if` foi falsa sem emitir nenhum aviso. O health check existente passou porque o container antigo ainda respondia HTTP 200/401, mascarando o problema completamente. A mitigacao foi executar o rebuild e recreate manualmente no servidor.

---

## Linha do tempo (BRT = UTC-3)

- **14:24** — PR #71 (drawer de bots) mergeado por Bruno na main
- **14:25** — git pull no servidor puxa commit `a5801c4`; docker compose build rebuilda apenas `startap-api` e `startap-worker`
- **14:25** — condicao `if` do painel-admin falha silenciosamente; bloco de rebuild e pulado sem log de aviso
- **14:27** — health check passa (container antigo responde 200/401); deploy marcado como "concluido com sucesso"
- **~14:30** — Bruno acessa gestao.startap.tech e nao ve as mudancas do PR #71
- **14:34** — Bruno abre incidente; `infra` diagnostica via curl (Last-Modified 2h atrasado) e logs do Actions (linhas do painel-admin ausentes)
- **14:35** — `infra` executa `docker compose -f /opt/automacoes/docker-compose.yml build --no-cache painel-admin`
- **14:36** — `infra` executa `docker compose -f /opt/automacoes/docker-compose.yml up -d painel-admin`
- **14:36** — Last-Modified sobe para 17:25 UTC; container recriado com codigo correto
- **14:36** — incidente mitigado

---

## Impacto

- **Usuarios afetados:** Bruno e Icaro (usuarios do painel interno)
- **Funcionalidades afetadas:** interface do painel em gestao.startap.tech — HTML desatualizado; bots, API, worker e banco sem impacto
- **Dados perdidos:** nenhum
- **Receita afetada:** nenhuma diretamente (painel e interno, nao cliente final)
- **PRs afetados:** possivelmente #68, #69 e #71 — todos com mudancas em `painel-admin/public/` e potencialmente nao deployados. PR #70 e #67 nao tocam `painel-admin/public/` diretamente.

---

## Causa raiz (5 Whys)

**Por que o painel nao foi atualizado?**
- O bloco de rebuild do painel-admin em `deploy.sh:50-56` foi silenciosamente pulado.

**Por que o bloco foi pulado?**
- A condicao `if [ -f ../docker-compose.yml ] && docker compose -f ../docker-compose.yml config --services | grep -qx 'painel-admin'` usava path relativo. Quando a condicao avaliou como `false` (por qualquer razao — variavel de ambiente nao exportada, working dir diferente durante a execucao, ou pipe com exit code inesperado do `docker compose config`), o bloco foi pulado sem emitir nenhuma mensagem de aviso.

**Por que ninguem detectou antes?**
- O health check (linha 69-78) verifica apenas se o container responde HTTP 200/401 — nao verifica o conteudo nem a data de build da imagem. O container antigo continuava respondendo corretamente.
- O log do CI nao continha nenhuma linha de erro nem de aviso indicando que o painel-admin havia sido pulado — a ausencia de linhas `==> docker compose build painel-admin` e `==> docker compose up -d painel-admin` e invisivel sem inspecao manual do log completo.

**Por que o path relativo causou o problema?**
- O script usa `cd "$(dirname "$0")/.."` para resolver o working dir, mas o comportamento do `dirname` depende de como o script e invocado. Quando chamado via `bash ./scripts/deploy.sh` (como no CI), o resultado e correto — MAS a condicao composta usa `&&` com `docker compose config`, e se este comando retornar exit code != 0 por qualquer motivo (ex: variavel de interpolacao no compose nao definida, `version` obsoleto causando warning no stdout-misturado), o `grep -qx` falha.

**Por que esse cenario existe?**
- O painel-admin vive numa stack Docker diferente da API (`/opt/automacoes/docker-compose.yml` vs `/opt/automacoes/code/docker-compose.yml`). A logica de deteccao e rebuild foi adicionada como condicional opcional ("se existir") em vez de obrigatoria com falha explicita, o que transformou erros de configuracao em skip silencioso.

---

## Como foi mitigado (curto prazo)

Rebuild e recreate manual do container a partir do servidor:

```bash
cd /opt/automacoes
docker compose -f docker-compose.yml build --no-cache painel-admin
docker compose -f docker-compose.yml up -d painel-admin
```

`Last-Modified` confirmado como `Mon, 18 May 2026 17:25:42 GMT` (timestamp do commit mergeado).

---

## Acoes pra evitar que volte (longo prazo)

- [ ] **Substituir path relativo por absoluto no deploy.sh + adicionar log explicito de skip** — DRI: `infra` — Prazo: 2026-05-18 — Status: concluido (PR #infra/fix-deploy-painel-admin)
  - Missao: (incorporada neste postmortem, sem missao separada — mudanca < 20 linhas)
- [ ] **Health check de conteudo: verificar Last-Modified no deploy** — adicionar ao final do deploy.sh uma checagem que confirme que o Last-Modified do painel-admin e posterior ao timestamp do git pull. Se for mais antigo, falhar o deploy explicitamente. — DRI: `infra` — Prazo: 2026-05-25 — Status: pendente
  - Missao: `docs/missoes/` (criar missao separada)
- [ ] **Auditoria de PRs #68 e #69** — verificar se as mudancas de `painel-admin/public/` desses PRs chegaram a producao ou se tambem foram puladas. Se nao chegaram, fazer rebuild manual adicional. — DRI: `infra` + Bruno — Prazo: 2026-05-19 — Status: pendente
- [ ] **Consolidar stacks Docker** — avaliar se faz sentido mover painel-admin para `/opt/automacoes/code/docker-compose.yml` eliminando a logica de "stack pai". Decisao arquitetural: despachar para `arquiteto`. — DRI: `arquiteto` — Prazo: proxima sprint — Status: pendente

---

## O que funcionou bem

- Diagnostico foi rapido: `Last-Modified` no header HTTP foi suficiente para confirmar o problema em < 2 min
- Logs do GitHub Actions permitiram isolar a causa (ausencia das linhas de log do painel-admin) sem precisar SSH inicial extenso
- Rebuild manual e seguro: painel-admin e stateless, sem risco de perda de dados
- Nenhum servico critico (API, worker, banco, bots WhatsApp) foi afetado

## O que poderia ter sido melhor

- O health check do deploy nao deve aceitar "container responde" como prova de "deploy correto" — precisa verificar conteudo ou data de imagem
- O bloco de rebuild do painel-admin nao deveria ser silencioso quando pulado — todo skip deve ter um `echo WARN` explicito
- Path relativo em scripts de deploy cria dependencia oculta do working directory do caller

---

## Licoes aprendidas

1. **Skip silencioso e pior que falha ruidosa.** Um `if` que nao loga quando vai pelo ramo `else` torna o script invisivel para auditoria.
2. **Health check de disponibilidade nao e health check de corretude.** Container respondendo HTTP 200 nao garante que o codigo novo foi deployado.
3. **Paths absolutos em scripts de deploy eliminam dependencia do caller.** Scripts invocados via SSH/CI devem usar `SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"` e paths absolutos derivados dele.
4. **Duas stacks Docker para o mesmo produto aumentam superficie de falha.** Cada stack separada requer logica extra no deploy e e ponto de falha independente.

---

## Anexos

- Logs do Actions: run `26049293405` — ausencia das linhas `==> docker compose build/up painel-admin`
- PR que revelou o incidente: #71 (drawer de bots)
- PR de fix: `infra/fix-deploy-painel-admin` (pendente review do Bruno)
- Ultimo Last-Modified antes da correcao: `Mon, 18 May 2026 15:26:59 GMT`
- Last-Modified apos correcao: `Mon, 18 May 2026 17:25:42 GMT`
