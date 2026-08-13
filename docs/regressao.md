# Checklist de Regressao — Smoke Test Pre-PR

Executar antes de todo merge. Cada item precisa de resultado real (sem "parece OK").

## Gates automatizados do CI

Na raiz do repositório, a ordem relevante é:

```bash
npm run build --workspaces --if-present
PG_TEST_URL=postgres://... npm run test:migrations
npm run test:panel
PG_TEST_URL=postgres://... npm test
```

- `test:migrations`: manifest SHA-256 do baseline 001 + migrations 002→080 num Postgres 16 local;
  exige catálogos de usuário vazios, ordem efetiva `pg_catalog,public` e URL sem query string.
- `test:panel`: 28 arquivos do painel legado via `node:test`; eles não pertencem ao Vitest.
- `npm test`: suíte Vitest da raiz uma única vez, com integrações SQL habilitadas por `PG_TEST_URL`.

Detalhe e rollback: [Missão 029](missoes/029-ci-regressao-integral.md).

## 1. Health da API

```bash
curl -u admin:startap2026 -o /dev/null -w '%{http_code}\n' https://gestao.startap.tech/health
# Esperado: 200
```

## 2. Painel /api/status

```bash
curl -u admin:startap2026 -o /dev/null -w '%{http_code}\n' https://gestao.startap.tech/api/status
# Esperado: 200
```

## 3. /api/leads retorna 200

```bash
curl -u admin:startap2026 -o /dev/null -w '%{http_code}\n' https://gestao.startap.tech/api/leads
# Esperado: 200 (body pode ser [] mas HTTP deve ser 200 — regressao #96 schema divergente)
# Ref: feedback_tester_sem_build_real, fix #125 UNION com schemas divergentes
```

## 4. /api/bots retorna 4 bots

```bash
curl -s -u admin:startap2026 https://gestao.startap.tech/api/bots | python3 -c "import sys,json; b=json.load(sys.stdin); print(len(b)); assert len(b)==4"
# Esperado: 4 (startap, teste_barbearia, teste_vendas, teste_vendas_barbearia)
```

## 5. WAHA sessions contem STARTAP_AI_PROD

> Nota (Missão 023 W2): o **roteamento de TESTE foi descontinuado pelo Bruno** —
> as entradas de `routing_clientes` foram apagadas e a sessao `WHATSAPP_ROUTER_TESTE`
> foi removida do WAHA. A aba "Roteamento" do painel e o endpoint `/api/routing`
> tambem foram removidos. Por isso este item **nao** verifica mais
> `WHATSAPP_ROUTER_TESTE` (verificar sua presenca falharia de proposito agora).
> O roteamento CORE (`apps/api/src/router.ts`) segue intacto.

```bash
curl -s -u admin:startap2026 https://gestao.startap.tech/api/sessions | python3 -c "
import sys, json
data = json.load(sys.stdin)
names = [s.get('name') or s.get('session') for s in data]
print(names)
assert 'STARTAP_AI_PROD' in names, 'STARTAP_AI_PROD ausente'
"
```

## 6. Bot Lola responde em menos de 10s

Enviar "ping" para o WhatsApp do numero registrado em STARTAP_AI_PROD e confirmar resposta em < 10s. Validacao manual — sem automacao por ora.

## 7. Logs sem erro nos ultimos 5 min apos deploy

```bash
ssh -i ~/.ssh/hostinger_codex_ed25519 root@187.77.242.220 \
  "docker logs startap-api --since 5m 2>&1 | grep -iE 'error|exception|fatal' | tail -10"
# Esperado: nenhuma linha (ou so logs esperados conhecidos)
```

## 8. Disco do VPS abaixo de 80%

```bash
ssh -i ~/.ssh/hostinger_codex_ed25519 root@187.77.242.220 "df -h / | awk 'NR==2{print \$5}'"
# Esperado: <80%
# Ref: project_vps_disco_apertado — 72/100GB usado em 2026-05-19
```

## 9. Worker rodando

```bash
ssh -i ~/.ssh/hostinger_codex_ed25519 root@187.77.242.220 \
  "docker ps --format '{{.Names}}\t{{.Status}}' | grep startap-worker"
# Esperado: startap-worker ... Up ...
```

---

## Regressoes historicas fixadas (nunca deixar voltar)

| # | Bug | PR fix | Sinal de regressao |
|---|-----|--------|--------------------|
| PR#44 | `docker exec -i` drenava stdin do loop de migrations — migracoes 003-014 nunca aplicadas | #44 | `/api/clones` retorna 500 ou `leads[0].slot` nulo |
| PR#45 | Gate de migrations ausente — deploy com banco desatualizado passava como sucesso | #45 | GitHub Actions run sem linha "migrations OK" |
| PR#67 | `deploy.sh` sem bit +x — CI falha na primeira linha | #8 | CI falha com "Permission denied" ao invocar deploy.sh |
| PR#72 | Skip silencioso do painel-admin — container antigo permanecia apos deploy | #72 | `Last-Modified` do painel mais velho que o ultimo commit |
| PR#96/#100 | Endpoint removido sem grep no frontend — `/api/sessions` retornava 404 silencioso | #100 | Tela de sessoes no painel em branco sem erro visivel |
| PR#121 | `safeTableName` ausente no cleanup run-now — SQL injection via nome de tabela | #121 | Requisicao com `tableName=x; DROP TABLE` passa sem erro |
| PR#123 | Paginacao de leads errada — pagina 2 retornava itens da 1 | #123 | `GET /api/leads?page=2` retorna os mesmos itens da page=1 |
| PR#125 | UNION de leads com schemas divergentes — 500 se coluna ausente em qualquer tabela | #125 | `GET /api/leads` retorna 500 quando algum clone tem schema diferente |
| Missão 029 | Testes do painel e migrations ausentes do CI | PR pendente | Run sem `test:panel` ou `test:migrations` |
