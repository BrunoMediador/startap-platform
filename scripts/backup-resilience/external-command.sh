#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ -n "${SSH_ORIGINAL_COMMAND:-}" ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" external_command_missing
command_name="$SSH_ORIGINAL_COMMAND"
case "$command_name" in
  status)
    status_file=/var/lib/startap-backup-status/health.json
    [ -r "$status_file" ] || backup_die "$BACKUP_EXIT_INTEGRITY" health_status_unavailable
    jq -e '.schema_version == 1 and (.generated_at | type == "string")' "$status_file" >/dev/null ||
      backup_die "$BACKUP_EXIT_INTEGRITY" health_status_invalid
    generated_epoch="$(date -u -d "$(jq -r '.generated_at' "$status_file")" +%s 2>/dev/null)" ||
      backup_die "$BACKUP_EXIT_INTEGRITY" health_timestamp_invalid
    status_age=$(( $(backup_epoch_now) - generated_epoch ))
    [ "$status_age" -ge 0 ] && [ "$status_age" -le 7200 ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" health_detector_stale "age_seconds=$status_age"
    jq -c '.' "$status_file"
    state="$(jq -r '.state' "$status_file")"
    [ "$state" = "healthy" ] && exit 0
    [ "$state" = "degraded" ] && exit 2
    exit 1
    ;;
  drill)
    # The marker is created only after GO A, a successful controlled real drill,
    # and security sign-off. Repository installation never creates it.
    [ -f /etc/startap-backup/DRILL_DISPATCH_ENABLED ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" drill_dispatch_disabled
    /usr/bin/sudo -n /usr/bin/systemctl start --wait startap-backup-drill.service
    report=/var/lib/startap-backup-status/drill.json
    jq -e '.schema_version == 1 and .status == "success" and
      .postgres_major == 16 and .production_target == false and
      .teardown_complete == true' "$report" >/dev/null ||
      backup_die "$BACKUP_EXIT_INTEGRITY" drill_report_invalid
    exec jq -c '.' "$report"
    ;;
  *)
    backup_die "$BACKUP_EXIT_UNSAFE" external_command_refused
    ;;
esac
