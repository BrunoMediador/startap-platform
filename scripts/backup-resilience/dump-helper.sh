#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 1 ] || backup_die "$BACKUP_EXIT_UNSAFE" dump_helper_arguments_refused
case "$1" in dump|cleanup) ;; *) backup_die "$BACKUP_EXIT_UNSAFE" dump_helper_command_refused ;; esac

RUN_ROOT="$(backup_path STARTAP_BACKUP_RUN_ROOT /run/startap-backup-producer)"
CLAIM_ROOT="$(backup_path STARTAP_BACKUP_DUMP_CLAIM_ROOT /run/startap-backup-dump-helper)"
CONFIG_DIR="$(backup_path STARTAP_BACKUP_CONFIG_DIR /etc/startap-backup)"
POLICY_FILE="$CONFIG_DIR/policy.conf"
REQUEST_FILE="$RUN_ROOT/request-run"
CLEANUP_FILE="$RUN_ROOT/cleanup-request"
ACTIVE_FILE="$CLAIM_ROOT/active-run"
LOCK_DIR="$CLAIM_ROOT/helper.lock"

if ! backup_is_test; then
  [ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" dump_helper_requires_root
  backup_require_directory "$RUN_ROOT" startap-backup-producer:startap-backup-producer 700
  backup_require_directory "$CLAIM_ROOT" root:root 700
else
  mkdir -p -- "$CLAIM_ROOT"
  chmod 0700 "$CLAIM_ROOT"
fi
# shellcheck source=quarantine.sh
. "$SCRIPT_DIR/quarantine.sh"
backup_quarantine_init

# Serializing in a root-only directory makes claim creation non-overwriting.
# The untrusted producer-owned path is renamed into this directory before any
# stat/read, closing path substitution and malformed-marker retrigger loops.
acquire_helper_lock() {
  local owner=""
  if ! mkdir -- "$LOCK_DIR" 2>/dev/null; then
    for _ in $(seq 1 10); do [ -f "$LOCK_DIR/pid" ] && break; sleep 0.01; done
    if [ ! -L "$LOCK_DIR/pid" ] && [ -f "$LOCK_DIR/pid" ]; then owner="$(sed -n '1p' "$LOCK_DIR/pid")"; fi
    if printf '%s' "$owner" | grep -Eq '^[1-9][0-9]*$' && kill -0 "$owner" 2>/dev/null; then
      backup_die "$BACKUP_EXIT_TRANSIENT" dump_helper_concurrent
    fi
    # Root-only stale lease recovery handles SIGKILL without waiting for reboot.
    rm -f -- "$LOCK_DIR/pid"
    rmdir -- "$LOCK_DIR" 2>/dev/null || backup_die "$BACKUP_EXIT_TRANSIENT" dump_helper_lock_unsafe
    mkdir -- "$LOCK_DIR" 2>/dev/null || backup_die "$BACKUP_EXIT_TRANSIENT" dump_helper_concurrent
  fi
  printf '%s\n' "$$" >"$LOCK_DIR/pid"
  chmod 0600 "$LOCK_DIR/pid"
}
cleanup_lock() { rm -f -- "$LOCK_DIR/pid"; rmdir -- "$LOCK_DIR" 2>/dev/null || true; }
acquire_helper_lock
trap cleanup_lock EXIT
trap 'cleanup_lock; exit 130' INT
trap 'cleanup_lock; exit 143' TERM HUP

# Every helper activation advances the isolated queue by a fixed amount. A
# prior oversized marker therefore cannot permanently occupy a producer path
# slot or require an unbounded recursive traversal in this service.
backup_quarantine_recover 256
if [ "$BACKUP_QUARANTINE_REMAINS" = true ]; then
  backup_log warn dump_quarantine_recovery_pending "work=$BACKUP_QUARANTINE_WORK"
fi

quarantine_claim() {
  local claim="$1" event="$2"
  case "$claim" in
    "$CLAIM_ROOT"/.request.*.claim|"$CLAIM_ROOT"/.cleanup.*.claim|"$ACTIVE_FILE") ;;
    *) backup_die "$BACKUP_EXIT_UNSAFE" dump_quarantine_path_refused ;;
  esac
  backup_quarantine_enqueue "$claim" marker
  backup_quarantine_recover 256
  [ "$BACKUP_QUARANTINE_REMAINS" = false ] ||
    backup_log warn dump_quarantine_recovery_pending "work=$BACKUP_QUARANTINE_WORK"
  backup_log error "$event"
  exit "$BACKUP_EXIT_UNSAFE"
}

