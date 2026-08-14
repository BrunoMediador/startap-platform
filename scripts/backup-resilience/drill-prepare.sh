#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

CONFIG_DIR="$(backup_path STARTAP_BACKUP_CONFIG_DIR /etc/startap-backup)"
STATE_ROOT="$(backup_path STARTAP_BACKUP_STATE_ROOT /var/lib/startap-backup)"
GENERATIONS_ROOT="$STATE_ROOT/generations"
DRILL_ROOT="$(backup_path STARTAP_BACKUP_DRILL_ROOT /run/startap-backup-drill)"
POLICY_FILE="$CONFIG_DIR/policy.conf"
PLAIN_GZIP=""
DRILL_DIR=""
RUN_ID=""

cleanup() {
  local code=$?
  set +e
  if [ "$code" -ne 0 ]; then
    [ -n "$PLAIN_GZIP" ] && backup_secure_unlink "$PLAIN_GZIP"
    if [ -n "$DRILL_DIR" ]; then
      case "$DRILL_DIR" in "$DRILL_ROOT"/[0-9]*Z-[a-f0-9]*) find "$DRILL_DIR" -depth -delete 2>/dev/null || true ;; esac
    fi
    if [ -L "$DRILL_ROOT/pending-run" ]; then
      rm -f -- "$DRILL_ROOT/pending-run"
    elif [ -f "$DRILL_ROOT/pending-run" ] && [ -n "$RUN_ID" ] &&
      [ "$(sed -n '1p' "$DRILL_ROOT/pending-run")" = "$RUN_ID" ]; then
      rm -f -- "$DRILL_ROOT/pending-run"
    fi
  fi
  trap - EXIT INT TERM HUP
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

started_epoch="$(backup_epoch_now)"
started_at="$(backup_timestamp_now)"
backup_verify_policy_file "$POLICY_FILE"
AGE_BIN="$(backup_verify_age_binary "$POLICY_FILE")"
if backup_is_test; then
  IDENTITY_FILE="${STARTAP_BACKUP_TEST_IDENTITY_FILE:-}"
else
  [ "$(id -un)" = startap-backup-validator ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" drill_prepare_user_identity_mismatch
  [ -n "${CREDENTIALS_DIRECTORY:-}" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" credentials_directory_missing
  IDENTITY_FILE="$CREDENTIALS_DIRECTORY/automation.agekey"
  backup_require_directory "$GENERATIONS_ROOT" root:startap-backup-readers 750
fi
[ -n "$IDENTITY_FILE" ] && [ ! -L "$IDENTITY_FILE" ] && [ -r "$IDENTITY_FILE" ] &&
  [ -f "$IDENTITY_FILE" ] || backup_die "$BACKUP_EXIT_CONFIG" automation_identity_unreadable

latest=""
for candidate in "$GENERATIONS_ROOT"/*; do
  [ -d "$candidate" ] && [ -f "$candidate/COMPLETE" ] || continue
  name="$(basename "$candidate")"
  printf '%s' "$name" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$' || continue
  if (backup_validate_cipher_generation "$candidate" complete \
      root:startap-backup-readers 550 440) >/dev/null 2>&1; then
    if [ -z "$latest" ] || [ "$name" \> "$latest" ]; then latest="$name"; fi
  fi
done
[ -n "$latest" ] || backup_die "$BACKUP_EXIT_INTEGRITY" no_valid_generation_for_drill
RUN_ID="$latest"
generation="$GENERATIONS_ROOT/$RUN_ID"
backup_validate_cipher_generation "$generation" complete root:startap-backup-readers 550 440
manifest="$generation/manifest.json"
created_at="$(backup_manifest_field "$manifest" created_at)"
age_seconds=$(( $(backup_epoch_now) - $(backup_timestamp_to_epoch "$created_at") ))
stale_seconds="$(backup_read_config "$POLICY_FILE" FRESHNESS_STALE_SECONDS)"
[ "$age_seconds" -ge 0 ] && [ "$age_seconds" -le "$stale_seconds" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_backup_stale "age_seconds=$age_seconds"
artifact="$(backup_manifest_field "$manifest" artifact)"

backup_secure_mkdir "$DRILL_ROOT"
if [ -L "$DRILL_ROOT/pending-run" ]; then
  rm -f -- "$DRILL_ROOT/pending-run"
  backup_log warn drill_prepare_pending_symlink_removed
fi
DRILL_DIR="$DRILL_ROOT/$RUN_ID"
[ ! -e "$DRILL_DIR" ] && [ ! -L "$DRILL_DIR" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_run_conflict
mkdir -- "$DRILL_DIR"
chmod 0700 "$DRILL_DIR"
PLAIN_GZIP="$DRILL_DIR/dump.sql.gz"
age_error="$DRILL_DIR/age.err"
if ! "$AGE_BIN" -d -i "$IDENTITY_FILE" -o "$PLAIN_GZIP" \
  "$generation/$artifact" 2>"$age_error"; then
  rm -f -- "$age_error"
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_decrypt_failed
fi
rm -f -- "$age_error"
chmod 0600 "$PLAIN_GZIP"
gzip -t "$PLAIN_GZIP" || backup_die "$BACKUP_EXIT_INTEGRITY" drill_gzip_invalid
gzip -dc "$PLAIN_GZIP" | sed -n '1,20p' | grep -Fq 'PostgreSQL database dump' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_dump_header_invalid
gzip -dc "$PLAIN_GZIP" | tail -n 20 | grep -Fq 'PostgreSQL database dump complete' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_dump_completion_invalid

jq -n --arg run_id "$RUN_ID" --arg created_at "$created_at" \
  --arg acquisition_started_at "$started_at" \
  --arg artifact_sha256 "$(backup_manifest_field "$manifest" sha256)" \
  --arg manifest_sha256 "$(backup_sha256 "$manifest")" \
  --argjson acquisition_started_epoch "$started_epoch" --argjson age_seconds "$age_seconds" \
  '{schema_version:1,run_id:$run_id,created_at:$created_at,
    artifact_sha256:$artifact_sha256,manifest_sha256:$manifest_sha256,
    age_seconds:$age_seconds,acquisition_started_at:$acquisition_started_at,
    acquisition_started_epoch:$acquisition_started_epoch}' >"$DRILL_DIR/input.json"
chmod 0600 "$DRILL_DIR/input.json"
backup_atomic_text "$DRILL_DIR/READY" "$(backup_sha256 "$DRILL_DIR/input.json")"
backup_atomic_text "$DRILL_ROOT/pending-run" "$RUN_ID"
PLAIN_GZIP=""
backup_log info drill_input_prepared "run_id=$RUN_ID" "age_seconds=$age_seconds"
