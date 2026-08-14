#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 1 ] && [ "$1" = drill ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" docker_helper_command_refused
if ! backup_is_test; then
  [ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" docker_helper_requires_root
fi

CONFIG_DIR="$(backup_path STARTAP_BACKUP_CONFIG_DIR /etc/startap-backup)"
DRILL_ROOT="$(backup_path STARTAP_BACKUP_DRILL_ROOT /run/startap-backup-drill)"
DOCKER_QUERY_ROOT="$(backup_path STARTAP_BACKUP_DOCKER_QUERY_ROOT /run/startap-backup-drill-query)"
REPORT_ROOT="$(backup_path STARTAP_BACKUP_REPORT_ROOT /var/lib/startap-backup/drills)"
STATUS_ROOT="$(backup_path STARTAP_BACKUP_STATUS_ROOT /var/lib/startap-backup-status)"
POLICY_FILE="$CONFIG_DIR/policy.conf"
backup_require_command jq
backup_verify_policy_file "$POLICY_FILE"
# shellcheck source=docker-journal.sh
. "$SCRIPT_DIR/docker-journal.sh"
backup_journal_init
backup_journal_recover_temporary
backup_journal_recover_state_link
if backup_is_test; then
  mkdir -p -- "$DOCKER_QUERY_ROOT"
  chmod 0700 "$DOCKER_QUERY_ROOT"
else
  backup_require_directory "$DOCKER_QUERY_ROOT" root:root 700
fi
if backup_is_test; then
  DOCKER_BIN="${STARTAP_BACKUP_TEST_DOCKER_BIN:-$(command -v docker || true)}"
else
  DOCKER_BIN=/usr/bin/docker
  backup_require_regular_file "$DOCKER_BIN" root:root 755
  backup_require_trusted_parent_chain "$DOCKER_BIN"
fi
[ -n "$DOCKER_BIN" ] && [ -x "$DOCKER_BIN" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" docker_binary_missing
docker() { "$DOCKER_BIN" "$@"; }
# shellcheck source=docker-inspect.sh
. "$SCRIPT_DIR/docker-inspect.sh"
[ -e "$DRILL_ROOT/pending-run" ] || [ -L "$DRILL_ROOT/pending-run" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_pending_missing
[ ! -L "$DRILL_ROOT/pending-run" ] && [ -f "$DRILL_ROOT/pending-run" ] &&
  [ "$(backup_stat_links "$DRILL_ROOT/pending-run")" = 1 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_pending_unsafe
run_id="$(sed -n '1p' "$DRILL_ROOT/pending-run")"
backup_validate_run_id "$run_id"
input_dir="$DRILL_ROOT/$run_id"
dump_file="$input_dir/dump.sql.gz"
input_file="$input_dir/input.json"
[ ! -L "$input_dir/READY" ] && [ -f "$input_dir/READY" ] &&
  [ ! -L "$dump_file" ] && [ -f "$dump_file" ] &&
  [ ! -L "$input_file" ] && [ -f "$input_file" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_input_incomplete
jq -e --arg run_id "$run_id" '.schema_version == 1 and .run_id == $run_id and
  (.acquisition_started_epoch | type == "number" and . > 0) and
  (.artifact_sha256 | test("^[a-f0-9]{64}$")) and
  (.manifest_sha256 | test("^[a-f0-9]{64}$"))' "$input_file" >/dev/null ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_input_metadata_invalid
start_epoch="$(jq -r '.acquisition_started_epoch' "$input_file")"
now_epoch="$(backup_epoch_now)"
[ "$start_epoch" -le "$now_epoch" ] && [ $((now_epoch - start_epoch)) -le 7200 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_rto_start_invalid

if ! backup_is_test; then
  [ "$(hostname)" = "$(backup_read_config "$POLICY_FILE" EXPECTED_HOSTNAME)" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" drill_host_identity_mismatch
fi
image="$(backup_read_config "$POLICY_FILE" PG_IMAGE)"
[ "$image" = postgres:16@sha256:ce5c12ac6952df86affd04ade354cfcb9a0aa1171cd7912e6dbd81578a989a63 ] ||
  backup_die "$BACKUP_EXIT_CONFIG" drill_image_digest_unapproved

suffix="${run_id##*-}"
container="startap-backup-drill-${suffix}"
volume="startap-backup-drill-${suffix}-data"
network="startap-backup-drill-${suffix}-net"
database="startap_drill_${suffix}"
if backup_is_test && [ -n "${STARTAP_BACKUP_TEST_DATABASE_NAME:-}" ]; then
  database="$STARTAP_BACKUP_TEST_DATABASE_NAME"
fi
printf '%s' "$database" | grep -Eq '^startap_drill_[a-f0-9]{8}$' ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_database_name_unsafe
label_key=tech.startap.backup-drill
created_container=0
created_volume=0
created_network=0
teardown_complete=0
reconcile_state_armed=0

resource_label_state() {
  local kind="$1" name="$2" format
  if [ "$kind" = container ]; then
    format="{{ index .Config.Labels \"$label_key\" }}"
  else
    format="{{ index .Labels \"$label_key\" }}"
  fi
  if ! backup_docker_inspect_value "$kind" "$name" "$format"; then
    RESOURCE_LABEL_STATE=error
  elif [ "$BACKUP_DOCKER_QUERY_VALUE" = "$run_id" ]; then
    RESOURCE_LABEL_STATE=match
  else
    RESOURCE_LABEL_STATE=mismatch
  fi
}

require_resource_label() {
  local kind="$1" name="$2" mismatch_event="$3"
  resource_label_state "$kind" "$name"
  case "$RESOURCE_LABEL_STATE" in
    match) return 0 ;;
    mismatch) backup_die "$BACKUP_EXIT_UNSAFE" "$mismatch_event" ;;
    *) backup_die "$BACKUP_EXIT_INTEGRITY" "drill_${kind}_inspect_failed" ;;
  esac
}

require_resource_absent() {
  local kind="$1" name="$2" conflict_event="$3"
  backup_docker_inspect_state "$kind" "$name"
  case "$BACKUP_DOCKER_INSPECT_STATE" in
    absent) return 0 ;;
    present) backup_die "$BACKUP_EXIT_UNSAFE" "$conflict_event" ;;
    *) backup_die "$BACKUP_EXIT_INTEGRITY" "drill_${kind}_inspect_failed" ;;
  esac
}

teardown_resources() {
  local failed=0 tuple kind name created phase
  if ! (backup_journal_write teardown-started "$run_id" "$container" "$volume" "$network"); then
    failed=1
  fi
  for tuple in "container:$container:$created_container" \
    "volume:$volume:$created_volume" "network:$network:$created_network"; do
    kind="${tuple%%:*}"; tuple="${tuple#*:}"; name="${tuple%%:*}"; created="${tuple##*:}"
    [ "$created" = 1 ] || continue
    backup_docker_inspect_state "$kind" "$name"
    case "$BACKUP_DOCKER_INSPECT_STATE" in
      present)
        resource_label_state "$kind" "$name"
        if [ "$RESOURCE_LABEL_STATE" = match ]; then
          case "$kind" in
            container) docker rm -f "$name" >/dev/null 2>&1 || failed=1 ;;
            volume|network) docker "$kind" rm "$name" >/dev/null 2>&1 || failed=1 ;;
          esac
        else
          failed=1
        fi
        ;;
      absent) ;;
      error) failed=1 ;;
    esac
    backup_docker_inspect_state "$kind" "$name"
    [ "$BACKUP_DOCKER_INSPECT_STATE" = absent ] || failed=1
    phase="${kind}-absent"
    if [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" = "pause_after_${kind}_remove_before_journal" ]; then
      sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
    fi
    if ! (backup_journal_write "$phase" "$run_id" "$container" "$volume" "$network"); then
      failed=1
    fi
    if [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" = "pause_after_${kind}_teardown" ]; then
      sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
    fi
  done
  if [ "$failed" = 0 ]; then
    (backup_journal_write teardown-complete "$run_id" "$container" "$volume" "$network") || failed=1
  fi
  [ "$failed" = 0 ]
}

on_exit() {
  local code=$?
  local cleanup_exit=0
  set +e
  if [ "$reconcile_state_armed" = 1 ] && [ "$teardown_complete" != 1 ]; then
    teardown_resources || cleanup_exit=$?
    if [ "$cleanup_exit" = 0 ]; then
      backup_journal_remove || cleanup_exit=$?
      reconcile_state_armed=0
    fi
  fi
  trap - EXIT INT TERM HUP
  if [ "$cleanup_exit" -ne 0 ]; then
    backup_log error drill_teardown_failed >&2
    [ "$code" -ne 0 ] || code="$BACKUP_EXIT_INTEGRITY"
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

for existing in "$container" "$volume" "$network"; do
  case "$existing" in startap-backup-drill-${suffix}*) ;; *)
    backup_die "$BACKUP_EXIT_UNSAFE" drill_resource_name_unsafe ;;
  esac
