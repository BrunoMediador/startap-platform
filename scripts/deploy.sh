#!/usr/bin/env bash
#
# Deploy script — roda no servidor após merge na main.
#
# Uso: ./scripts/deploy.sh
#
# O que faz:
#   1. git pull origin main (rebase para evitar merges acidentais)
#   2. docker compose build  (rebuild images com novo código)
#   3. docker compose up -d  (substitui containers)
#   4. Verifica health
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

echo "==> waiting 6s for startup"
sleep 6

echo "==> health check"
if docker exec automacoes-waha-1 curl -fsS http://startap-api:3040/health > /dev/null; then
  echo "✅ API healthy"
else
  echo "❌ API health check failed — verifique 'docker logs startap-api'"
  exit 1
fi

echo "==> bots registrados:"
docker logs --since 30s startap-api 2>&1 | grep 'Bot registrado' | wc -l | xargs -I{} echo "  {} bots"

echo ""
echo "Deploy completo. Logs: docker logs startap-api -f"
