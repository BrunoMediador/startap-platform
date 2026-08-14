#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 1 ] || backup_die "$BACKUP_EXIT_CONFIG" rollback_action_required
case "$1" in begin|complete) ;; *) backup_die "$BACKUP_EXIT_CONFIG" rollback_action_invalid ;; esac
[ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" rollback_requires_root
CONFIG_DIR=/etc/startap-backup

if [ "$1" = begin ]; then
  # Inverse cutover: remove the new offsite writer first. Local generation stays
  # active while the operator reenables and manually proves the encrypted legacy
  # workflow, so no two writers race and no recovery gap is introduced.
  systemctl disable --now startap-backup-upload.timer ||
    backup_die "$BACKUP_EXIT_TRANSIENT" rollback_uploader_disable_failed
  rm -f -- "$CONFIG_DIR/OFFSITE_WRITER_ENABLED"
  backup_log warn rollback_waiting_legacy_manual_proof \
    "artifacts_preserved=true" "local_generation_active=true"
  exit 0
fi

proof="$CONFIG_DIR/LEGACY_MANUAL_ROLLBACK_PROOF.json"
backup_require_regular_file "$proof" root:root 600
backup_require_trusted_parent_chain "$proof"
jq -e '.schema_version == 1 and .legacy_schedule_enabled == true and
  .manual_dispatch_success == true and .artifact_suffix == ".sql.gz.age" and
  (.workflow_run_id | type == "number" and . > 0)' "$proof" >/dev/null ||
  backup_die "$BACKUP_EXIT_CONFIG" legacy_manual_rollback_proof_invalid
[ ! -e "$CONFIG_DIR/OFFSITE_WRITER_ENABLED" ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" rollback_writer_still_enabled
systemctl disable --now startap-backup-producer.timer \
  startap-backup-freshness.timer startap-backup-drill.timer ||
  backup_die "$BACKUP_EXIT_TRANSIENT" rollback_shadow_disable_failed
systemctl start --wait startap-backup-drill-reconcile.service ||
  backup_die "$BACKUP_EXIT_INTEGRITY" rollback_drill_reconcile_failed
systemctl disable startap-backup-drill-reconcile.service ||
  backup_die "$BACKUP_EXIT_TRANSIENT" rollback_drill_reconciler_disable_failed
rm -f -- "$CONFIG_DIR/ENABLED" "$CONFIG_DIR/DRILL_DISPATCH_ENABLED"
backup_log info resilient_backup_rollback_complete \
  "artifacts_preserved=true" "legacy_manual_age_proven=true"
