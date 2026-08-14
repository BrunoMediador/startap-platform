#!/usr/bin/env bash
set -Eeuo pipefail
# Executed only in a disposable Docker-capable CI runner. All resources retain
# the startap-backup-drill label and are checked absent after every case.
TEST_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SCRIPT_DIR="$(CDPATH='' cd -- "$TEST_DIR/.." && pwd)"
ROOT="$(mktemp -d /tmp/startap-pg16-integration.XXXXXX)"
trap 'find "$ROOT" -depth -delete 2>/dev/null || true' EXIT INT TERM HUP
mkdir -p "$ROOT/config" "$ROOT/drill" "$ROOT/drill-journal" "$ROOT/docker-query" "$ROOT/reports" "$ROOT/status"
run_id=20260814T130000Z-d00df00d
mkdir "$ROOT/drill/$run_id"
"$TEST_DIR/create-pg16-fixture.sh" "$ROOT/drill/$run_id/dump.sql.gz"
printf '%s\n' "$run_id" >"$ROOT/drill/pending-run"
printf '%s\n' \
  'EXPECTED_HOSTNAME=fixture' \
  'PG_IMAGE=postgres:16@sha256:ce5c12ac6952df86affd04ade354cfcb9a0aa1171cd7912e6dbd81578a989a63' \
  >"$ROOT/config/policy.conf"
export STARTAP_BACKUP_TEST_MODE=1
export STARTAP_BACKUP_CONFIG_DIR="$ROOT/config"
export STARTAP_BACKUP_DRILL_ROOT="$ROOT/drill"
export STARTAP_BACKUP_DRILL_JOURNAL_ROOT="$ROOT/drill-journal"
export STARTAP_BACKUP_DOCKER_QUERY_ROOT="$ROOT/docker-query"
export STARTAP_BACKUP_REPORT_ROOT="$ROOT/reports"
export STARTAP_BACKUP_STATUS_ROOT="$ROOT/status"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
write_input() {
  jq -n --arg run_id "$run_id" --argjson started "$(date -u +%s)" \
    '{schema_version:1,run_id:$run_id,acquisition_started_epoch:$started,
      artifact_sha256:("a"*64),manifest_sha256:("b"*64)}' \
    >"$ROOT/drill/$run_id/input.json"
  printf '%s\n' "$(sha256_file "$ROOT/drill/$run_id/input.json")" \
    >"$ROOT/drill/$run_id/READY"
}
clear_evidence() {
  rm -f -- "$ROOT/reports/$run_id.json" "$ROOT/status/drill.json"
}
write_input

assert_absent() {
  ! docker container inspect startap-backup-drill-d00df00d >/dev/null 2>&1
  ! docker volume inspect startap-backup-drill-d00df00d-data >/dev/null 2>&1
  ! docker network inspect startap-backup-drill-d00df00d-net >/dev/null 2>&1
}

printf 'TAP version 13\n'
"$SCRIPT_DIR/docker-helper.sh" drill
test -f "$ROOT/reports/$run_id.json" && assert_absent
printf 'ok 1 - valid PG16 restore\n'

clear_evidence
"$TEST_DIR/create-pg16-fixture.sh" "$ROOT/drill/$run_id/dump.sql.gz"
gzip -dc "$ROOT/drill/$run_id/dump.sql.gz" | sed '/database dump complete/i INVALID SQL;' | gzip -n -c >"$ROOT/invalid.gz"
mv "$ROOT/invalid.gz" "$ROOT/drill/$run_id/dump.sql.gz"
set +e; "$SCRIPT_DIR/docker-helper.sh" drill >/dev/null 2>&1; code=$?; set -e
test "$code" -ne 0 && assert_absent
test ! -e "$ROOT/reports/$run_id.json" && test ! -e "$ROOT/status/drill.json"
printf 'ok 2 - invalid SQL stops with ON_ERROR_STOP\n'

clear_evidence
"$TEST_DIR/create-pg16-fixture.sh" "$ROOT/drill/$run_id/dump.sql.gz"
export STARTAP_BACKUP_TEST_FAILPOINT=preseed_destination
set +e; "$SCRIPT_DIR/docker-helper.sh" drill >/dev/null 2>&1; code=$?; set -e
unset STARTAP_BACKUP_TEST_FAILPOINT
test "$code" -ne 0 && assert_absent
test ! -e "$ROOT/reports/$run_id.json" && test ! -e "$ROOT/status/drill.json"
printf 'ok 3 - non-empty destination is refused\n'

clear_evidence
export STARTAP_BACKUP_TEST_DATABASE_NAME=production
set +e; "$SCRIPT_DIR/docker-helper.sh" drill >/dev/null 2>&1; code=$?; set -e
unset STARTAP_BACKUP_TEST_DATABASE_NAME
test "$code" -ne 0 && assert_absent
test ! -e "$ROOT/reports/$run_id.json" && test ! -e "$ROOT/status/drill.json"
printf 'ok 4 - production-like destination is refused\n'

