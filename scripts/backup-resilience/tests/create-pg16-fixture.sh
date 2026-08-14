#!/usr/bin/env bash
set -Eeuo pipefail
[ "$#" = "1" ] || exit 64
output="$1"
case "$output" in /tmp/*) ;; *) exit 66 ;; esac
{
  printf '%s\n' '-- PostgreSQL database dump'
  printf '%s\n' 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
  printf '%s\n' 'CREATE TABLE schema_migrations(filename text PRIMARY KEY, applied_at timestamptz);'
  printf '%s\n' 'CREATE TABLE flow_clones(slot text PRIMARY KEY, status text);'
  printf '%s\n' 'CREATE TABLE bot_config(slot text PRIMARY KEY);'
  printf '%s\n' 'CREATE TABLE client_billing(slot text PRIMARY KEY REFERENCES flow_clones(slot), next_due_date date);'
  printf '%s\n' 'CREATE TABLE atendimentos(id bigint PRIMARY KEY, slot text REFERENCES flow_clones(slot), tenant_id uuid, data date);'
  printf '%s\n' 'CREATE INDEX idx_flow_clones_status ON flow_clones(status);'
  printf '%s\n' 'CREATE INDEX idx_client_billing_next_due ON client_billing(next_due_date);'
  printf '%s\n' 'CREATE INDEX ix_atend_slot_tenant_data ON atendimentos(slot,tenant_id,data);'
  index=1
  while [ "$index" -le 46 ]; do
    printf 'CREATE TABLE fixture_%02d(id bigint PRIMARY KEY);\n' "$index"
    index=$((index + 1))
  done
  index=1
  while [ "$index" -le 79 ]; do
    printf "INSERT INTO schema_migrations(filename) VALUES ('%03d_fixture.sql');\n" "$index"
    index=$((index + 1))
  done
  printf '%s\n' '-- PostgreSQL database dump complete'
} | gzip -n -c >"$output"
