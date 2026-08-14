#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

STATUS_ROOT="$(backup_path STARTAP_BACKUP_STATUS_ROOT /var/lib/startap-backup-status)"
backup_require_absolute_path "$STATUS_ROOT"
mkdir -p -- "$STATUS_ROOT"
chmod 0755 "$STATUS_ROOT"
temporary="$STATUS_ROOT/health.json.tmp.$$"
set +e
"$SCRIPT_DIR/health.sh" >"$temporary"
health_exit=$?
set -e
chmod 0600 "$temporary"
jq -e '.schema_version == 1 and
  (.state == "healthy" or .state == "degraded" or .state == "stale" or .state == "invalid" or .state == "none") and
  (.recovery_tuple_coherent | type == "boolean") and
  (.local.last_attempt.state == "none" or .local.last_attempt.state == "running" or
   .local.last_attempt.state == "failed" or .local.last_attempt.state == "success" or
   .local.last_attempt.state == "invalid") and
  (.offsite.last_attempt.state == "none" or .offsite.last_attempt.state == "running" or
   .offsite.last_attempt.state == "failed" or .offsite.last_attempt.state == "success" or
   .offsite.last_attempt.state == "invalid") and
  .alert_delivery_affects_validity == false' "$temporary" >/dev/null || {
  rm -f -- "$temporary"
  backup_die "$BACKUP_EXIT_INTEGRITY" health_output_invalid
}
mv "$temporary" "$STATUS_ROOT/health.json"
chmod 0644 "$STATUS_ROOT/health.json"
if ! backup_is_test; then chown root:root "$STATUS_ROOT/health.json"; fi
backup_log info freshness_state_recorded "state=$(jq -r '.state' "$STATUS_ROOT/health.json")"
exit "$health_exit"
