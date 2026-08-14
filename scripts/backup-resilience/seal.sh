#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

STATE_ROOT="$(backup_path STARTAP_BACKUP_STATE_ROOT /var/lib/startap-backup)"
RUN_ROOT="$(backup_path STARTAP_BACKUP_RUN_ROOT /run/startap-backup-producer)"
BRIDGE_ROOT="$(backup_path STARTAP_BACKUP_BRIDGE_ROOT /run/startap-backup-bridge/producer)"
INCOMING_ROOT="$STATE_ROOT/incoming"
SEALED_ROOT="$STATE_ROOT/sealed"
GENERATIONS_ROOT="$STATE_ROOT/generations"
READY_FILE="$BRIDGE_ROOT/ready-run"
PENDING_FILE="$STATE_ROOT/pending-run"
PENDING_TMP="$STATE_ROOT/.pending-run.tmp"

if ! backup_is_test; then
  [ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" seal_requires_root
  backup_require_directory "$STATE_ROOT" root:root 711
  backup_require_directory "$INCOMING_ROOT" startap-backup-producer:startap-backup-producer 700
  backup_require_directory "$SEALED_ROOT" root:startap-backup-validator 750
  backup_require_directory "$GENERATIONS_ROOT" root:startap-backup-readers 750
  backup_require_directory "$BRIDGE_ROOT" startap-backup-producer:startap-backup-bridge 750
  backup_require_regular_file "$READY_FILE" startap-backup-producer:startap-backup-bridge 640
else
  [ ! -L "$READY_FILE" ] && [ -f "$READY_FILE" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" incoming_ready_missing
fi
[ "$(wc -l <"$READY_FILE" | tr -d ' ')" = 1 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" incoming_ready_shape_invalid
run_id="$(sed -n '1p' "$READY_FILE")"
backup_validate_run_id "$run_id"
incoming="$INCOMING_ROOT/${run_id}.incoming"
staging="$SEALED_ROOT/.${run_id}.sealing"
sealed="$SEALED_ROOT/$run_id"
generation="$GENERATIONS_ROOT/$run_id"

marker_matches() {
  local path="$1"
  [ ! -L "$path" ] && [ -f "$path" ] &&
    [ "$(backup_stat_links "$path")" = 1 ] &&
    [ "$(wc -l <"$path" | tr -d ' ')" = 1 ] &&
    [ "$(sed -n '1p' "$path")" = "$run_id" ]
}

if [ -f "$generation/COMPLETE" ]; then
  backup_validate_cipher_generation "$generation" complete root:startap-backup-readers 550 440
  if [ -e "$PENDING_FILE" ]; then marker_matches "$PENDING_FILE" ||
    backup_die "$BACKUP_EXIT_INTEGRITY" pending_marker_conflict; fi
  rm -f -- "$READY_FILE"
  backup_log info seal_idempotent "run_id=$run_id"
  exit 0
fi
[ ! -e "$generation" ] || backup_die "$BACKUP_EXIT_INTEGRITY" generation_name_conflict

if [ -d "$sealed" ]; then
  [ ! -e "$staging" ] || backup_die "$BACKUP_EXIT_INTEGRITY" seal_staging_conflict
  backup_validate_cipher_generation "$sealed" sealed root:startap-backup-validator 550 440
else
  if [ ! -d "$staging" ]; then
    [ -d "$incoming" ] || backup_die "$BACKUP_EXIT_INTEGRITY" incoming_generation_missing
    backup_validate_cipher_generation "$incoming" incoming \
      startap-backup-producer:startap-backup-producer 700 600
    [ "$(backup_manifest_field "$incoming/manifest.json" run_id)" = "$run_id" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" incoming_manifest_run_mismatch
    [ "$(backup_device_id "$incoming")" = "$(backup_device_id "$SEALED_ROOT")" ] &&
      [ "$(backup_device_id "$SEALED_ROOT")" = "$(backup_device_id "$GENERATIONS_ROOT")" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" seal_cross_filesystem_refused
    mv -- "$incoming" "$staging"
    [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != seal_after_incoming_claim ] ||
      backup_die "$BACKUP_EXIT_TRANSIENT" seal_interrupted_after_incoming_claim
  fi

  # Hidden root-only staging is never consumed.  Recovery first checks that no
  # attacker-controlled link or extra entry survived the atomic claim, then
  # deterministically reapplies owner/modes and the fixed marker.
  [ ! -L "$staging" ] && [ -d "$staging" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" seal_staging_invalid
  if ! backup_is_test; then
    case "$(backup_stat_identity_mode "$staging")" in
      startap-backup-producer:startap-backup-producer:700|\
      root:startap-backup-validator:700|root:startap-backup-validator:550) ;;
      *) backup_die "$BACKUP_EXIT_UNSAFE" seal_staging_metadata_invalid ;;
    esac
  fi
  safe_staging_file() {
    local path="$1" metadata
    [ ! -L "$path" ] && [ -f "$path" ] && [ "$(backup_stat_links "$path")" = 1 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" seal_staging_file_unsafe
    if ! backup_is_test; then
      metadata="$(backup_stat_identity_mode "$path")"
      case "$metadata" in
        startap-backup-producer:startap-backup-producer:600|\
        root:startap-backup-validator:600|root:startap-backup-validator:440|root:root:600) ;;
        *) backup_die "$BACKUP_EXIT_UNSAFE" seal_staging_file_metadata_invalid ;;
      esac
    fi
  }
  manifest="$staging/manifest.json"
  safe_staging_file "$manifest"
  backup_manifest_validate_shape "$manifest"
  artifact="$(backup_manifest_field "$manifest" artifact)"
  allowed=(manifest.json SHA256SUMS PREPARED SEALED .SEALED.tmp "$artifact")
  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    backup_array_contains_exact "$name" "${allowed[@]}" ||
      backup_die "$BACKUP_EXIT_UNSAFE" seal_staging_extra_entry_refused
    safe_staging_file "$entry"
  done < <(find "$staging" -mindepth 1 -maxdepth 1 -print0)
  for name in manifest.json SHA256SUMS PREPARED "$artifact"; do
    [ -f "$staging/$name" ] || backup_die "$BACKUP_EXIT_INTEGRITY" generation_required_entry_missing
  done

  chmod 0700 "$staging"
  find "$staging" -mindepth 1 -maxdepth 1 -type f -exec chmod 0600 {} +
  if ! backup_is_test; then chown -R root:startap-backup-validator "$staging"; fi
  manifest_sha="$(backup_sha256 "$manifest")"
  if [ -f "$staging/SEALED" ]; then
    [ "$(sed -n '1p' "$staging/SEALED")" = "$manifest_sha" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" sealed_marker_mismatch
    rm -f -- "$staging/.SEALED.tmp"
  else
    if [ -e "$staging/.SEALED.tmp" ] || [ -L "$staging/.SEALED.tmp" ]; then
      safe_staging_file "$staging/.SEALED.tmp"
      rm -f -- "$staging/.SEALED.tmp"
    fi
    printf '%s\n' "$manifest_sha" >"$staging/.SEALED.tmp"
    chmod 0600 "$staging/.SEALED.tmp"
    if ! backup_is_test; then chown root:startap-backup-validator "$staging/.SEALED.tmp"; fi
    [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != seal_after_marker_temp ] ||
      backup_die "$BACKUP_EXIT_TRANSIENT" seal_interrupted_after_marker_temp
    mv -- "$staging/.SEALED.tmp" "$staging/SEALED"
  fi
  find "$staging" -mindepth 1 -maxdepth 1 -type f -exec chmod 0440 {} +
  chmod 0550 "$staging"
  backup_validate_cipher_generation "$staging" sealed root:startap-backup-validator 550 440
  [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != seal_after_staging_complete ] ||
    backup_die "$BACKUP_EXIT_TRANSIENT" seal_interrupted_after_staging_complete
  [ ! -e "$sealed" ] || backup_die "$BACKUP_EXIT_INTEGRITY" sealed_name_conflict
  mv -- "$staging" "$sealed"
  [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != seal_after_publish ] ||
    backup_die "$BACKUP_EXIT_TRANSIENT" seal_interrupted_after_publish
  backup_validate_cipher_generation "$sealed" sealed root:startap-backup-validator 550 440
fi

if [ -e "$PENDING_FILE" ]; then
  marker_matches "$PENDING_FILE" || backup_die "$BACKUP_EXIT_INTEGRITY" pending_marker_conflict
else
  if [ -e "$PENDING_TMP" ] || [ -L "$PENDING_TMP" ]; then
    [ ! -L "$PENDING_TMP" ] && [ -f "$PENDING_TMP" ] &&
      [ "$(backup_stat_links "$PENDING_TMP")" = 1 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" pending_marker_temp_unsafe
    if ! backup_is_test; then
      case "$(backup_stat_identity_mode "$PENDING_TMP")" in
        root:root:640|root:startap-backup-validator:640) ;;
        *) backup_die "$BACKUP_EXIT_UNSAFE" pending_marker_temp_metadata_invalid ;;
      esac
    fi
    rm -f -- "$PENDING_TMP"
  fi
  printf '%s\n' "$run_id" >"$PENDING_TMP"
  chmod 0640 "$PENDING_TMP"
  if ! backup_is_test; then chown root:startap-backup-validator "$PENDING_TMP"; fi
  [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != seal_after_pending_temp ] ||
    backup_die "$BACKUP_EXIT_TRANSIENT" seal_interrupted_after_pending_temp
  mv -- "$PENDING_TMP" "$PENDING_FILE"
fi
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != seal_after_pending_publish ] ||
  backup_die "$BACKUP_EXIT_TRANSIENT" seal_interrupted_after_pending_publish
rm -f -- "$READY_FILE"
backup_log info generation_sealed "run_id=$run_id"
