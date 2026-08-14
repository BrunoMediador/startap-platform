#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

CONFIG_DIR="$(backup_path STARTAP_BACKUP_CONFIG_DIR /etc/startap-backup)"
STATE_ROOT="$(backup_path STARTAP_BACKUP_STATE_ROOT /var/lib/startap-backup)"
RUN_ROOT="$(backup_path STARTAP_BACKUP_RUN_ROOT /run/startap-backup-producer)"
BRIDGE_ROOT="$(backup_path STARTAP_BACKUP_BRIDGE_ROOT /run/startap-backup-bridge/producer)"
INCOMING_ROOT="$STATE_ROOT/incoming"
GENERATIONS_ROOT="$STATE_ROOT/generations"
READY_FILE="$BRIDGE_ROOT/ready-run"
READY_TMP="$BRIDGE_ROOT/.ready-run.tmp"
POLICY_FILE="$CONFIG_DIR/policy.conf"
RECIPIENTS_FILE="$CONFIG_DIR/recipients.txt"
PLAIN_SQL=""
PLAIN_GZIP=""
BUILD_DIR=""
DUMP_HELPER_PID=""
DUMP_HELPER_STARTED=0

run_dump_helper() {
  local action="$1"
  local marker source_marker cleanup_run_id
  case "$action" in
    dump)
      # Production is started by the root-owned .path unit.  Tests call the
      # same helper synchronously with an artificial fixture.
      if backup_is_test; then "$SCRIPT_DIR/dump-helper.sh" dump; else return 0; fi
      ;;
    cleanup)
      marker="$RUN_ROOT/cleanup-request"
      if [ -n "${run_id:-}" ]; then
        cleanup_run_id="$run_id"
      elif [ -f "$RUN_ROOT/request-run" ] && [ ! -L "$RUN_ROOT/request-run" ]; then
        source_marker="$RUN_ROOT/request-run"
        cleanup_run_id="$(sed -n '1p' "$source_marker")"
      elif [ -f "$marker" ] && [ ! -L "$marker" ]; then
        source_marker="$marker"
        cleanup_run_id="$(sed -n '1p' "$source_marker")"
      else
        source_marker="$(find "$RUN_ROOT/dump" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 1)"
        [ -n "$source_marker" ] || return 0
        cleanup_run_id="$(basename "$source_marker")"
      fi
      backup_validate_run_id "$cleanup_run_id"
      backup_atomic_replace_text "$marker" "$cleanup_run_id"
      chmod 0600 "$marker"
      if backup_is_test; then
        "$SCRIPT_DIR/dump-helper.sh" cleanup
        return $?
      fi
      for _ in $(seq 1 200); do
        if [ ! -e "$RUN_ROOT/request-run" ] && [ ! -L "$RUN_ROOT/request-run" ] &&
          [ ! -e "$marker" ] && [ ! -L "$marker" ] &&
          [ ! -e "$RUN_ROOT/dump" ] && [ ! -L "$RUN_ROOT/dump" ]; then
          return 0
        fi
        sleep 0.05
      done
      return "$BACKUP_EXIT_TRANSIENT"
      ;;
    *) backup_die "$BACKUP_EXIT_UNSAFE" dump_helper_action_refused ;;
  esac
}

cleanup() {
  local code=$?
  trap - EXIT INT TERM HUP
  set +e
  if [ -n "$DUMP_HELPER_PID" ] && kill -0 "$DUMP_HELPER_PID" 2>/dev/null; then
    kill -TERM "$DUMP_HELPER_PID" 2>/dev/null || true
    wait "$DUMP_HELPER_PID" 2>/dev/null || true
  fi
  [ -n "$PLAIN_SQL" ] && backup_secure_unlink "$PLAIN_SQL"
  [ -n "$PLAIN_GZIP" ] && backup_secure_unlink "$PLAIN_GZIP"
  if [ "$DUMP_HELPER_STARTED" = 1 ] || [ -f "$RUN_ROOT/request-run" ] ||
    [ -L "$RUN_ROOT/request-run" ] || [ -f "$RUN_ROOT/cleanup-request" ] ||
    [ -L "$RUN_ROOT/cleanup-request" ] || [ -e "$RUN_ROOT/dump" ] ||
    [ -L "$RUN_ROOT/dump" ]; then
    run_dump_helper cleanup >/dev/null 2>&1 || true
  fi
  if [ "$code" -ne 0 ] && [ -n "$BUILD_DIR" ] && [ -d "$BUILD_DIR" ] &&
    [ ! -f "$BUILD_DIR/PREPARED" ]; then
    case "$BUILD_DIR" in "$INCOMING_ROOT"/.*.tmp) find "$BUILD_DIR" -depth -delete ;; esac
  fi
  backup_release_lock
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

