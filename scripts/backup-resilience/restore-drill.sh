#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

DRILL_ROOT="$(backup_path STARTAP_BACKUP_DRILL_ROOT /run/startap-backup-drill)"
[ -e "$DRILL_ROOT/pending-run" ] || [ -L "$DRILL_ROOT/pending-run" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_pending_missing
[ ! -L "$DRILL_ROOT/pending-run" ] && [ -f "$DRILL_ROOT/pending-run" ] &&
  [ "$(backup_stat_links "$DRILL_ROOT/pending-run")" = 1 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_pending_unsafe
run_id="$(sed -n '1p' "$DRILL_ROOT/pending-run")"
backup_validate_run_id "$run_id"
drill_dir="$DRILL_ROOT/$run_id"
plain_gzip="$drill_dir/dump.sql.gz"

[ ! -L "$drill_dir/READY" ] && [ -f "$drill_dir/READY" ] &&
  [ ! -L "$drill_dir/input.json" ] && [ -f "$drill_dir/input.json" ] &&
  [ ! -L "$plain_gzip" ] && [ -f "$plain_gzip" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_input_incomplete
[ "$(sed -n '1p' "$drill_dir/READY")" = "$(backup_sha256 "$drill_dir/input.json")" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_ready_mismatch
gzip -t "$plain_gzip" || backup_die "$BACKUP_EXIT_INTEGRITY" drill_input_corrupt

if backup_is_test; then
  helper="${STARTAP_BACKUP_TEST_DOCKER_HELPER:-$SCRIPT_DIR/docker-helper.sh}"
  "$helper" drill
else
  [ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" restore_service_requires_root
  /usr/local/libexec/startap-backup/docker-helper.sh drill
fi
backup_log info restore_drill_complete "run_id=$run_id"
