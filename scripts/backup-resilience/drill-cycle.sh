#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

LOCK_ROOT="$(backup_path STARTAP_BACKUP_LOCK_ROOT /run/startap-backup-orchestrator)"
cleanup() {
  local code=$?
  local cleanup_exit=0
  set +e
  if backup_is_test; then
    "$SCRIPT_DIR/drill-cleanup.sh" >/dev/null 2>&1 || cleanup_exit=$?
  else
    systemctl stop startap-backup-drill-prepare.service >/dev/null 2>&1 || cleanup_exit=$?
    if [ -e /run/startap-backup-drill/pending-run ] || [ -L /run/startap-backup-drill/pending-run ]; then
      /usr/local/libexec/startap-backup/drill-cleanup.sh >/dev/null 2>&1 || cleanup_exit=$?
    fi
  fi
  backup_release_lock
  trap - EXIT INT TERM HUP
  if [ "$cleanup_exit" -ne 0 ]; then
    backup_log error drill_plaintext_cleanup_failed >&2
    [ "$code" -ne 0 ] || code="$BACKUP_EXIT_INTEGRITY"
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
backup_acquire_lock "$LOCK_ROOT" drill

if backup_is_test; then
  "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  "$SCRIPT_DIR/drill-prepare.sh"
  if [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" = after_drill_prepare ]; then
    backup_die "$BACKUP_EXIT_TRANSIENT" drill_interrupted_between_units
  fi
  "$SCRIPT_DIR/restore-drill.sh"
else
  systemctl start --wait startap-backup-drill-prepare.service ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_prepare_service_failed
  systemctl start --wait startap-backup-drill-restore.service ||
    backup_die "$BACKUP_EXIT_INTEGRITY" drill_restore_service_failed
fi
backup_log info drill_cycle_complete
