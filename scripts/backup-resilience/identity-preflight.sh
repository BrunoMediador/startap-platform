#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" identity_preflight_arguments_refused
[ "$(id -un)" = startap-backup-validator ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" identity_preflight_user_mismatch
[ -n "${CREDENTIALS_DIRECTORY:-}" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" credentials_directory_missing

CONFIG_DIR=/etc/startap-backup
POLICY_FILE="$CONFIG_DIR/policy.conf"
RECIPIENTS_FILE="$CONFIG_DIR/recipients.txt"
ATTESTATION_ROOT=/var/lib/startap-backup-attestations
IDENTITY_FILE="$CREDENTIALS_DIRECTORY/automation.agekey"
backup_verify_policy_file "$POLICY_FILE"
backup_verify_recipients "$RECIPIENTS_FILE"
backup_require_directory "$ATTESTATION_ROOT" \
  startap-backup-validator:startap-backup-validator 700
[ ! -L "$IDENTITY_FILE" ] && [ -f "$IDENTITY_FILE" ] && [ -r "$IDENTITY_FILE" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" automation_identity_unreadable

age_keygen_bin="$(backup_verify_age_keygen "$POLICY_FILE")"
automation_recipient="$($age_keygen_bin -y "$IDENTITY_FILE" 2>/dev/null)" ||
  backup_die "$BACKUP_EXIT_CONFIG" automation_identity_invalid
automation_count="$(awk -v wanted="$automation_recipient" \
  '$0 == wanted {count++} END {print count+0}' "$RECIPIENTS_FILE")"
[ "$automation_count" = 1 ] ||
  backup_die "$BACKUP_EXIT_CONFIG" automation_recipient_count_invalid
offline_recipient="$(awk -v automation="$automation_recipient" \
  '/^[[:space:]]*($|#)/ {next} $0 != automation {print}' "$RECIPIENTS_FILE")"
[ -n "$offline_recipient" ] &&
  [ "$(printf '%s\n' "$offline_recipient" | wc -l | tr -d ' ')" = 1 ] ||
  backup_die "$BACKUP_EXIT_CONFIG" offline_recipient_ambiguous

temporary="$ATTESTATION_ROOT/.identity-preflight.tmp.$$"
jq -n --arg set_id "$(backup_read_config "$POLICY_FILE" RECIPIENT_SET_ID)" \
  --argjson epoch "$(backup_read_config "$POLICY_FILE" RECIPIENT_EPOCH)" \
  --arg automation_sha "$(printf '%s' "$automation_recipient" | backup_sha256_text)" \
  --arg offline_sha "$(printf '%s' "$offline_recipient" | backup_sha256_text)" \
  '{schema_version:1,recipient_set_id:$set_id,recipient_epoch:$epoch,
    automation_recipient_sha256:$automation_sha,
    offline_recipient_sha256:$offline_sha,
    identity_access_via_loadcredential:true,checked_at:(now|todateiso8601)}' \
  >"$temporary"
chmod 0600 "$temporary"
mv -- "$temporary" "$ATTESTATION_ROOT/identity-preflight.json"
backup_log info identity_preflight_passed