consume_active_symlink() {
  [ -L "$ACTIVE_FILE" ] || return 0
  backup_quarantine_enqueue "$ACTIVE_FILE" active-link
  backup_quarantine_recover 64
  backup_log warn dump_active_symlink_removed
}

claim_marker() {
  local source="$1" name="$2" claim nonce
  nonce="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  claim="$CLAIM_ROOT/.${name}.$$.${nonce}.claim"
  [ ! -e "$claim" ] && [ ! -L "$claim" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" dump_claim_conflict
  # mv claims the directory entry itself; a symlink is moved, never followed.
  mv -- "$source" "$claim" 2>/dev/null ||
    backup_die "$BACKUP_EXIT_TRANSIENT" dump_marker_claim_failed
  printf '%s\n' "$claim"
}

validate_claim() {
  local claim="$1" event="$2" value
  [ ! -L "$claim" ] && [ -f "$claim" ] &&
    [ "$(backup_stat_links "$claim" 2>/dev/null || printf 0)" = 1 ] ||
    quarantine_claim "$claim" "$event"
  if ! backup_is_test; then
    [ "$(backup_stat_identity_mode "$claim" 2>/dev/null || true)" = \
      startap-backup-producer:startap-backup-producer:600 ] ||
      quarantine_claim "$claim" "$event"
  fi
  [ "$(backup_file_size "$claim" 2>/dev/null || printf 65)" -le 64 ] ||
    quarantine_claim "$claim" "$event"
  [ "$(wc -l <"$claim" | tr -d ' ')" = 1 ] || quarantine_claim "$claim" "$event"
  value="$(sed -n '1p' "$claim")"
  printf '%s' "$value" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$' ||
    quarantine_claim "$claim" "$event"
  CLAIM_RUN_ID="$value"
}

if [ "$1" = dump ]; then
  request_claim="$(claim_marker "$REQUEST_FILE" request)"
  validate_claim "$request_claim" dump_request_quarantined
  run_id="$CLAIM_RUN_ID"
  consume_active_symlink
  [ ! -e "$ACTIVE_FILE" ] && [ ! -L "$ACTIVE_FILE" ] || {
    rm -f -- "$request_claim"
    backup_die "$BACKUP_EXIT_INTEGRITY" dump_active_conflict
  }
  mv -- "$request_claim" "$ACTIVE_FILE"
else
  cleanup_claim="$(claim_marker "$CLEANUP_FILE" cleanup)"
  validate_claim "$cleanup_claim" dump_cleanup_request_quarantined
  run_id="$CLAIM_RUN_ID"
  consume_active_symlink
  if [ ! -e "$ACTIVE_FILE" ] && [ ! -L "$ACTIVE_FILE" ] &&
    { [ -e "$REQUEST_FILE" ] || [ -L "$REQUEST_FILE" ]; }; then
    request_claim="$(claim_marker "$REQUEST_FILE" request)"
    validate_claim "$request_claim" dump_request_quarantined
    active_run="$CLAIM_RUN_ID"
    mv -- "$request_claim" "$ACTIVE_FILE"
  elif [ -e "$ACTIVE_FILE" ] || [ -L "$ACTIVE_FILE" ]; then
    validate_claim "$ACTIVE_FILE" dump_active_marker_quarantined
    active_run="$CLAIM_RUN_ID"
  else
    active_run="$run_id"
  fi
  if [ "$active_run" != "$run_id" ]; then
    backup_log warn dump_stale_active_recovery
    run_id="$active_run"
  fi
fi

dump_root="$RUN_ROOT/dump"
run_dir="$dump_root/$run_id"
fifo="$run_dir/dump.fifo"
fifo_tmp="$run_dir/.dump.fifo.tmp"
ok_marker="$run_dir/DUMP_OK"
error_file="$run_dir/dump.err"

cleanup_runtime() {
  [ -e "$run_dir" ] || {
    rm -f -- "$ACTIVE_FILE" "$cleanup_claim"
    return 0
  }
  case "$run_dir" in "$RUN_ROOT"/dump/[0-9]*Z-[a-f0-9]*) ;; *)
    backup_die "$BACKUP_EXIT_UNSAFE" dump_cleanup_path_refused ;;
  esac
  [ ! -L "$run_dir" ] && [ -d "$run_dir" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" dump_cleanup_target_invalid
  find "$run_dir" -depth -delete
  rmdir -- "$dump_root" 2>/dev/null || true
  rm -f -- "$ACTIVE_FILE" "$cleanup_claim"
}

