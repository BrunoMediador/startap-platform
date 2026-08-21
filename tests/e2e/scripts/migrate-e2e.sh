#!/bin/sh
set -eu

PG_HOST="${E2E_PG_HOST:-postgres}"
PG_PORT="${E2E_PG_PORT:-5432}"
PG_USER="${E2E_PG_USER:-e2e_app}"
PG_DB="${E2E_PG_DB:-startap_e2e}"
MIGRATIONS_ROOT="${E2E_MIGRATIONS_ROOT:-/migrations}"
READY_MAX_ATTEMPTS="${E2E_PG_READY_MAX_ATTEMPTS:-30}"
READY_SLEEP_SECONDS="${E2E_PG_READY_SLEEP_SECONDS:-1}"

pg_ready_cmd="pg_isready -h $PG_HOST -p $PG_PORT -U $PG_USER -d $PG_DB"
psql_cmd="psql -h $PG_HOST -p $PG_PORT -U $PG_USER -d $PG_DB -v ON_ERROR_STOP=1"

attempt=1
until $pg_ready_cmd >/dev/null 2>&1; do
  if [ "$attempt" -ge "$READY_MAX_ATTEMPTS" ]; then
    echo "FATAL: postgres nao aceitou conexoes TCP em $PG_HOST:$PG_PORT apos $READY_MAX_ATTEMPTS tentativas" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep "$READY_SLEEP_SECONDS"
done

$psql_cmd --single-transaction -f "$MIGRATIONS_ROOT/001_legacy_schema.sql"
$psql_cmd -c "CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
$psql_cmd -c "INSERT INTO schema_migrations(filename) VALUES ('001_legacy_schema.sql')"

for migration in "$MIGRATIONS_ROOT"/versioned/*.sql; do
  filename="${migration##*/}"
  $psql_cmd --single-transaction -f "$migration"
  $psql_cmd -c "INSERT INTO schema_migrations(filename) VALUES ('$filename')"
done

$psql_cmd --single-transaction -f "$MIGRATIONS_ROOT/seed.sql"

# Guard DERIVADO, nao fixo (SCRUM-173/181): a propriedade que importa e "tudo que existe
# no repo foi aplicado", nao "existem exatamente N migrations". Um numero hardcoded aqui
# quebra o CI a cada migration nova, mesmo legitima (achado real: migration 081 do
# SCRUM-173 quebrou o "80" fixo). expected = 1 baseline + contagem REAL de .sql em
# $MIGRATIONS_ROOT/versioned/ (o mesmo diretorio packages/db/migrations montado pelo compose,
# ver tests/e2e/compose.yml) — sempre acompanha o repo, sem editar este script de novo.
expected="$(($(find "$MIGRATIONS_ROOT"/versioned -maxdepth 1 -name '*.sql' | wc -l) + 1))"
count="$($psql_cmd -Atc 'SELECT count(*) FROM schema_migrations')"
test "$count" = "$expected" || {
  echo "FATAL: esperado baseline 001 + $(($expected - 1)) migrations versionadas ($expected no total), encontrado $count aplicadas" >&2
  exit 1
}
