#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SCRIPT_UNDER_TEST="$TEST_DIR/migrate-e2e.sh"

pass=0
fail=0
test_number=0
LOG_ROOT="$(mktemp -d /tmp/startap-e2e-migrator-test-logs.XXXXXX)"

cleanup_root() {
  case "$LOG_ROOT" in
    /tmp/startap-e2e-migrator-test-logs.*) find "$LOG_ROOT" -depth -delete 2>/dev/null || true ;;
  esac
}
trap cleanup_root EXIT INT TERM HUP

run_test() {
  local name="$1" function_name="$2" test_exit
  test_number=$((test_number + 1))
  set +e
  (set -Eeuo pipefail; "$function_name") >"$LOG_ROOT/$test_number.log" 2>&1
  test_exit=$?
  set -e
  if [ "$test_exit" = 0 ]; then
    printf 'ok %d - %s\n' "$test_number" "$name"
    pass=$((pass + 1))
  else
    printf 'not ok %d - %s\n' "$test_number" "$name"
    sed -n '1,120p' "$LOG_ROOT/$test_number.log" | sed 's/^/# /'
    fail=$((fail + 1))
  fi
}

setup_sandbox() {
  SANDBOX="$(mktemp -d /tmp/startap-e2e-migrator-test.XXXXXX)"
  trap teardown_sandbox EXIT INT TERM HUP
  mkdir -p "$SANDBOX/fakebin" "$SANDBOX/state" "$SANDBOX/migrations/versioned"
  : >"$SANDBOX/migrations/001_legacy_schema.sql"
  : >"$SANDBOX/migrations/versioned/002_example.sql"
  : >"$SANDBOX/migrations/seed.sql"
  : >"$SANDBOX/state/log"
  export FAKE_STATE_ROOT="$SANDBOX/state"
  export FAKE_LOG="$SANDBOX/state/log"
  export E2E_MIGRATIONS_ROOT="$SANDBOX/migrations"
  export E2E_PG_READY_MAX_ATTEMPTS=5
  export E2E_PG_READY_SLEEP_SECONDS=0
  export PATH="$SANDBOX/fakebin:$PATH"

  cat >"$SANDBOX/fakebin/pg_isready" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'pg_isready %s\n' "$*" >>"$FAKE_LOG"
count_file="$FAKE_STATE_ROOT/pg_isready.count"
count=0
if [ -f "$count_file" ]; then
  count="$(cat "$count_file")"
fi
count=$((count + 1))
printf '%s' "$count" >"$count_file"
if [ "$count" -lt 3 ]; then
  exit 1
fi
printf 'ready\n' >"$FAKE_STATE_ROOT/tcp-ready"
exit 0
EOF

  cat >"$SANDBOX/fakebin/psql" <<'EOF'
#!/usr/bin/env bash
set -eu
printf 'psql %s\n' "$*" >>"$FAKE_LOG"
if [ ! -f "$FAKE_STATE_ROOT/tcp-ready" ]; then
  printf 'psql: connection to server at "postgres" (172.20.0.2), port 5432 failed: Connection refused\n' >&2
  exit 2
fi
if printf '%s\n' "$*" | grep -Fq 'SELECT count(*) FROM schema_migrations'; then
  printf '2\n'
fi
EOF

  cat >"$SANDBOX/fakebin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  chmod +x "$SANDBOX/fakebin/pg_isready" "$SANDBOX/fakebin/psql" "$SANDBOX/fakebin/sleep"
}

teardown_sandbox() {
  case "${SANDBOX:-}" in
    /tmp/startap-e2e-migrator-test.*) find "$SANDBOX" -depth -delete 2>/dev/null || true ;;
  esac
}

test_waits_for_tcp_before_first_psql() {
  setup_sandbox
  sh "$SCRIPT_UNDER_TEST"
  log_lines=()
  while IFS= read -r line; do
    log_lines+=("$line")
  done <"$FAKE_LOG"
  [ "${#log_lines[@]}" -ge 5 ]
  [ "${log_lines[0]}" = 'pg_isready -h postgres -p 5432 -U e2e_app -d startap_e2e' ]
  [ "${log_lines[1]}" = 'pg_isready -h postgres -p 5432 -U e2e_app -d startap_e2e' ]
  [ "${log_lines[2]}" = 'pg_isready -h postgres -p 5432 -U e2e_app -d startap_e2e' ]
  case "${log_lines[3]}" in
    psql\ -h\ postgres\ -p\ 5432\ -U\ e2e_app\ -d\ startap_e2e\ -v\ ON_ERROR_STOP=1\ --single-transaction\ -f\ *) ;;
    *) return 1 ;;
  esac
}

run_test 'migrator espera readiness TCP antes do primeiro psql' test_waits_for_tcp_before_first_psql

printf '1..%d\n' "$test_number"
printf '# pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
