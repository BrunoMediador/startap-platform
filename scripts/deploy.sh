#!/usr/bin/env bash
#
# Deploy script — roda no servidor após merge na main.
#
# Uso: ./scripts/deploy.sh
#
# O que faz:
#   1. git pull origin main (rebase para evitar merges acidentais)
#   2. docker compose build  (rebuild images com novo código)
#   3. apply migrations (migrate.sh)
#   4. docker compose up -d  (substitui containers api/worker)
#   5. Rebuilda painel-admin na stack pai (/opt/automacoes/docker-compose.yml), quando ela existir
#   6. Verifica health da API e do painel-admin
#
# Pré-requisito: rodar em /opt/automacoes/code com .env configurado.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> git pull"
git fetch origin main
git checkout main
git pull --rebase origin main

echo "==> docker compose build (sem cache pra evitar staleness)"
docker compose build --no-cache

echo "==> apply migrations"
bash "$(dirname "$0")/migrate.sh"

# Gate defensivo: garante que TODAS as migrations do repo estao registradas em
# schema_migrations. Protege contra bugs silenciosos no runner (ja aconteceu
# uma vez — psql_exec consumia stdin do loop e abortava apos 1 iteracao,
# deixando flow_clones/leads.slot fora de prod). Se este gate falhar, NAO
# subir nova versao da aplicacao com banco fora-de-sync.
expected_migrations=$(find packages/db/migrations -maxdepth 1 -name '*.sql' -type f | wc -l)
applied_migrations=$(docker exec automacoes-postgres-1 psql -U "${PG_USER:-startap_user}" -d "${PG_DB:-startap_database}" -tAc "SELECT COUNT(*) FROM schema_migrations;" </dev/null | tr -d ' ')
if [ "$applied_migrations" -lt "$expected_migrations" ]; then
  echo "❌ schema_migrations tem $applied_migrations entradas, esperado $expected_migrations. Abortando deploy pra evitar app rodar com banco fora-de-sync." >&2
  echo "   Investigue rodando: bash scripts/migrate.sh manualmente e leia o output completo." >&2
  exit 1
fi
echo "✅ schema_migrations sincronizado ($applied_migrations/$expected_migrations)"

# --- Rollback: salva imagens atuais antes de subir nova versao ---
# Se o health check falhar apos o up, restaura as imagens anteriores.
ROLLBACK_API=""
ROLLBACK_WORKER=""
if docker image inspect startap-api:latest &>/dev/null; then
  docker tag startap-api:latest startap-api:pre-deploy
  ROLLBACK_API="startap-api:pre-deploy"
fi
if docker image inspect startap-worker:latest &>/dev/null; then
  docker tag startap-worker:latest startap-worker:pre-deploy
  ROLLBACK_WORKER="startap-worker:pre-deploy"
fi

_rollback() {
  echo "==> ROLLBACK: restaurando imagens anteriores" >&2
  if [ -n "$ROLLBACK_API" ]; then
    docker tag "$ROLLBACK_API" startap-api:latest
  fi
  if [ -n "$ROLLBACK_WORKER" ]; then
    docker tag "$ROLLBACK_WORKER" startap-worker:latest
  fi
  docker compose up -d
  echo "==> ROLLBACK concluido. Verifique: docker logs startap-api --tail 30" >&2
}

echo "==> docker compose up -d"
docker compose up -d

# Painel-admin vive na stack pai (/opt/automacoes/docker-compose.yml).
# Usamos path absoluto para evitar falha silenciosa quando o working dir
# do caller (ex: GitHub Actions) difere do esperado pelo script.
STACK_PAI_COMPOSE="/opt/automacoes/docker-compose.yml"
if [ -f "$STACK_PAI_COMPOSE" ]; then
  PAINEL_IN_STACK=$(docker compose -f "$STACK_PAI_COMPOSE" config --services 2>/dev/null | grep -cx 'painel-admin' || true)
  echo "==> painel-admin na stack pai: ${PAINEL_IN_STACK} ocorrencia(s)"
  if [ "$PAINEL_IN_STACK" -gt 0 ]; then
    echo "==> docker compose build painel-admin (stack pai)"
    docker compose -f "$STACK_PAI_COMPOSE" build --no-cache painel-admin

    echo "==> docker compose up -d painel-admin (stack pai)"
    docker compose -f "$STACK_PAI_COMPOSE" up -d painel-admin
  else
    echo "WARN: painel-admin nao encontrado em $STACK_PAI_COMPOSE — pulando rebuild"
  fi
else
  echo "WARN: $STACK_PAI_COMPOSE nao existe — pulando rebuild do painel-admin"
fi

echo "==> waiting 6s for startup"
sleep 6

echo "==> API health check"
if docker exec automacoes-waha-1 curl -fsS http://startap-api:3040/health > /dev/null; then
  echo "✅ API healthy"
else
  echo "❌ API health check failed — iniciando rollback" >&2
  _rollback
  exit 1
fi

if docker ps --format '{{.Names}}' | grep -qx 'automacoes-painel-admin-1'; then
  echo "==> painel-admin health check"
  PANEL_STATUS=$(docker exec automacoes-waha-1 curl -sS -o /dev/null -w '%{http_code}' http://automacoes-painel-admin-1:3030)
  if [ "$PANEL_STATUS" = "200" ] || [ "$PANEL_STATUS" = "401" ]; then
    echo "✅ painel-admin healthy"
  else
    echo "❌ painel-admin health check failed (HTTP $PANEL_STATUS) — verifique 'docker logs automacoes-painel-admin-1'" >&2
    exit 1
  fi
fi

# --- Limpeza de cache de build (so apos deploy OK) ---
# O build acima roda com --no-cache, entao o cache de build NUNCA e reusado —
# ele so acumula a cada deploy (chegou a ~44GB e encheu o disco). Como os
# health checks acima ja passaram, e seguro limpar TUDO aqui.
#
# ⚠️ JAMAIS trocar por `docker system prune -a` ou `docker image prune -a`:
# isso removeria imagens paradas porem taggeadas, incluindo a
# devlikeapro/waha-plus (imagem doada/congelada, NAO re-baixavel via pull)
# e derrubaria os bots.
#   - `builder prune -af` → so cache de build (nao toca em imagem nenhuma)
#   - `image prune -f`    → so imagens dangling (<none>) de rebuilds; imagens
#                           taggeadas (waha-plus, startap-*:pre-deploy) intactas
# Best-effort: falha na limpeza nao pode falhar o deploy (|| true).
echo "==> prune de build cache + imagens dangling (best-effort)"
docker builder prune -af || true
docker image prune -f || true

echo "==> bots registrados:"
# awk em vez de `grep | wc -l` porque grep retorna exit 1 quando ha 0 matches —
# combinado com `set -euo pipefail` no topo, isso aborta o deploy mesmo quando
# o painel subiu limpo. Em prod com banco vazio (sem clones), 0 matches e estado
# valido. awk imprime 0 nesses casos e sempre retorna exit 0.
N=$(docker logs --since 30s startap-api 2>&1 | awk '/Bot registrado/ {n++} END {print n+0}')
echo "  $N bots"

echo ""
echo "Deploy completo. Logs: docker logs startap-api -f"