if [ "$1" = cleanup ]; then
  cleanup_runtime
  backup_log info dump_helper_cleanup_complete "run_id=$run_id"
  exit 0
fi

[ ! -e "$run_dir" ] || backup_die "$BACKUP_EXIT_INTEGRITY" dump_runtime_conflict
mkdir -p -- "$dump_root"
mkdir -- "$run_dir"
: >"$error_file"
chmod 0600 "$error_file"
if ! backup_is_test; then
  chown root:startap-backup-producer "$dump_root" "$run_dir"
  chmod 0750 "$dump_root" "$run_dir"
fi

# Runtime targets are intentionally constants. Public policy is checked only to
# detect configuration drift; it never supplies Docker command arguments.
[ "$(backup_read_config "$POLICY_FILE" PG_CONTAINER)" = automacoes-postgres-1 ] &&
  [ "$(backup_read_config "$POLICY_FILE" PG_DATABASE)" = startap_database ] &&
  [ "$(backup_read_config "$POLICY_FILE" PG_USER)" = startap_user ] &&
  [ "$(backup_read_config "$POLICY_FILE" PG_MAJOR)" = 16 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" database_policy_identity_mismatch

if ! backup_is_test; then
  DOCKER_BIN=/usr/bin/docker
  backup_require_regular_file "$DOCKER_BIN" root:root 755
  backup_require_trusted_parent_chain "$DOCKER_BIN"
  docker() { "$DOCKER_BIN" "$@"; }
  backup_require_command timeout
  identity="$(docker container inspect automacoes-postgres-1 \
    --format '{{.Name}}|{{.State.Running}}|{{index .Config.Labels "com.docker.compose.service"}}' \
    2>"$error_file")" || backup_die "$BACKUP_EXIT_UNSAFE" postgres_container_unverified
  [ "$identity" = '/automacoes-postgres-1|true|postgres' ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" postgres_container_identity_mismatch
  database_identity="$(docker exec automacoes-postgres-1 psql -U startap_user \
    -d startap_database -v ON_ERROR_STOP=1 -Atqc \
    "SELECT current_database() || ':' || current_user || ':' || current_setting('server_version_num')" \
    2>"$error_file")" || backup_die "$BACKUP_EXIT_UNSAFE" postgres_database_unverified
  printf '%s' "$database_identity" | grep -Eq '^startap_database:startap_user:16[0-9]{4}$' ||
    backup_die "$BACKUP_EXIT_UNSAFE" postgres_database_identity_mismatch
fi

mkfifo -m 0640 "$fifo_tmp"
if ! backup_is_test; then
  chown root:startap-backup-producer "$fifo_tmp"
  [ "$(backup_stat_identity_mode "$fifo_tmp")" = root:startap-backup-producer:640 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" dump_fifo_metadata_invalid
fi
mv -- "$fifo_tmp" "$fifo"

dump_exit=0
if backup_is_test; then
  fixture="${STARTAP_BACKUP_FIXTURE_SQL:-}"
  [ -n "$fixture" ] && [ -f "$fixture" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" fixture_missing
  case "${STARTAP_BACKUP_TEST_FAILPOINT:-}" in
    dump_helper_fail)
      : >"$fifo" || true
      dump_exit=42
      ;;
    dump_helper_partial_fail)
      { sed -n '1,2p' "$fixture" >"$fifo"; } || true
      dump_exit=43
      ;;
    *)
      cp -- "$fixture" "$fifo" || dump_exit=$?
      ;;
  esac
else
  set +e
  timeout --signal=TERM --kill-after=30s 31m bash -c '
    exec /usr/bin/docker exec automacoes-postgres-1 pg_dump \
      -U startap_user -d startap_database --format=p --no-owner --no-privileges >"$1"
  ' startap-dump "$fifo" 2>"$error_file"
  dump_exit=$?
  set -e
fi

if [ "$dump_exit" -ne 0 ]; then
  rm -f -- "$ok_marker" "$error_file"
  backup_die "$BACKUP_EXIT_TRANSIENT" pg_dump_helper_failed
fi

printf '%s\n' "$run_id" >"$ok_marker.tmp"
chmod 0640 "$ok_marker.tmp"
if ! backup_is_test; then chown root:startap-backup-producer "$ok_marker.tmp"; fi
mv -- "$ok_marker.tmp" "$ok_marker"
rm -f -- "$error_file"
backup_log info pg_dump_helper_complete "run_id=$run_id"
