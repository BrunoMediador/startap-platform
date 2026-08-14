#!/usr/bin/env bash

# Shared fail-closed helpers for SCRUM-167. Every caller enables strict mode too,
# but keeping it here protects scripts that source this file first.
set -Eeuo pipefail
umask 077
if [ "${STARTAP_BACKUP_TEST_MODE:-0}" != 1 ]; then
  readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
fi

readonly BACKUP_EXIT_CONFIG=64
readonly BACKUP_EXIT_INTEGRITY=65
readonly BACKUP_EXIT_UNSAFE=66
readonly BACKUP_EXIT_TRANSIENT=75
readonly BACKUP_EXIT_AUTH=77

backup_log() {
  local level="$1"
  local event="$2"
  shift 2
  # Values passed here must already be sanitized. Never pass command output,
  # environment values, SQL, host keys, recipients or credential paths.
  printf 'backup level=%s event=%s' "$level" "$event"
  if [ "$#" -gt 0 ]; then
    printf ' %s' "$@"
  fi
  printf '\n'
}

backup_die() {
  local code="$1"
  local event="$2"
  shift 2
  backup_log error "$event" "$@" >&2
  exit "$code"
}

backup_is_test() {
  [ "${STARTAP_BACKUP_TEST_MODE:-0}" = "1" ]
}

backup_require_test_override() {
  local name="$1"
  if ! backup_is_test; then
    backup_die "$BACKUP_EXIT_UNSAFE" test_override_refused "field=$name"
  fi
}

backup_path() {
  local variable="$1"
  local production_default="$2"
  local value="${!variable:-}"
  if [ -n "$value" ]; then
    backup_require_test_override "$variable"
    printf '%s\n' "$value"
  else
    printf '%s\n' "$production_default"
  fi
}

backup_stat_identity_mode() {
  local path="$1"
  if stat -c '%U:%G:%a' "$path" >/dev/null 2>&1; then
    stat -c '%U:%G:%a' "$path"
  else
    stat -f '%Su:%Sg:%Lp' "$path"
  fi
}

backup_stat_links() {
  local path="$1"
  if stat -c '%h' "$path" >/dev/null 2>&1; then
    stat -c '%h' "$path"
  else
    stat -f '%l' "$path"
  fi
}

backup_device_id() {
  local path="$1"
  if stat -c '%d' "$path" >/dev/null 2>&1; then
    stat -c '%d' "$path"
  else
    stat -f '%d' "$path"
  fi
}