backup_require_command jq
backup_require_command gzip
backup_require_absolute_path "$RUN_ROOT"
backup_verify_policy_file "$POLICY_FILE"
backup_verify_recipients "$RECIPIENTS_FILE"

if ! backup_is_test; then
  [ "$(id -un)" = startap-backup-producer ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" producer_user_identity_mismatch
  [ "$(hostname)" = "$(backup_read_config "$POLICY_FILE" EXPECTED_HOSTNAME)" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" host_identity_mismatch
  backup_require_command findmnt
  [ "$(findmnt -n -o FSTYPE --target "$RUN_ROOT")" = tmpfs ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" run_root_not_tmpfs
  backup_require_directory "$STATE_ROOT" root:root 711
  backup_require_directory "$INCOMING_ROOT" startap-backup-producer:startap-backup-producer 700
  backup_require_directory "$GENERATIONS_ROOT" root:startap-backup-readers 750
  backup_require_directory "$RUN_ROOT" startap-backup-producer:startap-backup-producer 700
  backup_require_directory "$BRIDGE_ROOT" startap-backup-producer:startap-backup-bridge 750
fi
backup_acquire_lock "$RUN_ROOT/locks" producer

write_ready_marker() {
  local ready_run="$1"
  [ ! -e "$READY_FILE" ] && [ ! -L "$READY_FILE" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" producer_ready_conflict
  if [ -e "$READY_TMP" ] || [ -L "$READY_TMP" ]; then
    [ ! -L "$READY_TMP" ] && [ -f "$READY_TMP" ] &&
      [ "$(backup_stat_links "$READY_TMP")" = 1 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" producer_ready_temp_unsafe
    rm -f -- "$READY_TMP"
  fi
  printf '%s\n' "$ready_run" >"$READY_TMP"
  chmod 0640 "$READY_TMP"
  if ! backup_is_test; then chgrp startap-backup-bridge "$READY_TMP"; fi
  [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != producer_after_ready_temp ] ||
    backup_die "$BACKUP_EXIT_TRANSIENT" producer_interrupted_after_ready_temp
  mv -- "$READY_TMP" "$READY_FILE"
}

recover_prepared_incoming() {
  local candidate candidate_run count=0 recovered=""
  if [ -e "$READY_FILE" ] || [ -L "$READY_FILE" ]; then
    [ ! -L "$READY_FILE" ] && [ -f "$READY_FILE" ] &&
      [ "$(backup_stat_links "$READY_FILE")" = 1 ] &&
      [ "$(wc -l <"$READY_FILE" | tr -d ' ')" = 1 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" producer_ready_marker_unsafe
    candidate_run="$(sed -n '1p' "$READY_FILE")"
    backup_validate_run_id "$candidate_run"
    backup_validate_cipher_generation "$INCOMING_ROOT/${candidate_run}.incoming" incoming \
      startap-backup-producer:startap-backup-producer 700 600
    backup_log info producer_ready_recovered "run_id=$candidate_run"
    return 10
  fi
  for candidate in "$INCOMING_ROOT"/*.incoming; do
    [ -d "$candidate" ] || continue
    count=$((count + 1)); recovered="$candidate"
  done
  [ "$count" -le 1 ] || backup_die "$BACKUP_EXIT_INTEGRITY" producer_multiple_incoming_refused
  if [ "$count" = 1 ]; then
    candidate_run="$(basename "$recovered" .incoming)"
    backup_validate_run_id "$candidate_run"
    backup_validate_cipher_generation "$recovered" incoming \
      startap-backup-producer:startap-backup-producer 700 600
    [ "$(backup_manifest_field "$recovered/manifest.json" run_id)" = "$candidate_run" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" incoming_manifest_run_mismatch
    write_ready_marker "$candidate_run"
    backup_log info producer_orphan_incoming_recovered "run_id=$candidate_run"
    return 10
  fi
  return 0
}

set +e
recover_prepared_incoming
recovery_exit=$?
set -e
[ "$recovery_exit" = 0 ] || exit "$recovery_exit"

AGE_BIN="$(backup_verify_age_binary "$POLICY_FILE")"
RECIPIENT_SET_ID="$(backup_read_config "$POLICY_FILE" RECIPIENT_SET_ID)"
backup_validate_opaque_id "$RECIPIENT_SET_ID"
RECIPIENT_EPOCH="$(backup_read_config "$POLICY_FILE" RECIPIENT_EPOCH)"
printf '%s' "$RECIPIENT_EPOCH" | grep -Eq '^[1-9][0-9]*$' ||
  backup_die "$BACKUP_EXIT_CONFIG" recipient_epoch_invalid
[ "$(backup_read_config "$POLICY_FILE" PG_MAJOR)" = 16 ] ||
  backup_die "$BACKUP_EXIT_CONFIG" postgres_policy_invalid
CAP_BYTES="$(backup_read_config "$POLICY_FILE" PLAINTEXT_CAP_BYTES)"
printf '%s' "$CAP_BYTES" | grep -Eq '^[1-9][0-9]*$' ||
  backup_die "$BACKUP_EXIT_CONFIG" plaintext_cap_invalid

timestamp="$(backup_timestamp_now)"
if [ -n "${STARTAP_BACKUP_TEST_RUN_ID:-}" ]; then
  backup_require_test_override STARTAP_BACKUP_TEST_RUN_ID
  run_id="$STARTAP_BACKUP_TEST_RUN_ID"
else
  suffix="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  run_id="${timestamp}-${suffix}"
fi
backup_validate_run_id "$run_id"
timestamp="${run_id%-*}"
artifact="backup-${timestamp}.sql.gz.age"
BUILD_DIR="$INCOMING_ROOT/.${run_id}.tmp"
incoming="$INCOMING_ROOT/${run_id}.incoming"
generation="$GENERATIONS_ROOT/$run_id"

if [ -f "$generation/COMPLETE" ]; then
  backup_validate_cipher_generation "$generation" complete root:startap-backup-readers 550 440
  backup_log info producer_idempotent "run_id=$run_id"
  exit 10
fi
[ ! -e "$generation" ] && [ ! -L "$generation" ] &&
  [ ! -e "$incoming" ] && [ ! -L "$incoming" ] &&
  [ ! -e "$BUILD_DIR" ] && [ ! -L "$BUILD_DIR" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" producer_name_conflict
# A root helper may have died after claiming a previous request.  An
# idempotent cleanup request before every new dump consumes that root-only
# claim and runtime without giving the producer read access to either.
run_dump_helper cleanup >/dev/null ||
  backup_die "$BACKUP_EXIT_TRANSIENT" stale_dump_runtime_cleanup_failed
mkdir -- "$BUILD_DIR"
chmod 0700 "$BUILD_DIR"

plain_dir="$RUN_ROOT/plain/$run_id"
mkdir -p -- "$RUN_ROOT/plain"
chmod 0700 "$RUN_ROOT/plain"
mkdir -- "$plain_dir"
chmod 0700 "$plain_dir"
PLAIN_SQL="$plain_dir/dump.sql"
PLAIN_GZIP="$plain_dir/dump.sql.gz"

if [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" = storage_full ]; then
  backup_die "$BACKUP_EXIT_TRANSIENT" storage_write_failed
fi
backup_atomic_text "$RUN_ROOT/request-run" "$run_id"
chmod 0600 "$RUN_ROOT/request-run"
if backup_is_test; then
  run_dump_helper dump &
  DUMP_HELPER_PID=$!
else
  run_dump_helper dump
fi
DUMP_HELPER_STARTED=1
fifo="$RUN_ROOT/dump/$run_id/dump.fifo"
dump_ok="$RUN_ROOT/dump/$run_id/DUMP_OK"
fifo_ready=0
if backup_is_test; then fifo_attempts=500; fifo_sleep=0.01
else fifo_attempts=300; fifo_sleep=0.1
fi
for _ in $(seq 1 "$fifo_attempts"); do
  if [ -p "$fifo" ]; then fifo_ready=1; break; fi
  if backup_is_test && ! kill -0 "$DUMP_HELPER_PID" 2>/dev/null; then break; fi
  sleep "$fifo_sleep"
done
[ "$fifo_ready" = 1 ] || {
  if backup_is_test; then set +e; wait "$DUMP_HELPER_PID"; set -e; fi
  backup_die "$BACKUP_EXIT_TRANSIENT" dump_fifo_unavailable
}
if ! backup_is_test; then
  [ "$(backup_stat_identity_mode "$fifo")" = root:startap-backup-producer:640 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" dump_fifo_metadata_invalid
fi

file_blocks=$(( (CAP_BYTES + 511) / 512 ))
set +e
(ulimit -f "$file_blocks"; cat -- "$fifo") >"$PLAIN_SQL"
reader_exit=$?
if backup_is_test; then
  wait "$DUMP_HELPER_PID"
  helper_exit=$?
else
  helper_exit=0
  for _ in $(seq 1 100); do
    [ -f "$dump_ok" ] && break
    sleep 0.02
  done
fi
set -e
DUMP_HELPER_PID=""
[ "$reader_exit" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" plaintext_cap_exceeded
[ "$helper_exit" = 0 ] || backup_die "$BACKUP_EXIT_TRANSIENT" pg_dump_helper_failed
[ ! -L "$dump_ok" ] && [ -f "$dump_ok" ] && [ "$(sed -n '1p' "$dump_ok")" = "$run_id" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" dump_completion_proof_missing
if ! backup_is_test; then
  [ "$(backup_stat_identity_mode "$dump_ok")" = root:startap-backup-producer:640 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" dump_completion_proof_metadata_invalid
fi

chmod 0600 "$PLAIN_SQL"
plain_size="$(backup_file_size "$PLAIN_SQL")"
[ "$plain_size" -gt 0 ] || backup_die "$BACKUP_EXIT_INTEGRITY" dump_empty
[ "$plain_size" -le "$CAP_BYTES" ] || backup_die "$BACKUP_EXIT_UNSAFE" plaintext_cap_exceeded
if [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" = pause_after_plaintext ]; then
  sleep "${STARTAP_BACKUP_TEST_PAUSE_SECONDS:-300}"
fi

gzip -n -9 -c "$PLAIN_SQL" >"$PLAIN_GZIP" ||
  backup_die "$BACKUP_EXIT_INTEGRITY" gzip_failed
chmod 0600 "$PLAIN_GZIP"
gzip -t "$PLAIN_GZIP" || backup_die "$BACKUP_EXIT_INTEGRITY" gzip_invalid
gzip -dc "$PLAIN_GZIP" | sed -n '1,20p' | grep -Fq 'PostgreSQL database dump' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" dump_header_invalid
gzip -dc "$PLAIN_GZIP" | tail -n 20 | grep -Fq 'PostgreSQL database dump complete' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" dump_completion_invalid

set --
while IFS= read -r recipient; do
  case "$recipient" in ''|'#'*) continue ;; esac
  set -- "$@" -r "$recipient"
done <"$RECIPIENTS_FILE"
age_error="$plain_dir/age.err"
if ! "$AGE_BIN" "$@" -o "$BUILD_DIR/${artifact}.tmp" "$PLAIN_GZIP" 2>"$age_error"; then
  rm -f -- "$age_error"
  backup_die "$BACKUP_EXIT_INTEGRITY" age_encrypt_failed
fi
rm -f -- "$age_error"
chmod 0600 "$BUILD_DIR/${artifact}.tmp"
mv -- "$BUILD_DIR/${artifact}.tmp" "$BUILD_DIR/$artifact"

backup_secure_unlink "$PLAIN_SQL"
PLAIN_SQL=""
backup_secure_unlink "$PLAIN_GZIP"
PLAIN_GZIP=""
rmdir -- "$plain_dir" 2>/dev/null || true
run_dump_helper cleanup >/dev/null ||
  backup_die "$BACKUP_EXIT_TRANSIENT" dump_runtime_cleanup_failed
DUMP_HELPER_STARTED=0

artifact_sha="$(backup_sha256 "$BUILD_DIR/$artifact")"
artifact_size="$(backup_file_size "$BUILD_DIR/$artifact")"
printf '%s  %s\n' "$artifact_sha" "$artifact" >"$BUILD_DIR/SHA256SUMS"
chmod 0600 "$BUILD_DIR/SHA256SUMS"
jq -n --arg run_id "$run_id" --arg created_at "$timestamp" --arg artifact "$artifact" \
  --arg sha256 "$artifact_sha" --arg recipient_set_id "$RECIPIENT_SET_ID" \
  --argjson size_bytes "$artifact_size" --argjson recipient_epoch "$RECIPIENT_EPOCH" \
  '{schema_version:1,run_id:$run_id,created_at:$created_at,artifact:$artifact,
    sha256:$sha256,size_bytes:$size_bytes,recipient_set_id:$recipient_set_id,
    recipient_epoch:$recipient_epoch,recipient_count:2,postgres_major:16}' \
  >"$BUILD_DIR/manifest.json"
chmod 0600 "$BUILD_DIR/manifest.json"
backup_manifest_validate_shape "$BUILD_DIR/manifest.json"
backup_atomic_text "$BUILD_DIR/PREPARED" "$artifact_sha"
backup_validate_cipher_generation "$BUILD_DIR" incoming \
  startap-backup-producer:startap-backup-producer 700 600
[ "$(backup_device_id "$BUILD_DIR")" = "$(backup_device_id "$INCOMING_ROOT")" ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" incoming_cross_filesystem_refused
mv -- "$BUILD_DIR" "$incoming"
BUILD_DIR=""
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != producer_after_incoming_publish ] ||
  backup_die "$BACKUP_EXIT_TRANSIENT" producer_interrupted_after_incoming_publish
write_ready_marker "$run_id"
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != producer_after_ready_publish ] ||
  backup_die "$BACKUP_EXIT_TRANSIENT" producer_interrupted_after_ready_publish
backup_log info producer_prepared "run_id=$run_id" "size_bytes=$artifact_size"
