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

# Guard DERIVADO, nao fixo (SCRUM-173/181): a propriedade que importa e "tudo que existe
# no repo foi aplicado", nao "existem exatamente N migrations". Um numero hardcoded aqui
# quebra o CI a cada migration nova, mesmo legitima (achado real: migration 081 do
# SCRUM-173 quebrou o "80" fixo). expected = 1 baseline + contagem REAL de .sql em
# /migrations/versioned/ (o mesmo diretorio packages/db/migrations montado pelo compose,
# ver tests/e2e/compose.yml) — sempre acompanha o repo, sem editar este script de novo.
expected="$(($(find /migrations/versioned -maxdepth 1 -name '*.sql' | wc -l) + 1))"
count="$($psql_cmd -Atc 'SELECT count(*) FROM schema_migrations')"
test "$count" = "$expected" || {
  echo "FATAL: esperado baseline 001 + $(($expected - 1)) migrations versionadas ($expected no total), encontrado $count aplicadas" >&2
  exit 1
}
