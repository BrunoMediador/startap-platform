#!/usr/bin/env bash
# backup-postgres.sh — dump manual do Postgres de produção para startap-backups
#
# Uso:
#   bash scripts/backup-postgres.sh [--dry-run]
#
# Requerimentos locais:
#   - SSH key em ~/.ssh/hostinger_codex_ed25519 (ou SSH_KEY_PATH override)
#   - Repo startap-backups clonado em BACKUP_REPO_PATH (default: ../startap-backups)
#   - git configurado no clone de destino
#
# Variáveis de ambiente opcionais:
#   SSH_KEY_PATH        — caminho da chave SSH (default: ~/.ssh/hostinger_codex_ed25519)
#   VPS_HOST            — IP/host do servidor (default: 187.77.242.220)
#   VPS_USER            — usuário SSH (default: root)
#   VPS_PORT            — porta SSH (default: 22)
#   PG_CONTAINER        — nome do container Postgres (default: automacoes-postgres-1)
#   PG_USER             — usuário Postgres (default: startap_user)
#   PG_DB               — banco Postgres (default: startap_database)
#   BACKUP_REPO_PATH    — path local do clone de startap-backups (default: ../startap-backups)

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  [[ "$arg" == "--dry-run" ]] && DRY_RUN=true
done

SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/hostinger_codex_ed25519}"
VPS_HOST="${VPS_HOST:-187.77.242.220}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
PG_CONTAINER="${PG_CONTAINER:-automacoes-postgres-1}"
PG_USER="${PG_USER:-startap_user}"
PG_DB="${PG_DB:-startap_database}"
BACKUP_REPO_PATH="${BACKUP_REPO_PATH:-../startap-backups}"

TIMESTAMP=$(date -u '+%Y-%m-%d-%H%M%S')
YEAR=$(date -u '+%Y')
MONTH=$(date -u '+%m')
OUTDIR="${BACKUP_REPO_PATH}/dumps/${YEAR}/${MONTH}"
OUTFILE="${OUTDIR}/${TIMESTAMP}.sql.gz"

echo "[backup-postgres] timestamp: ${TIMESTAMP}"
echo "[backup-postgres] destino:   ${OUTFILE}"
echo "[backup-postgres] dry-run:   ${DRY_RUN}"

if [[ ! -f "${SSH_KEY_PATH}" ]]; then
  echo "ERRO: SSH key não encontrada em ${SSH_KEY_PATH}"
  exit 1
fi

if [[ ! -d "${BACKUP_REPO_PATH}/.git" ]]; then
  echo "ERRO: ${BACKUP_REPO_PATH} não é um repositório Git clonado"
  exit 1
fi

if $DRY_RUN; then
  echo "[backup-postgres] --dry-run: SSH e dump NÃO executados."
  exit 0
fi

mkdir -p "${OUTDIR}"

ssh -i "${SSH_KEY_PATH}" \
    -o StrictHostKeyChecking=yes \
    -p "${VPS_PORT}" \
    "${VPS_USER}@${VPS_HOST}" \
    "docker exec ${PG_CONTAINER} pg_dump \
      -U ${PG_USER} \
      -d ${PG_DB} \
      --no-owner --no-acl" \
  | gzip > "${OUTFILE}"

SIZE=$(stat -c%s "${OUTFILE}" 2>/dev/null || stat -f%z "${OUTFILE}")
if [[ "${SIZE}" -lt 1024 ]]; then
  echo "ERRO: dump gerado é menor que 1 KB (${SIZE} bytes) — suspeito de falha silenciosa"
  rm -f "${OUTFILE}"
  exit 1
fi

echo "[backup-postgres] dump OK — tamanho: ${SIZE} bytes"

cd "${BACKUP_REPO_PATH}"
git add "dumps/"
git commit -m "backup: ${TIMESTAMP} UTC (manual via script)"
git push

echo "[backup-postgres] commit e push concluídos."
