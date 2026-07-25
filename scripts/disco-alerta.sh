#!/bin/bash
# ============================================================================
# disco-alerta.sh — mede o disco do HOST e alimenta o Sistema de Alertas
# Interno (Missão 021 / SCRUM-134). Owner: 06-devops-sre.
#
# Roda no HOST (cron 6/6h), NÃO em container — deliberado: o worker
# (apps/worker) é containerizado e enxergaria cgroup/overlay, não o disco
# físico real (spec docs/missoes/021-sistema-alertas-interno.md §1). Este
# script é o ÚNICO produtor confiável da métrica; ele SÓ mede e grava o fato
# bruto — quem decide alertar/enviar é o worker (observeHostDisk() em
# apps/worker/src/jobs/monitor.ts), atrás do gate alert_config.check_host
# (default FALSE — ligar é decisão do Bruno, ver docs/playbooks).
#
# Canal de escrita: `docker exec` no container Postgres (automacoes-postgres-1),
# psql como `startap_app` (role de aplicação, JÁ tem INSERT/UPDATE/SELECT em
# alert_states — sem escalar privilégio) via SOCKET LOCAL (trust, mesmo padrão
# de scripts/migrate.sh) — zero porta nova exposta, zero segredo novo no host.
#
# SEGURANÇA: read-only quanto ao disco (só `df`). Escreve em 1 tabela/1 linha
# sintética ('host:disk'), nunca em state/alert_count (domínio exclusivo do
# job monitor — CAS otimista entre ciclos concorrentes; este script NUNCA
# toca essas colunas). Log local mantido como 2º canal (histórico legível sem
# precisar consultar o Postgres).
#
# NÃO GRAVAR NADA fora deste comportamento sem revisão: nenhum DROP/DELETE/
# TRUNCATE aqui, nenhuma mudança de estado além do UPSERT idempotente abaixo.
# ============================================================================
set -uo pipefail

LOG=/var/log/disco-alerta.log
THRESHOLD=80                  # limiar do WARN local no log (mantém o de sempre — cosmético).
MAXBYTES=$((5*1024*1024))     # trunca log se passar de 5MB
PG_CONTAINER="${PG_CONTAINER:-automacoes-postgres-1}"
PG_USER="${PG_USER:-startap_app}"   # role de app, não superuser (menor privilégio pra 1 UPSERT).
PG_DB="${PG_DB:-startap_database}"
CHECK_KEY="host:disk"

TS() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

# Rotacao simples
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt "$MAXBYTES" ]; then
  tail -n 500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

USE=$(df --output=pcent / | tail -1 | tr -dc '0-9')
AVAIL=$(df -h --output=avail / | tail -1 | tr -d ' ')

if [ -z "$USE" ]; then
  echo "[$(TS)] ERRO: nao foi possivel ler uso de disco via df." >> "$LOG"
  exit 1
fi

if [ "$USE" -ge "$THRESHOLD" ]; then
  echo "[$(TS)] ALERTA: disco / em ${USE}% (>= ${THRESHOLD}%). Livre: ${AVAIL}." >> "$LOG"
else
  echo "[$(TS)] ok: disco / em ${USE}% (< ${THRESHOLD}%). Livre: ${AVAIL}." >> "$LOG"
fi

# ── Grava o fato bruto em alert_states (migration 078) ──────────────────────
# UPSERT idempotente na linha sintética 'host:disk'; NUNCA toca state/down_since/
# alert_count/pending_down_count (domínio exclusivo do job monitor). Best-effort:
# se o Postgres estiver inacessível, loga e segue — não trava o cron nem escala
# pra um "disco cheio" que na verdade é "banco fora do ar" (causas diferentes).
if ! docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q \
  -c "INSERT INTO alert_states (check_key, state, host_reported_pct, host_reported_at, updated_at)
      VALUES ('${CHECK_KEY}', 'up', ${USE}, NOW(), NOW())
      ON CONFLICT (check_key) DO UPDATE SET
        host_reported_pct = EXCLUDED.host_reported_pct,
        host_reported_at  = EXCLUDED.host_reported_at,
        updated_at        = NOW();" >> "$LOG" 2>&1; then
  echo "[$(TS)] ERRO: falha ao gravar host_reported_pct em alert_states (Postgres inacessivel?)." >> "$LOG"
  exit 1
fi

exit 0
