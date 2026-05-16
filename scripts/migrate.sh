#!/usr/bin/env bash
#
# Migration runner — roda no servidor antes do docker compose up.
#
# Uso: bash scripts/migrate.sh
#
# Requisitos:
#   - Container automacoes-postgres-1 rodando (stack pai em /opt/automacoes).
#   - Variáveis opcionais: PG_USER (default: startap_user), PG_DB (default: startap_database).
#
# Estratégia de atomicidade:
#   Cada migration é aplicada em uma única chamada psql que executa:
#     BEGIN;
#       <conteúdo do arquivo>
#       INSERT INTO schema_migrations (filename) VALUES (...) ON CONFLICT DO NOTHING;
#     COMMIT;
#   Migrations que já trazem BEGIN/COMMIT próprio resultam em aninhamento benigno:
#   o segundo BEGIN é no-op com warning no Postgres (não erro), e o COMMIT interno
#   confirma; o COMMIT externo confirma o INSERT. Isso é seguro para todos os arquivos
#   do repositório porque eles são idempotentes (IF NOT EXISTS / ON CONFLICT).
#
# Backfill de estado pré-runner:
#   Migrations 002-009 foram aplicadas manualmente antes deste runner existir.
#   Antes do primeiro deploy com este script, o devops deve rodar UMA VEZ:
#
#     docker exec -i automacoes-postgres-1 psql -U startap_user -d startap_database <<'SQL'
#     INSERT INTO schema_migrations (filename) VALUES
#       ('002_bot_config_and_usage.sql'),
#       ('003_rename_slots_prompts_media.sql'),
#       ('004_flow_execution_logs.sql'),
#       ('005_teste_vendas_barbearia.sql'),
#       ('006_project_databases_and_flow_controls.sql'),
#       ('007_bot_media_context.sql'),
#       ('008_flow_pauses.sql'),
#       ('009_flow_pause_keywords.sql')
#     ON CONFLICT DO NOTHING;
#     SQL
#
#   Depois disso, o runner aplica apenas migrations novas (010 em diante).
#   NÃO executar este backfill após o runner já estar rodando — seria redundante.

set -euo pipefail

CONTAINER="${PG_CONTAINER:-automacoes-postgres-1}"
PG_USER="${PG_USER:-startap_user}"
PG_DB="${PG_DB:-startap_database}"

MIGRATIONS_DIR="$(cd "$(dirname "$0")/.." && pwd)/packages/db/migrations"

# Verifica se o container está rodando antes de qualquer coisa.
if ! docker inspect --format '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q '^true$'; then
  echo "FATAL: container $CONTAINER nao esta rodando. Abortando." >&2
  exit 1
fi

psql_exec() {
  docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 "$@"
}

# Cria tabela de controle de migrations se nao existir.
psql_exec <<'SQL'
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   TEXT        PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);
SQL

echo "==> apply migrations"

applied=0
skipped=0
failed=0

# Ordena arquivos lexicograficamente (garante 002 < 003 < ... < 010).
while IFS= read -r -d '' filepath; do
  filename="$(basename "$filepath")"

  # Verifica se ja foi aplicada.
  already_applied="$(psql_exec -tAc "SELECT COUNT(*) FROM schema_migrations WHERE filename = '$filename';")"

  if [ "$already_applied" -gt 0 ]; then
    echo "  SKIP    $filename"
    skipped=$((skipped + 1))
    continue
  fi

  # Aplica o arquivo + registra na schema_migrations em uma unica transacao.
  # A concatenacao aqui nao envolve input do usuario — filename vem do filesystem local.
  if psql_exec <<SQL
BEGIN;
$(cat "$filepath")
INSERT INTO schema_migrations (filename) VALUES ('$filename') ON CONFLICT DO NOTHING;
COMMIT;
SQL
  then
    echo "  APPLY OK  $filename"
    applied=$((applied + 1))
  else
    echo "  APPLY FAILED  $filename" >&2
    failed=$((failed + 1))
    exit 1
  fi

done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '*.sql' -print0 | sort -z)

echo ""
echo "Migrations: $applied aplicadas, $skipped puladas."

if [ "$failed" -gt 0 ]; then
  exit 1
fi