backup_require_trusted_parent_chain() {
  local path="$1"
  local current mode
  backup_is_test && return 0
  current="$(dirname -- "$path")"
  while [ "$current" != "/" ]; do
    [ ! -L "$current" ] && [ -d "$current" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" trusted_parent_invalid
    [ "$(stat -c '%U' "$current")" = root ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" trusted_parent_owner_invalid
    # No group/world writer may replace a trusted policy, marker or binary.
    mode="$(stat -c '%a' "$current")"
    [ $((8#$mode & 0022)) -eq 0 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" trusted_parent_writable
    current="$(dirname -- "$current")"
  done
}

backup_require_regular_file() {
  local path="$1"
  local owner_group="$2"
  local mode="$3"
  [ ! -L "$path" ] && [ -f "$path" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" trusted_file_invalid
  [ "$(backup_stat_links "$path")" = 1 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" trusted_file_hardlink_refused
  if ! backup_is_test; then
    [ "$(backup_stat_identity_mode "$path")" = "$owner_group:$mode" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" trusted_file_metadata_invalid
  fi
}

backup_require_directory() {
  local path="$1"
  local owner_group="$2"
  local mode="$3"
  [ ! -L "$path" ] && [ -d "$path" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" trusted_directory_invalid
  if ! backup_is_test; then
    [ "$(backup_stat_identity_mode "$path")" = "$owner_group:$mode" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" trusted_directory_metadata_invalid
  fi
}

backup_verify_policy_file() {
  local policy_file="$1"
  if ! backup_is_test; then
    [ "$policy_file" = /etc/startap-backup/policy.conf ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" policy_path_invalid
    backup_require_directory /etc/startap-backup root:root 755
    backup_require_regular_file "$policy_file" root:root 644
    backup_require_trusted_parent_chain "$policy_file"
  else
    [ ! -L "$policy_file" ] && [ -f "$policy_file" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" policy_fixture_invalid
  fi
}

backup_require_absolute_path() {
  local value="$1"
  case "$value" in
    /*) ;;
    *) backup_die "$BACKUP_EXIT_UNSAFE" relative_path_refused ;;
  esac
  case "$value" in
    /|/home|/root|/opt|/var|/run|/tmp)
      backup_die "$BACKUP_EXIT_UNSAFE" broad_path_refused
      ;;
  esac
}

backup_require_command() {
  command -v "$1" >/dev/null 2>&1 ||
    backup_die "$BACKUP_EXIT_CONFIG" command_missing "command=$1"
}

backup_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

backup_sha256_text() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

backup_file_size() {
  local file="$1"
  if stat -c '%s' "$file" >/dev/null 2>&1; then
    stat -c '%s' "$file"
  else
    stat -f '%z' "$file"
  fi
}

backup_epoch_now() {
  date -u +%s
}

backup_timestamp_now() {
  date -u +%Y%m%dT%H%M%SZ
}

backup_timestamp_to_epoch() {
  local timestamp="$1"
  local compact
  compact="$(printf '%s' "$timestamp" | sed -E 's/^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z$/\1-\2-\3 \4:\5:\6 UTC/')"
  if date -u -d "$compact" +%s >/dev/null 2>&1; then
    date -u -d "$compact" +%s
  else
    date -j -u -f '%Y-%m-%d %H:%M:%S %Z' "$compact" +%s
  fi
}

backup_validate_run_id() {
  local run_id="$1"
  printf '%s' "$run_id" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$' ||
    backup_die "$BACKUP_EXIT_UNSAFE" invalid_run_id
}

backup_secure_mkdir() {
  local directory="$1"
  backup_require_absolute_path "$directory"
  mkdir -p -- "$directory"
  chmod 0700 "$directory"
}

backup_atomic_text() {
  local target="$1"
  local value="$2"
  local temporary="${target}.tmp.$$"
  printf '%s\n' "$value" >"$temporary"
  chmod 0600 "$temporary"
  if ! ln -- "$temporary" "$target" 2>/dev/null; then
    rm -f -- "$temporary"
    backup_die "$BACKUP_EXIT_INTEGRITY" atomic_target_conflict
  fi
  rm -f -- "$temporary"
}

backup_atomic_replace_text() {
  local target="$1"
  local value="$2"
  local temporary="${target}.tmp.$$"
  printf '%s\n' "$value" >"$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$target"
}

backup_read_config() {
  local file="$1"
  local key="$2"
  local value
  backup_verify_policy_file "$file"
  value="$(awk -F= -v wanted="$key" '$1 == wanted {sub(/^[^=]*=/, ""); print; found=1} END {if (!found) exit 1}' "$file")" ||
    backup_die "$BACKUP_EXIT_CONFIG" config_missing "field=$key"
  [ -n "$value" ] || backup_die "$BACKUP_EXIT_CONFIG" config_empty "field=$key"
  printf '%s\n' "$value"
}

backup_validate_opaque_id() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._-]{3,64}$' ||
    backup_die "$BACKUP_EXIT_CONFIG" opaque_id_invalid
}

backup_array_contains_exact() {
  local needle="$1" candidate
  shift
  for candidate in "$@"; do
    [ "$candidate" = "$needle" ] && return 0
  done
  return 1
}

backup_verify_age_binary() {
  local policy_file="$1"
  local age_bin expected_version expected_sha actual_version actual_sha
  age_bin="$(backup_read_config "$policy_file" AGE_BIN)"
  expected_version="$(backup_read_config "$policy_file" AGE_VERSION)"
  expected_sha="$(backup_read_config "$policy_file" AGE_BINARY_SHA256)"
  if ! backup_is_test; then
    [ "$age_bin" = /usr/local/bin/age ] ||
      backup_die "$BACKUP_EXIT_CONFIG" age_binary_path_invalid
    backup_require_regular_file "$age_bin" root:root 755
    backup_require_trusted_parent_chain "$age_bin"
  fi
  [ -x "$age_bin" ] || backup_die "$BACKUP_EXIT_CONFIG" age_binary_missing
  actual_version="$($age_bin --version 2>/dev/null | head -n 1)" ||
    backup_die "$BACKUP_EXIT_CONFIG" age_version_unreadable
  [ "$actual_version" = "$expected_version" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" age_version_mismatch
  actual_sha="$(backup_sha256 "$age_bin")"
  [ "$actual_sha" = "$expected_sha" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" age_binary_checksum_mismatch
  printf '%s\n' "$age_bin"
}

backup_verify_age_keygen() {
  local policy_file="$1"
  local keygen_bin expected_version expected_sha actual_version actual_sha
  keygen_bin="$(backup_read_config "$policy_file" AGE_KEYGEN_BIN)"
  expected_version="$(backup_read_config "$policy_file" AGE_VERSION)"
  expected_sha="$(backup_read_config "$policy_file" AGE_KEYGEN_BINARY_SHA256)"
  if ! backup_is_test; then
    [ "$keygen_bin" = /usr/local/bin/age-keygen ] ||
      backup_die "$BACKUP_EXIT_CONFIG" age_keygen_path_invalid
    backup_require_regular_file "$keygen_bin" root:root 755
    backup_require_trusted_parent_chain "$keygen_bin"
  fi
  [ -x "$keygen_bin" ] || backup_die "$BACKUP_EXIT_CONFIG" age_keygen_missing
  actual_version="$($keygen_bin --version 2>/dev/null | head -n 1)" ||
    backup_die "$BACKUP_EXIT_CONFIG" age_keygen_version_unreadable
  [ "$actual_version" = "$expected_version" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" age_keygen_version_mismatch
  actual_sha="$(backup_sha256 "$keygen_bin")"
  [ "$actual_sha" = "$expected_sha" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" age_keygen_checksum_mismatch
  printf '%s\n' "$keygen_bin"
}

backup_verify_recipients() {
  local recipients_file="$1"
  local count unique_count
  if ! backup_is_test; then
    [ "$recipients_file" = /etc/startap-backup/recipients.txt ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" recipients_path_invalid
    backup_require_regular_file "$recipients_file" root:root 644
    backup_require_trusted_parent_chain "$recipients_file"
  else
    [ ! -L "$recipients_file" ] && [ -f "$recipients_file" ] ||
      backup_die "$BACKUP_EXIT_CONFIG" recipients_missing
    [ "$(backup_stat_links "$recipients_file")" = 1 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" recipients_hardlink_refused
  fi
  count="$(awk '/^[[:space:]]*($|#)/ {next} {print}' "$recipients_file" | wc -l | tr -d ' ')"
  [ "$count" = "2" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" recipient_count_invalid "count=$count"
  awk '/^[[:space:]]*($|#)/ {next} !/^age1[023456789acdefghjklmnpqrstuvwxyz]+$/ {exit 1}' "$recipients_file" ||
    backup_die "$BACKUP_EXIT_CONFIG" recipient_format_invalid
  unique_count="$(awk '/^[[:space:]]*($|#)/ {next} {print}' "$recipients_file" | LC_ALL=C sort -u | wc -l | tr -d ' ')"
  [ "$unique_count" = 2 ] ||
    backup_die "$BACKUP_EXIT_CONFIG" duplicate_recipient_refused
}

backup_acquire_lock() {
  local lock_root="$1"
  local name="$2"
  local lock_directory="$lock_root/$name.lock"
  backup_secure_mkdir "$lock_root"
  if ! mkdir "$lock_directory" 2>/dev/null; then
    backup_die "$BACKUP_EXIT_TRANSIENT" concurrent_run_refused "lock=$name"
  fi
  chmod 0700 "$lock_directory"
  BACKUP_HELD_LOCK="$lock_directory"
}

backup_release_lock() {
  if [ -n "${BACKUP_HELD_LOCK:-}" ] && [ -d "$BACKUP_HELD_LOCK" ]; then
    rmdir -- "$BACKUP_HELD_LOCK" 2>/dev/null || true
  fi
  BACKUP_HELD_LOCK=""
}

backup_secure_unlink() {
  local file="$1"
  [ -e "$file" ] || [ -L "$file" ] || return 0
  # The only plaintext paths accepted in production are below tmpfs /run.
  case "$file" in
    /run/startap-backup/*|/run/startap-backup-*/*) ;;
    *) backup_is_test || backup_die "$BACKUP_EXIT_UNSAFE" plaintext_path_refused ;;
  esac
  if [ -L "$file" ]; then
    rm -f -- "$file"
    return 0
  fi
  chmod 0600 "$file" 2>/dev/null || true
  : >"$file" 2>/dev/null || true
  rm -f -- "$file"
}

backup_manifest_field() {
  local manifest="$1"
  local field="$2"
  jq -er --arg field "$field" '.[$field] | select(type != "null")' "$manifest" 2>/dev/null ||
    backup_die "$BACKUP_EXIT_INTEGRITY" manifest_field_invalid "field=$field"
}

backup_manifest_validate_shape() {
  local manifest="$1"
  jq -e '
    .schema_version == 1 and
    (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$")) and
    (.created_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
    (.artifact | test("^backup-[0-9]{8}T[0-9]{6}Z\\.sql\\.gz\\.age$")) and
    (.artifact == ("backup-" + .created_at + ".sql.gz.age")) and
    (.sha256 | test("^[a-f0-9]{64}$")) and
    (.size_bytes | type == "number" and . > 0) and
    (.recipient_set_id | test("^[A-Za-z0-9._-]{3,64}$")) and
    (.recipient_epoch | type == "number" and . >= 1) and
    .recipient_count == 2 and
    .postgres_major == 16
  ' "$manifest" >/dev/null 2>&1 ||
    backup_die "$BACKUP_EXIT_INTEGRITY" manifest_shape_invalid
}

backup_validate_cipher_generation() {
  local directory="$1"
  local phase="$2"
  local expected_owner_group="$3"
  local directory_mode="$4"
  local file_mode="$5"
  local manifest="$directory/manifest.json"
  local artifact expected_sha expected_size manifest_sha entry name
  local -a required

  backup_require_directory "$directory" "$expected_owner_group" "$directory_mode"
  backup_require_regular_file "$manifest" "$expected_owner_group" "$file_mode"
  backup_manifest_validate_shape "$manifest"
  artifact="$(backup_manifest_field "$manifest" artifact)"
  case "$artifact" in */*|.*) backup_die "$BACKUP_EXIT_UNSAFE" artifact_name_unsafe ;; esac

  case "$phase" in
    incoming) required=(manifest.json SHA256SUMS PREPARED "$artifact") ;;
    sealed) required=(manifest.json SHA256SUMS PREPARED SEALED "$artifact") ;;
    validated) required=(manifest.json SHA256SUMS PREPARED SEALED VALIDATED "$artifact") ;;
    complete) required=(manifest.json SHA256SUMS PREPARED SEALED VALIDATED COMPLETE "$artifact") ;;
    *) backup_die "$BACKUP_EXIT_CONFIG" generation_phase_invalid ;;
  esac

  while IFS= read -r -d '' entry; do
    name="${entry##*/}"
    backup_array_contains_exact "$name" "${required[@]}" ||
      backup_die "$BACKUP_EXIT_UNSAFE" generation_extra_entry_refused
    backup_require_regular_file "$entry" "$expected_owner_group" "$file_mode"
  done < <(find "$directory" -mindepth 1 -maxdepth 1 -print0)

  for name in "${required[@]}"; do
    [ -f "$directory/$name" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" generation_required_entry_missing
  done

  expected_sha="$(backup_manifest_field "$manifest" sha256)"
  expected_size="$(backup_manifest_field "$manifest" size_bytes)"
  [ "$(backup_sha256 "$directory/$artifact")" = "$expected_sha" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" checksum_mismatch
  [ "$(backup_file_size "$directory/$artifact")" = "$expected_size" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" size_mismatch
  [ "$(sed -n '1p' "$directory/PREPARED")" = "$expected_sha" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" prepared_marker_mismatch
  [ "$(wc -l <"$directory/SHA256SUMS" | tr -d ' ')" = 1 ] &&
    grep -Fxq "$expected_sha  $artifact" "$directory/SHA256SUMS" ||
    backup_die "$BACKUP_EXIT_INTEGRITY" checksum_manifest_mismatch

  manifest_sha="$(backup_sha256 "$manifest")"
  case "$phase" in
    sealed|validated|complete)
      [ "$(sed -n '1p' "$directory/SEALED")" = "$manifest_sha" ] ||
        backup_die "$BACKUP_EXIT_INTEGRITY" sealed_marker_mismatch
      ;;
  esac
  case "$phase" in
    validated|complete)
      jq -e --arg run_id "$(backup_manifest_field "$manifest" run_id)" \
        --arg manifest_sha "$manifest_sha" --arg artifact_sha "$expected_sha" '
          .schema_version == 1 and .run_id == $run_id and
          .manifest_sha256 == $manifest_sha and .artifact_sha256 == $artifact_sha and
          .method == "age-decrypt+gzip-test+pgdump-markers"
        ' "$directory/VALIDATED" >/dev/null 2>&1 ||
        backup_die "$BACKUP_EXIT_INTEGRITY" validation_attestation_mismatch
      ;;
  esac
  if [ "$phase" = complete ]; then
    [ "$(sed -n '1p' "$directory/COMPLETE")" = "$expected_sha" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" complete_marker_mismatch
  fi
}
