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

echo "==> docker compose up -d"
docker compose up -d

# Painel-admin vive na stack pai (/opt/automacoes/docker-compose.yml)
if [ -f ../docker-compose.yml ] && docker compose -f ../docker-compose.yml config --services | grep -qx 'painel-admin'; then
  echo "==> docker compose build painel-admin (stack pai)"
  docker compose -f ../docker-compose.yml build painel-admin

  echo "==> docker compose up -d painel-admin (stack pai)"
  docker compose -f ../docker-compose.yml up -d painel-admin
fi

echo "==> waiting 6s for startup"
sleep 6

echo "==> API health check"
if docker exec automacoes-waha-1 curl -fsS http://startap-api:3040/health > /dev/null; then
  echo "✅ API healthy"
else
  echo "❌ API health check failed — verifique 'docker logs startap-api'"
  exit 1
fi

if docker ps --format '{{.Names}}' | grep -qx 'automacoes-painel-admin-1'; then
  echo "==> painel-admin health check"
  PANEL_STATUS=$(docker exec automacoes-waha-1 curl -sS -o /dev/null -w '%{http_code}' http://automacoes-painel-admin-1:3030)
  if [ "$PANEL_STATUS" = "200" ] || [ "$PANEL_STATUS" = "401" ]; then
    echo "✅ painel-admin healthy"
  else
    echo "❌ painel-admin health check failed (HTTP $PANEL_STATUS) — verifique 'docker logs automacoes-painel-admin-1'"
    exit 1
  fi
fi

echo "==> bots registrados:"
docker logs --since 30s startap-api 2>&1 | grep 'Bot registrado' | wc -l | xargs -I{} echo "  {} bots"

echo ""
echo "Deploy completo. Logs: docker logs startap-api -f"
