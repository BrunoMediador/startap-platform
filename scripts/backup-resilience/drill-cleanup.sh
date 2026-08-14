#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_arguments_refused
DRILL_ROOT="$(backup_path STARTAP_BACKUP_DRILL_ROOT /run/startap-backup-drill)"
pending="$DRILL_ROOT/pending-run"

cleanup_drill_directory() {
  local drill_dir="$1" run_id name entry entry_count=0
  run_id="${drill_dir##*/}"
  backup_validate_run_id "$run_id"
  [ "${drill_dir%/*}" = "$DRILL_ROOT" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_path_refused
  if [ -L "$drill_dir" ]; then
    rm -f -- "$drill_dir"
    backup_log warn drill_cleanup_target_symlink_removed
    return 0
  fi
  [ -d "$drill_dir" ] || backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_target_unsafe
  while IFS= read -r -d '' entry; do
    entry_count=$((entry_count + 1))
    [ "$entry_count" -le 3 ] || backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_entry_cap_exceeded
    name="${entry##*/}"
    case "$name" in dump.sql.gz|input.json|READY) ;;
      *) backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_extra_entry_refused ;;
    esac
    if [ -L "$entry" ]; then
      rm -f -- "$entry"
      backup_log warn drill_cleanup_entry_symlink_removed
      continue
    fi
    [ -f "$entry" ] && [ "$(backup_stat_links "$entry")" = 1 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_entry_unsafe
  done < <(find "$drill_dir" -mindepth 1 -maxdepth 1 -print0)
  if [ -e "$drill_dir/dump.sql.gz" ] || [ -L "$drill_dir/dump.sql.gz" ]; then
    backup_secure_unlink "$drill_dir/dump.sql.gz"
  fi
  rm -f -- "$drill_dir/input.json" "$drill_dir/READY"
  rmdir -- "$drill_dir"
  backup_log info drill_plaintext_cleanup_complete "run_id=$run_id"
}

cleanup_orphaned_runs() {
  local candidate name count=0
  for candidate in "$DRILL_ROOT"/*; do
    [ -e "$candidate" ] || [ -L "$candidate" ] || continue
    name="${candidate##*/}"
    [ "$name" = pending-run ] && continue
    count=$((count + 1))
    [ "$count" -le 4 ] || backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_run_cap_exceeded
    printf '%s' "$name" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$' ||
      backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_runtime_entry_refused
    cleanup_drill_directory "$candidate"
  done
}

if [ -L "$pending" ]; then
  rm -f -- "$pending"
  backup_log warn drill_cleanup_pending_symlink_removed
  cleanup_orphaned_runs
  exit 0
fi
if [ ! -e "$pending" ] && [ ! -L "$pending" ]; then
  cleanup_orphaned_runs
  backup_log info drill_cleanup_nothing_pending
  exit 0
fi
[ ! -L "$pending" ] && [ -f "$pending" ] && [ "$(backup_stat_links "$pending")" = 1 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_pending_unsafe
run_id="$(sed -n '1p' "$pending")"
backup_validate_run_id "$run_id"
drill_dir="$DRILL_ROOT/$run_id"
[ -e "$drill_dir" ] || [ -L "$drill_dir" ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_cleanup_target_unsafe
cleanup_drill_directory "$drill_dir"
rm -f -- "$pending"
cleanup_orphaned_runs
