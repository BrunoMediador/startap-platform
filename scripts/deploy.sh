#!/usr/bin/env bash
#
# Deploy script — roda no servidor após merge na main.
#
# Uso: ./scripts/deploy.sh
#
# O que faz:
#   1. git pull origin main (rebase para evitar merges acidentais)
#   2. docker compose build  (rebuild API/worker com novo código)
#   3. docker compose up -d  (substitui API/worker)
#   4. Rebuilda painel-admin na stack principal, quando ela existir
#   5. Verifica health
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

echo "==> docker compose up -d"
docker compose up -d

if [ -f ../docker-compose.yml ] && docker compose -f ../docker-compose.yml config --services | grep -qx 'painel-admin'; then
  echo "==> docker compose build painel-admin"
  docker compose -f ../docker-compose.yml build painel-admin

  echo "==> docker compose up -d painel-admin"
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
