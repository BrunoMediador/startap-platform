#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

CONFIG_DIR="$(backup_path STARTAP_BACKUP_CONFIG_DIR /etc/startap-backup)"
STATE_ROOT="$(backup_path STARTAP_BACKUP_STATE_ROOT /var/lib/startap-backup)"
SEALED_ROOT="$STATE_ROOT/sealed"
ATTESTATION_ROOT="$(backup_path STARTAP_BACKUP_ATTESTATION_ROOT /var/lib/startap-backup-attestations)"
VALIDATION_ROOT="$(backup_path STARTAP_BACKUP_VALIDATION_ROOT /run/startap-backup-validation)"
POLICY_FILE="$CONFIG_DIR/policy.conf"
PENDING_FILE="$STATE_ROOT/pending-run"
PLAIN_GZIP=""

cleanup() {
  local code=$?
  set +e
  [ -n "$PLAIN_GZIP" ] && backup_secure_unlink "$PLAIN_GZIP"
  trap - EXIT INT TERM HUP
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

backup_require_command jq
backup_require_command gzip
backup_verify_policy_file "$POLICY_FILE"
AGE_BIN="$(backup_verify_age_binary "$POLICY_FILE")"
if backup_is_test; then
  IDENTITY_FILE="${STARTAP_BACKUP_TEST_IDENTITY_FILE:-}"
  [ -n "$IDENTITY_FILE" ] || backup_die "$BACKUP_EXIT_CONFIG" automation_identity_missing
else
  [ "$(id -un)" = startap-backup-validator ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" validator_user_identity_mismatch
  [ -n "${CREDENTIALS_DIRECTORY:-}" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" credentials_directory_missing
  IDENTITY_FILE="$CREDENTIALS_DIRECTORY/automation.agekey"
  backup_require_directory "$SEALED_ROOT" root:startap-backup-validator 750
  backup_require_directory "$ATTESTATION_ROOT" \
    startap-backup-validator:startap-backup-validator 700
  backup_require_regular_file "$PENDING_FILE" root:startap-backup-validator 640
fi
[ ! -L "$IDENTITY_FILE" ] && [ -r "$IDENTITY_FILE" ] && [ -f "$IDENTITY_FILE" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" automation_identity_unreadable

run_id="$(sed -n '1p' "$PENDING_FILE")"
backup_validate_run_id "$run_id"
sealed="$SEALED_ROOT/$run_id"
backup_validate_cipher_generation "$sealed" sealed root:startap-backup-validator 550 440
[ "$(backup_manifest_field "$sealed/manifest.json" run_id)" = "$run_id" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" sealed_manifest_run_mismatch
manifest="$sealed/manifest.json"
artifact="$(backup_manifest_field "$manifest" artifact)"
expected_sha="$(backup_manifest_field "$manifest" sha256)"

backup_secure_mkdir "$VALIDATION_ROOT"
validation_dir="$VALIDATION_ROOT/$run_id"
[ ! -e "$validation_dir" ] || backup_die "$BACKUP_EXIT_INTEGRITY" validation_runtime_conflict
mkdir -- "$validation_dir"
chmod 0700 "$validation_dir"
PLAIN_GZIP="$validation_dir/dump.sql.gz"
age_error="$validation_dir/age.err"
if ! "$AGE_BIN" -d -i "$IDENTITY_FILE" -o "$PLAIN_GZIP" "$sealed/$artifact" 2>"$age_error"; then
  rm -f -- "$age_error"
  backup_die "$BACKUP_EXIT_INTEGRITY" age_decrypt_failed
fi
rm -f -- "$age_error"
chmod 0600 "$PLAIN_GZIP"
gzip -t "$PLAIN_GZIP" || backup_die "$BACKUP_EXIT_INTEGRITY" gzip_truncated_or_invalid
gzip -dc "$PLAIN_GZIP" | sed -n '1,20p' | grep -Fq 'PostgreSQL database dump' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" dump_header_invalid
gzip -dc "$PLAIN_GZIP" | tail -n 20 | grep -Fq 'PostgreSQL database dump complete' ||
  backup_die "$BACKUP_EXIT_INTEGRITY" dump_completion_invalid

manifest_sha="$(backup_sha256 "$manifest")"
validated_at="$(backup_timestamp_now)"
attestation="$ATTESTATION_ROOT/${run_id}.json"
attestation_tmp="$ATTESTATION_ROOT/.${run_id}.tmp.$$"
jq -n --arg run_id "$run_id" --arg manifest_sha "$manifest_sha" \
  --arg artifact_sha "$expected_sha" --arg validated_at "$validated_at" \
  '{schema_version:1,run_id:$run_id,manifest_sha256:$manifest_sha,
    artifact_sha256:$artifact_sha,validated_at:$validated_at,
    method:"age-decrypt+gzip-test+pgdump-markers"}' >"$attestation_tmp"
chmod 0600 "$attestation_tmp"
mv -- "$attestation_tmp" "$attestation"

heartbeat_tmp="$ATTESTATION_ROOT/.identity-heartbeat.tmp.$$"
jq -n --arg run_id "$run_id" --arg checked_at "$validated_at" \
  --arg recipient_set_id "$(backup_manifest_field "$manifest" recipient_set_id)" \
  --argjson recipient_epoch "$(backup_manifest_field "$manifest" recipient_epoch)" \
  '{schema_version:1,state:"healthy",run_id:$run_id,checked_at:$checked_at,
    recipient_set_id:$recipient_set_id,recipient_epoch:$recipient_epoch,
    decrypt_succeeded:true}' >"$heartbeat_tmp"
chmod 0600 "$heartbeat_tmp"
mv -- "$heartbeat_tmp" "$ATTESTATION_ROOT/identity-heartbeat.json"

backup_secure_unlink "$PLAIN_GZIP"
PLAIN_GZIP=""
rmdir -- "$validation_dir" 2>/dev/null || true
backup_log info validation_passed "run_id=$run_id"