clear_evidence
sed 's|^PG_IMAGE=.*|PG_IMAGE=postgres:15@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff|' \
  "$ROOT/config/policy.conf" >"$ROOT/config/policy.bad"
mv "$ROOT/config/policy.bad" "$ROOT/config/policy.conf"
set +e; "$SCRIPT_DIR/docker-helper.sh" drill >/dev/null 2>&1; code=$?; set -e
test "$code" -ne 0 && assert_absent
test ! -e "$ROOT/reports/$run_id.json" && test ! -e "$ROOT/status/drill.json"
printf 'ok 5 - wrong PostgreSQL digest/version is refused\n'

clear_evidence
printf '%s\n' \
  'EXPECTED_HOSTNAME=fixture' \
  'PG_IMAGE=postgres:16@sha256:ce5c12ac6952df86affd04ade354cfcb9a0aa1171cd7912e6dbd81578a989a63' \
  >"$ROOT/config/policy.conf"
export STARTAP_BACKUP_TEST_FAILPOINT=before_restore
set +e; "$SCRIPT_DIR/docker-helper.sh" drill >/dev/null 2>&1; code=$?; set -e
test "$code" -ne 0 && assert_absent
test ! -e "$ROOT/reports/$run_id.json" && test ! -e "$ROOT/status/drill.json"
printf 'ok 6 - container volume network teardown after failure\n'

unset STARTAP_BACKUP_TEST_FAILPOINT
clear_evidence
"$TEST_DIR/create-pg16-fixture.sh" "$ROOT/drill/$run_id/dump.sql.gz"
write_input
export STARTAP_BACKUP_TEST_FAILPOINT=pause_after_docker_restore
export STARTAP_BACKUP_TEST_PAUSE_SECONDS=300
"$SCRIPT_DIR/docker-helper.sh" drill >"$ROOT/killed-drill.log" 2>&1 & drill_pid=$!
restored=0
for _ in $(seq 1 180); do
  if docker exec startap-backup-drill-d00df00d psql -U postgres \
    -d startap_drill_d00df00d -v ON_ERROR_STOP=1 --no-psqlrc -Atqc \
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL" 2>/dev/null | grep -Fxq t; then
    restored=1
    break
  fi
  kill -0 "$drill_pid" 2>/dev/null || break
  sleep 1
done
test "$restored" = 1 && test -f "$ROOT/drill-journal/docker-reconcile.json"
kill -KILL "$drill_pid"
set +e; wait "$drill_pid"; killed_code=$?; set -e
test "$killed_code" -ne 0
docker volume inspect startap-backup-drill-d00df00d-data >/dev/null
unset STARTAP_BACKUP_TEST_FAILPOINT STARTAP_BACKUP_TEST_PAUSE_SECONDS
"$SCRIPT_DIR/docker-reconcile.sh" reconcile >/dev/null
assert_absent
test ! -e "$ROOT/drill/pending-run" && test ! -e "$ROOT/drill/$run_id"

mkdir "$ROOT/drill/$run_id"
"$TEST_DIR/create-pg16-fixture.sh" "$ROOT/drill/$run_id/dump.sql.gz"
printf '%s\n' "$run_id" >"$ROOT/drill/pending-run"
write_input
"$SCRIPT_DIR/docker-helper.sh" drill
test -f "$ROOT/reports/$run_id.json" && assert_absent
printf 'ok 7 - SIGKILL after restore is reconciled and next PG16 drill succeeds\n'

"$SCRIPT_DIR/docker-reconcile.sh" reconcile >/dev/null
assert_absent
printf 'ok 8 - real Docker orphan inventory accepts an empty labelled state\n'

orphan_run_id=20260814T140000Z-0badc0de
orphan_container=startap-backup-drill-0badc0de
orphan_volume=startap-backup-drill-0badc0de-data
orphan_network=startap-backup-drill-0badc0de-net
docker volume create --label "tech.startap.backup-drill=$orphan_run_id" \
  "$orphan_volume" >/dev/null
set +e
"$SCRIPT_DIR/docker-reconcile.sh" reconcile >"$ROOT/orphan-volume.log" 2>&1
code=$?
set -e
test "$code" -ne 0
grep -Fq 'event=drill_orphans_without_journal' "$ROOT/orphan-volume.log"
docker volume inspect "$orphan_volume" >/dev/null
jq -n --arg run "$orphan_run_id" --arg container "$orphan_container" \
  --arg volume "$orphan_volume" --arg network "$orphan_network" \
  '{schema_version:2,phase:"volume-created",run_id:$run,container:$container,
    volume:$volume,network:$network,label_key:"tech.startap.backup-drill"}' \
  >"$ROOT/drill-journal/docker-reconcile.json"
chmod 0600 "$ROOT/drill-journal/docker-reconcile.json"
"$SCRIPT_DIR/docker-reconcile.sh" reconcile >/dev/null
! docker volume inspect "$orphan_volume" >/dev/null 2>&1
test ! -e "$ROOT/drill-journal/docker-reconcile.json"
printf 'ok 9 - real labelled volume is detected, preserved without tuple, then reconciled exactly\n'
printf '1..9\n'
