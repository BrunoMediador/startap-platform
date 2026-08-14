#!/usr/bin/env bash
# Durable, root-only recovery journal for disposable Docker drill resources.
# The caller must source common.sh and define SCRIPT_DIR.

JOURNAL_ROOT="$(backup_path STARTAP_BACKUP_DRILL_JOURNAL_ROOT /var/lib/startap-backup/drill-journal)"
JOURNAL_STATE="$JOURNAL_ROOT/docker-reconcile.json"
JOURNAL_TEMP="$JOURNAL_ROOT/.docker-reconcile.tmp"
JOURNAL_FSYNC_HELPER="$SCRIPT_DIR/journal-fsync.py"

backup_journal_phase_valid() {
  case "$1" in
    armed|network-created|volume-created|container-created|restore-complete|\
teardown-started|container-absent|volume-absent|network-absent|teardown-complete) return 0 ;;
    *) return 1 ;;
  esac
}

backup_journal_init() {
  backup_require_absolute_path "$JOURNAL_ROOT"
  if backup_is_test; then
    mkdir -p -- "$JOURNAL_ROOT"
    chmod 0700 "$JOURNAL_ROOT"
    [ -x "$JOURNAL_FSYNC_HELPER" ] ||
      backup_die "$BACKUP_EXIT_CONFIG" drill_journal_fsync_helper_missing
  else
    [ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" drill_journal_requires_root
    backup_require_directory "$JOURNAL_ROOT" root:root 700
    backup_require_regular_file "$JOURNAL_FSYNC_HELPER" root:root 755
    backup_require_trusted_parent_chain "$JOURNAL_FSYNC_HELPER"
  fi
}

backup_journal_fsync_file_and_directory() {
  "$JOURNAL_FSYNC_HELPER" file-and-directory "$1" >/dev/null 2>&1 ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_journal_fsync_failed
}

backup_journal_fsync_directory() {
  "$JOURNAL_FSYNC_HELPER" directory "$JOURNAL_ROOT" >/dev/null 2>&1 ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_journal_directory_fsync_failed
}

backup_journal_require_safe_file() {
  local file="$1" event="$2"
  [ ! -L "$file" ] && [ -f "$file" ] && [ "$(backup_stat_links "$file")" = 1 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" "$event"
  if ! backup_is_test; then
    [ "$(backup_stat_identity_mode "$file")" = root:root:600 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" "$event"
  fi
}

backup_journal_remove_link_no_follow() {
  local link="$1" event="$2"
  [ -L "$link" ] || return 1
  rm -f -- "$link" || backup_die "$BACKUP_EXIT_INTEGRITY" "$event"
  backup_journal_fsync_directory
  backup_log warn "$event"
}

backup_journal_recover_temporary() {
  if [ -L "$JOURNAL_TEMP" ]; then
    backup_journal_remove_link_no_follow "$JOURNAL_TEMP" drill_journal_temp_symlink_removed
  elif [ -e "$JOURNAL_TEMP" ]; then
    backup_journal_require_safe_file "$JOURNAL_TEMP" drill_journal_temp_unsafe
    rm -f -- "$JOURNAL_TEMP"
    backup_journal_fsync_directory
    backup_log warn drill_journal_incomplete_update_removed
  fi
}

backup_journal_recover_state_link() {
  if [ -L "$JOURNAL_STATE" ]; then
    backup_journal_remove_link_no_follow "$JOURNAL_STATE" drill_journal_state_symlink_removed
  fi
}

backup_journal_validate_shape() {
  local file="$1"
  backup_journal_require_safe_file "$file" drill_journal_state_unsafe
  jq -e '.schema_version == 2 and
    (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$")) and
    (.container | test("^startap-backup-drill-[a-f0-9]{8}$")) and
    (.volume | test("^startap-backup-drill-[a-f0-9]{8}-data$")) and
    (.network | test("^startap-backup-drill-[a-f0-9]{8}-net$")) and
    .label_key == "tech.startap.backup-drill" and
    (.phase | IN("armed","network-created","volume-created","container-created",
      "restore-complete","teardown-started","container-absent","volume-absent",
      "network-absent","teardown-complete"))' "$file" >/dev/null ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_journal_state_invalid
}

backup_journal_write() {
  local phase="$1" run="$2" container_name="$3" volume_name="$4" network_name="$5"
  backup_journal_phase_valid "$phase" ||
    backup_die "$BACKUP_EXIT_CONFIG" drill_journal_phase_invalid
  backup_validate_run_id "$run"
  [ ! -e "$JOURNAL_TEMP" ] && [ ! -L "$JOURNAL_TEMP" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_journal_temp_conflict
  if [ -e "$JOURNAL_STATE" ] || [ -L "$JOURNAL_STATE" ]; then
    backup_journal_validate_shape "$JOURNAL_STATE"
    [ "$(jq -r '.run_id' "$JOURNAL_STATE")" = "$run" ] &&
      [ "$(jq -r '.container' "$JOURNAL_STATE")" = "$container_name" ] &&
      [ "$(jq -r '.volume' "$JOURNAL_STATE")" = "$volume_name" ] &&
      [ "$(jq -r '.network' "$JOURNAL_STATE")" = "$network_name" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" drill_journal_tuple_changed
  else
    [ "$phase" = armed ] || backup_die "$BACKUP_EXIT_INTEGRITY" drill_journal_initial_phase_invalid
  fi
  (umask 077; set -C
    jq -n --arg run_id "$run" --arg container "$container_name" \
      --arg volume "$volume_name" --arg network "$network_name" --arg phase "$phase" \
      '{schema_version:2,run_id:$run_id,container:$container,volume:$volume,
        network:$network,label_key:"tech.startap.backup-drill",phase:$phase}' >"$JOURNAL_TEMP") ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_journal_temp_create_failed
  chmod 0600 "$JOURNAL_TEMP"
  if ! backup_is_test; then chown root:root "$JOURNAL_TEMP"; fi
  backup_journal_require_safe_file "$JOURNAL_TEMP" drill_journal_temp_unsafe
  [ "$(backup_device_id "$JOURNAL_TEMP")" = "$(backup_device_id "$JOURNAL_ROOT")" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" drill_journal_cross_filesystem
  mv -- "$JOURNAL_TEMP" "$JOURNAL_STATE"
  backup_journal_fsync_file_and_directory "$JOURNAL_STATE"
}

backup_journal_remove() {
  [ -e "$JOURNAL_STATE" ] || [ -L "$JOURNAL_STATE" ] || return 0
  backup_journal_validate_shape "$JOURNAL_STATE"
  rm -f -- "$JOURNAL_STATE"
  backup_journal_fsync_directory
}
