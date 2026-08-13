#!/bin/sh
set -eu

psql_cmd='psql -h postgres -U e2e_app -d startap_e2e -v ON_ERROR_STOP=1'

$psql_cmd --single-transaction -f /migrations/001_legacy_schema.sql
$psql_cmd -c "CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
$psql_cmd -c "INSERT INTO schema_migrations(filename) VALUES ('001_legacy_schema.sql')"

for migration in /migrations/versioned/*.sql; do
  filename="${migration##*/}"
  $psql_cmd --single-transaction -f "$migration"
  $psql_cmd -c "INSERT INTO schema_migrations(filename) VALUES ('$filename')"
done

$psql_cmd --single-transaction -f /migrations/seed.sql

count="$($psql_cmd -Atc 'SELECT count(*) FROM schema_migrations')"
test "$count" = "80" || {
  echo "FATAL: esperado baseline 001 + migrations 002-080 (80), encontrado $count" >&2
  exit 1
}