done
require_resource_absent container "$container" drill_container_conflict
require_resource_absent volume "$volume" drill_volume_conflict
require_resource_absent network "$network" drill_network_conflict

backup_docker_probe_label_orphans "$label_key"
case "$BACKUP_DOCKER_ORPHAN_STATE" in
  absent) ;;
  present) backup_die "$BACKUP_EXIT_INTEGRITY" drill_orphans_without_journal \
    "resource_count=$BACKUP_DOCKER_ORPHAN_COUNT" ;;
  *) backup_die "$BACKUP_EXIT_INTEGRITY" drill_orphan_probe_failed ;;
esac
[ ! -e "$JOURNAL_STATE" ] && [ ! -L "$JOURNAL_STATE" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_reconcile_state_conflict
backup_journal_write armed "$run_id" "$container" "$volume" "$network"
reconcile_state_armed=1
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_journal_armed ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"

created_network=1
docker network create --internal --label "$label_key=$run_id" "$network" >/dev/null
require_resource_label network "$network" drill_network_identity_mismatch
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_network_create_before_journal ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
backup_journal_write network-created "$run_id" "$container" "$volume" "$network"
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_network_create ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
created_volume=1
docker volume create --label "$label_key=$run_id" "$volume" >/dev/null
require_resource_label volume "$volume" drill_volume_identity_mismatch
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_volume_create_before_journal ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
backup_journal_write volume-created "$run_id" "$container" "$volume" "$network"
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_volume_create ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
created_container=1
docker run -d --pull=never --name "$container" --hostname "$container" \
  --label "$label_key=$run_id" --network "$network" \
  --mount "type=volume,src=$volume,dst=/var/lib/postgresql/data" \
  --tmpfs /run/postgresql:rw,noexec,nosuid,nodev,size=16m \
  --shm-size=128m --memory=1g --memory-swap=1g --cpus=1 --pids-limit=256 \
  --security-opt no-new-privileges --env POSTGRES_HOST_AUTH_METHOD=trust \
  "$image" >/dev/null
require_resource_label container "$container" drill_container_identity_mismatch
backup_docker_inspect_value network "$network" '{{.Internal}}' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_network_inspect_failed
[ "$BACKUP_DOCKER_QUERY_VALUE" = true ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_network_not_internal
backup_docker_inspect_value container "$container" '{{json .HostConfig.PortBindings}}' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_container_inspect_failed
port_bindings="$BACKUP_DOCKER_QUERY_VALUE"
[ "$port_bindings" = null ] || [ "$port_bindings" = '{}' ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_public_port_detected
backup_docker_inspect_value container "$container" \
  '{{range .Mounts}}{{printf "%s|%s" .Type .Name}}{{end}}' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_container_inspect_failed
[ "$BACKUP_DOCKER_QUERY_VALUE" = "volume|$volume" ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_mount_identity_mismatch
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_docker_create_before_journal ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
backup_journal_write container-created "$run_id" "$container" "$volume" "$network"
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_docker_create ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"

ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || backup_die "$BACKUP_EXIT_TRANSIENT" drill_postgres_not_ready
[ "$(docker exec "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 --no-psqlrc \
  -Atqc 'SHOW server_version_num' | cut -c1-2)" = 16 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_postgres_version_mismatch
docker exec "$container" createdb -U postgres "$database"
[ "$(docker exec "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 --no-psqlrc \
  -Atqc "SELECT current_database() || ':' || current_user")" = "$database:postgres" ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_database_identity_mismatch
if [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" = preseed_destination ]; then
  docker exec "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 --no-psqlrc \
    -c 'CREATE TABLE fixture_preexisting(id integer);' >/dev/null
fi
[ "$(docker exec "$container" psql -U postgres -d "$database" -v ON_ERROR_STOP=1 --no-psqlrc \
  -Atqc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")" = 0 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_destination_not_empty

[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != before_restore ] ||
  backup_die "$BACKUP_EXIT_TRANSIENT" drill_injected_failure
gzip -dc "$dump_file" | docker exec -i "$container" \
  psql -U postgres -d "$database" -v ON_ERROR_STOP=1 --no-psqlrc >/dev/null ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_restore_sql_failed
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_docker_restore_before_journal ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
backup_journal_write restore-complete "$run_id" "$container" "$volume" "$network"
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != pause_after_docker_restore ] ||
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"

psql_scalar() {
  docker exec "$container" psql -U postgres -d "$database" \
    -v ON_ERROR_STOP=1 --no-psqlrc -Atqc "$1"
}
table_count="$(psql_scalar "SELECT count(*) FROM pg_tables WHERE schemaname='public'")"
[ "$table_count" -ge 50 ] && [ "$table_count" -le 120 ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_table_count_implausible "table_count=$table_count"
migration_count="$(psql_scalar 'SELECT count(*) FROM schema_migrations')"
[ "$migration_count" -ge 79 ] || backup_die "$BACKUP_EXIT_INTEGRITY" drill_migrations_incomplete
for table in schema_migrations flow_clones bot_config client_billing atendimentos; do
  [ "$(psql_scalar "SELECT to_regclass('public.$table') IS NOT NULL")" = t ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_critical_table_missing "table=$table"
done
for table in flow_clones bot_config client_billing atendimentos; do
  [ "$(psql_scalar "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE contype='p' AND conrelid='public.$table'::regclass)")" = t ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_primary_key_missing "table=$table"
done
[ "$(psql_scalar "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE contype='f' AND conrelid='public.client_billing'::regclass AND confrelid='public.flow_clones'::regclass)")" = t ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_billing_fk_missing
[ "$(psql_scalar "SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE contype='f' AND conrelid='public.atendimentos'::regclass AND confrelid='public.flow_clones'::regclass)")" = t ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_atendimentos_fk_missing
for index_name in idx_flow_clones_status idx_client_billing_next_due ix_atend_slot_tenant_data; do
  [ "$(psql_scalar "SELECT to_regclass('public.$index_name') IS NOT NULL")" = t ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_critical_index_missing "index=$index_name"
done
[ "$(psql_scalar "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto')")" = t ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_required_extension_missing "extension=pgcrypto"
[ "$(psql_scalar 'SELECT NOT EXISTS (SELECT 1 FROM client_billing cb LEFT JOIN flow_clones fc ON fc.slot=cb.slot WHERE fc.slot IS NULL)')" = t ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_billing_orphan_detected
[ "$(psql_scalar 'SELECT NOT EXISTS (SELECT 1 FROM atendimentos a LEFT JOIN flow_clones fc ON fc.slot=a.slot WHERE fc.slot IS NULL)')" = t ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_atendimento_orphan_detected

if ! teardown_resources; then
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_teardown_failed
fi
teardown_complete=1
backup_journal_remove
reconcile_state_armed=0
rto_seconds=$(( $(backup_epoch_now) - start_epoch ))
backup_secure_mkdir "$REPORT_ROOT"
report_tmp="$REPORT_ROOT/.${run_id}.tmp.$$"
jq -n --arg run_id "$run_id" --argjson table_count "$table_count" \
  --argjson migration_count "$migration_count" --argjson rto_seconds "$rto_seconds" \
  '{schema_version:1,run_id:$run_id,status:"success",postgres_major:16,
    table_count:$table_count,migration_count:$migration_count,rto_seconds:$rto_seconds,
    critical_tables:true,primary_keys:true,foreign_keys:true,critical_indexes:true,
    sanitized_invariants:true,production_target:false,teardown_complete:true}' >"$report_tmp"
chmod 0600 "$report_tmp"
mv -- "$report_tmp" "$REPORT_ROOT/${run_id}.json"
backup_require_absolute_path "$STATUS_ROOT"
mkdir -p -- "$STATUS_ROOT"
chmod 0755 "$STATUS_ROOT"
cp -- "$REPORT_ROOT/${run_id}.json" "$STATUS_ROOT/drill.json.tmp"
chmod 0600 "$STATUS_ROOT/drill.json.tmp"
mv -- "$STATUS_ROOT/drill.json.tmp" "$STATUS_ROOT/drill.json"
chmod 0644 "$STATUS_ROOT/drill.json"
backup_log info drill_validated "run_id=$run_id" "table_count=$table_count" \
  "migration_count=$migration_count" "rto_seconds=$rto_seconds" "teardown_complete=true"
