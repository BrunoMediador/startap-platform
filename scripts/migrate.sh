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
#   Aplicar a migration e registrá-la em schema_migrations são duas chamadas psql
#   separadas. Se a segunda falhar (extremamente raro), a migration fica aplicada mas
#   não registrada — a próxima execução a re-aplica como no-op. A segurança vem da
#   idempotência das migrations, não de atomicidade entre statements.
#
# Primeira execução em banco com migrations já aplicadas manualmente:
#   O runner re-executa todas as migrations não registradas. Isso é seguro porque
#   todas as migrations neste repositório são idempotentes (IF NOT EXISTS, ON CONFLICT,
#   UPDATE ... WHERE). As operações viram no-ops e a transação completa normalmente.
#   Nenhuma intervenção manual (SSH, backfill) é necessária.

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

# psql_exec_in: usa -i pra repassar stdin (necessario quando passamos arquivo SQL via "< arquivo").
# psql_exec:    NAO usa -i. Critico — usar -i em chamadas sem stdin proprio fazia o `docker exec`
#               consumir a stdin do loop while (que vem do `< <(find ...)`), abortando o loop
#               apos a primeira iteracao. Sintoma classico: "Migrations: 0 aplicadas, 1 puladas"
#               mesmo com 13 arquivos no diretorio.
psql_exec_in() {
  docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 "$@"
}
psql_exec() {
  docker exec "$CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 "$@"
}

# Cria tabela de controle de migrations se nao existir.
psql_exec_in <<'SQL'
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

  # Verifica se ja foi aplicada. Sem stdin — usa psql_exec (sem -i).
  already_applied="$(psql_exec -tAc "SELECT COUNT(*) FROM schema_migrations WHERE filename = '$filename';")"

  if [ "$already_applied" -gt 0 ]; then
    echo "  SKIP    $filename"
    skipped=$((skipped + 1))
    continue
  fi

  # Aplica a migration; se bem-sucedida, registra em schema_migrations.
  # Duas chamadas psql separadas — ver nota de atomicidade no cabeçalho.
  # filename vem do filesystem local, nao de input do usuario.
  # psql_exec_in (com -i) porque passamos arquivo via stdin redirect.
  if psql_exec_in --single-transaction < "$filepath"; then
    # psql_exec (sem -i) porque nao temos stdin aqui — evita o bug.
    psql_exec -c "INSERT INTO schema_migrations (filename) VALUES ('$filename') ON CONFLICT DO NOTHING;"
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
