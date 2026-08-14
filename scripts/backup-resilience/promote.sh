#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

STATE_ROOT="$(backup_path STARTAP_BACKUP_STATE_ROOT /var/lib/startap-backup)"
SEALED_ROOT="$STATE_ROOT/sealed"
GENERATIONS_ROOT="$STATE_ROOT/generations"
ATTESTATION_ROOT="$(backup_path STARTAP_BACKUP_ATTESTATION_ROOT /var/lib/startap-backup-attestations)"
PENDING_FILE="$STATE_ROOT/pending-run"

if ! backup_is_test; then
  [ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" promoter_requires_root
  backup_require_directory "$GENERATIONS_ROOT" root:startap-backup-readers 750
  backup_require_directory "$ATTESTATION_ROOT" \
    startap-backup-validator:startap-backup-validator 700
  backup_require_regular_file "$PENDING_FILE" root:startap-backup-validator 640
else
  [ ! -L "$PENDING_FILE" ] && [ -f "$PENDING_FILE" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" pending_marker_missing
fi
[ "$(wc -l <"$PENDING_FILE" | tr -d ' ')" = 1 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" pending_marker_shape_invalid
run_id="$(sed -n '1p' "$PENDING_FILE")"
backup_validate_run_id "$run_id"
sealed="$SEALED_ROOT/$run_id"
temporary="$GENERATIONS_ROOT/.${run_id}.tmp"
final="$GENERATIONS_ROOT/$run_id"
attestation="$ATTESTATION_ROOT/${run_id}.json"

if [ -d "$final" ]; then
  [ ! -e "$temporary" ] || backup_die "$BACKUP_EXIT_INTEGRITY" generation_temporary_conflict
  backup_validate_cipher_generation "$final" complete root:startap-backup-readers 550 440
else
  if [ ! -d "$temporary" ]; then
    backup_validate_cipher_generation "$sealed" sealed root:startap-backup-validator 550 440
    [ "$(backup_device_id "$sealed")" = "$(backup_device_id "$GENERATIONS_ROOT")" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" promotion_cross_filesystem_refused
    [ ! -e "$temporary" ] || backup_die "$BACKUP_EXIT_INTEGRITY" generation_temporary_conflict
    # Test filesystem permissions differ from root's rename privilege only.
    if backup_is_test; then chmod 0700 "$sealed"; fi
    mv -- "$sealed" "$temporary"
    [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != promote_after_sealed_claim ] ||
      backup_die "$BACKUP_EXIT_TRANSIENT" promotion_interrupted_after_sealed_claim
  fi

  manifest="$temporary/manifest.json"
  artifact="$(backup_manifest_field "$manifest" artifact)"
  manifest_sha="$(backup_sha256 "$manifest")"
  artifact_sha="$(backup_sha256 "$temporary/$artifact")"
  safe_partial_file() {
    local path="$1"
    [ ! -L "$path" ] && [ -f "$path" ] && [ "$(backup_stat_links "$path")" = 1 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" promotion_partial_file_unsafe
  }
  normalize_validated_temporary() {
    local entry name expected_sha expected_size
    local -a allowed=(manifest.json SHA256SUMS PREPARED SEALED VALIDATED "$artifact")
    while IFS= read -r -d '' entry; do
      name="${entry##*/}"
      backup_array_contains_exact "$name" "${allowed[@]}" ||
        backup_die "$BACKUP_EXIT_UNSAFE" promotion_partial_extra_entry_refused
      safe_partial_file "$entry"
    done < <(find "$temporary" -mindepth 1 -maxdepth 1 -print0)
    for name in "${allowed[@]}"; do [ -f "$temporary/$name" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" generation_required_entry_missing; done
    backup_manifest_validate_shape "$manifest"
    expected_sha="$(backup_manifest_field "$manifest" sha256)"
    expected_size="$(backup_manifest_field "$manifest" size_bytes)"
    [ "$(backup_sha256 "$temporary/$artifact")" = "$expected_sha" ] &&
      [ "$(backup_file_size "$temporary/$artifact")" = "$expected_size" ] &&
      [ "$(sed -n '1p' "$temporary/PREPARED")" = "$expected_sha" ] &&
      [ "$(sed -n '1p' "$temporary/SEALED")" = "$manifest_sha" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" promotion_partial_tuple_mismatch
    jq -e --arg run_id "$run_id" --arg manifest_sha "$manifest_sha" \
      --arg artifact_sha "$expected_sha" '
        .schema_version == 1 and .run_id == $run_id and
        .manifest_sha256 == $manifest_sha and .artifact_sha256 == $artifact_sha and
        .method == "age-decrypt+gzip-test+pgdump-markers"
      ' "$temporary/VALIDATED" >/dev/null ||
      backup_die "$BACKUP_EXIT_INTEGRITY" validation_attestation_mismatch
    chmod 0750 "$temporary"
    if ! backup_is_test; then chown -R root:startap-backup-readers "$temporary"; fi
    find "$temporary" -mindepth 1 -maxdepth 1 -type f -exec chmod 0440 {} +
    chmod 0550 "$temporary"
    backup_validate_cipher_generation "$temporary" validated root:startap-backup-readers 550 440
  }
  normalize_complete_temporary() {
    local entry name expected_sha expected_size
    local -a allowed=(manifest.json SHA256SUMS PREPARED SEALED VALIDATED COMPLETE "$artifact")
    while IFS= read -r -d '' entry; do
      name="${entry##*/}"
      backup_array_contains_exact "$name" "${allowed[@]}" ||
        backup_die "$BACKUP_EXIT_UNSAFE" promotion_partial_extra_entry_refused
      safe_partial_file "$entry"
    done < <(find "$temporary" -mindepth 1 -maxdepth 1 -print0)
    for name in "${allowed[@]}"; do [ -f "$temporary/$name" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" generation_required_entry_missing; done
    backup_manifest_validate_shape "$manifest"
    expected_sha="$(backup_manifest_field "$manifest" sha256)"
    expected_size="$(backup_manifest_field "$manifest" size_bytes)"
    [ "$(backup_sha256 "$temporary/$artifact")" = "$expected_sha" ] &&
      [ "$(backup_file_size "$temporary/$artifact")" = "$expected_size" ] &&
      [ "$(sed -n '1p' "$temporary/PREPARED")" = "$expected_sha" ] &&
      [ "$(sed -n '1p' "$temporary/SEALED")" = "$manifest_sha" ] &&
      [ "$(sed -n '1p' "$temporary/COMPLETE")" = "$expected_sha" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" promotion_partial_tuple_mismatch
    jq -e --arg run_id "$run_id" --arg manifest_sha "$manifest_sha" \
      --arg artifact_sha "$expected_sha" '
        .schema_version == 1 and .run_id == $run_id and
        .manifest_sha256 == $manifest_sha and .artifact_sha256 == $artifact_sha and
        .method == "age-decrypt+gzip-test+pgdump-markers"
      ' "$temporary/VALIDATED" >/dev/null ||
      backup_die "$BACKUP_EXIT_INTEGRITY" validation_attestation_mismatch
    chmod 0750 "$temporary"
    if ! backup_is_test; then chown -R root:startap-backup-readers "$temporary"; fi
    find "$temporary" -mindepth 1 -maxdepth 1 -type f -exec chmod 0440 {} +
    chmod 0550 "$temporary"
    backup_validate_cipher_generation "$temporary" complete root:startap-backup-readers 550 440
  }
  if [ -f "$temporary/COMPLETE" ]; then
    normalize_complete_temporary
  else
    # A killed marker write is not a generation entry and is safely
    # reconstructed only after checking it is a single regular file.
    if [ -e "$temporary/.COMPLETE.tmp" ] || [ -L "$temporary/.COMPLETE.tmp" ]; then
      safe_partial_file "$temporary/.COMPLETE.tmp"
      if backup_is_test; then chmod 0750 "$temporary"; fi
      rm -f -- "$temporary/.COMPLETE.tmp"
    fi
    if [ -e "$temporary/.VALIDATED.tmp" ] || [ -L "$temporary/.VALIDATED.tmp" ]; then
      safe_partial_file "$temporary/.VALIDATED.tmp"
      if backup_is_test; then chmod 0750 "$temporary"; fi
      rm -f -- "$temporary/.VALIDATED.tmp"
    fi
    if [ -f "$temporary/VALIDATED" ]; then
      normalize_validated_temporary
    else
      backup_validate_cipher_generation "$temporary" sealed root:startap-backup-validator 550 440
      [ ! -L "$attestation" ] && [ -f "$attestation" ] &&
        [ "$(backup_stat_links "$attestation")" = 1 ] ||
        backup_die "$BACKUP_EXIT_UNSAFE" validation_attestation_unsafe
      if ! backup_is_test; then
        [ "$(backup_stat_identity_mode "$attestation")" = \
          startap-backup-validator:startap-backup-validator:600 ] ||
          backup_die "$BACKUP_EXIT_UNSAFE" validation_attestation_metadata_invalid
      fi
      jq -e --arg run_id "$run_id" --arg manifest_sha "$manifest_sha" \
        --arg artifact_sha "$artifact_sha" '
          .schema_version == 1 and .run_id == $run_id and
          .manifest_sha256 == $manifest_sha and .artifact_sha256 == $artifact_sha and
          .method == "age-decrypt+gzip-test+pgdump-markers"
        ' "$attestation" >/dev/null ||
        backup_die "$BACKUP_EXIT_INTEGRITY" validation_attestation_mismatch
      chmod 0700 "$temporary"
      cp -- "$attestation" "$temporary/.VALIDATED.tmp"
      chmod 0600 "$temporary/.VALIDATED.tmp"
      mv -- "$temporary/.VALIDATED.tmp" "$temporary/VALIDATED"
      [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != promote_after_validated ] ||
        backup_die "$BACKUP_EXIT_TRANSIENT" promotion_interrupted_after_validated
      [ "$(backup_sha256 "$temporary/$artifact")" = \
        "$(backup_manifest_field "$manifest" sha256)" ] ||
        backup_die "$BACKUP_EXIT_INTEGRITY" prepromotion_checksum_mismatch
      [ "$(backup_sha256 "$manifest")" = "$manifest_sha" ] ||
        backup_die "$BACKUP_EXIT_INTEGRITY" prepromotion_manifest_mutated
      normalize_validated_temporary
    fi

    chmod 0750 "$temporary"
    printf '%s\n' "$(backup_manifest_field "$manifest" sha256)" >"$temporary/.COMPLETE.tmp"
    chmod 0440 "$temporary/.COMPLETE.tmp"
    if ! backup_is_test; then chown root:startap-backup-readers "$temporary/.COMPLETE.tmp"; fi
    [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != promote_after_complete_temp ] ||
      backup_die "$BACKUP_EXIT_TRANSIENT" promotion_interrupted_after_complete_temp
    mv -- "$temporary/.COMPLETE.tmp" "$temporary/COMPLETE"
    chmod 0550 "$temporary"
    backup_validate_cipher_generation "$temporary" complete root:startap-backup-readers 550 440
    [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != promote_after_complete_marker ] ||
      backup_die "$BACKUP_EXIT_TRANSIENT" promotion_interrupted_after_complete_marker
  fi

  [ ! -e "$final" ] || backup_die "$BACKUP_EXIT_INTEGRITY" final_name_conflict
  mv -- "$temporary" "$final"
  [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != promote_after_final_publish ] ||
    backup_die "$BACKUP_EXIT_TRANSIENT" promotion_interrupted_after_final_publish
  backup_validate_cipher_generation "$final" complete root:startap-backup-readers 550 440
fi

backup_atomic_replace_text "$STATE_ROOT/latest-promoted" "$run_id"
chmod 0600 "$STATE_ROOT/latest-promoted"
[ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" != promote_after_latest ] ||
  backup_die "$BACKUP_EXIT_TRANSIENT" promotion_interrupted_after_latest
rm -f -- "$PENDING_FILE"
backup_log info fallback_promoted "run_id=$run_id" \
  "size_bytes=$(backup_manifest_field "$final/manifest.json" size_bytes)"
