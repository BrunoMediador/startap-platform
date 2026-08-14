#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 1 ] && [ "$1" = reconcile ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" drill_reconcile_command_refused
DRILL_ROOT="$(backup_path STARTAP_BACKUP_DRILL_ROOT /run/startap-backup-drill)"
DOCKER_QUERY_ROOT="$(backup_path STARTAP_BACKUP_DOCKER_QUERY_ROOT /run/startap-backup-drill-query)"
# shellcheck source=docker-journal.sh
. "$SCRIPT_DIR/docker-journal.sh"
backup_journal_init
backup_journal_recover_temporary
backup_journal_recover_state_link

cleanup_plaintext() {
  [ -e "$DRILL_ROOT/pending-run" ] || [ -L "$DRILL_ROOT/pending-run" ] || return 0
  "$SCRIPT_DIR/drill-cleanup.sh"
}

if ! backup_is_test; then
  [ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" drill_reconcile_requires_root
  backup_require_directory "$DOCKER_QUERY_ROOT" root:root 700
else
  mkdir -p -- "$DOCKER_QUERY_ROOT"
  chmod 0700 "$DOCKER_QUERY_ROOT"
fi

if backup_is_test; then
  DOCKER_BIN="${STARTAP_BACKUP_TEST_DOCKER_BIN:-$(command -v docker || true)}"
else
  DOCKER_BIN=/usr/bin/docker
  backup_require_regular_file "$DOCKER_BIN" root:root 755
  backup_require_trusted_parent_chain "$DOCKER_BIN"
fi
[ -n "$DOCKER_BIN" ] && [ -x "$DOCKER_BIN" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" docker_binary_missing
docker() { "$DOCKER_BIN" "$@"; }
# shellcheck source=docker-inspect.sh
. "$SCRIPT_DIR/docker-inspect.sh"

if [ ! -e "$JOURNAL_STATE" ] && [ ! -L "$JOURNAL_STATE" ]; then
  backup_docker_probe_label_orphans tech.startap.backup-drill
  case "$BACKUP_DOCKER_ORPHAN_STATE" in
    absent)
      cleanup_plaintext
      backup_log info drill_reconcile_nothing_pending
      exit 0
      ;;
    present) backup_die "$BACKUP_EXIT_INTEGRITY" drill_orphans_without_journal \
      "resource_count=$BACKUP_DOCKER_ORPHAN_COUNT" ;;
    *) backup_die "$BACKUP_EXIT_INTEGRITY" drill_orphan_probe_failed ;;
  esac
fi

backup_journal_validate_shape "$JOURNAL_STATE"
run_id="$(jq -r '.run_id' "$JOURNAL_STATE")"
backup_validate_run_id "$run_id"
suffix="${run_id##*-}"
container="startap-backup-drill-${suffix}"
volume="startap-backup-drill-${suffix}-data"
network="startap-backup-drill-${suffix}-net"
label_key=tech.startap.backup-drill
[ "$(jq -r '.container' "$JOURNAL_STATE")" = "$container" ] &&
  [ "$(jq -r '.volume' "$JOURNAL_STATE")" = "$volume" ] &&
  [ "$(jq -r '.network' "$JOURNAL_STATE")" = "$network" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" drill_reconcile_name_tuple_invalid

resource_label_state() {
  local kind="$1" name="$2" format
  if [ "$kind" = container ]; then
    format="{{ index .Config.Labels \"$label_key\" }}"
  else
    format="{{ index .Labels \"$label_key\" }}"
  fi
  if ! backup_docker_inspect_value "$kind" "$name" "$format"; then
    RESOURCE_LABEL_STATE=error
  elif [ "$BACKUP_DOCKER_QUERY_VALUE" = "$run_id" ]; then
    RESOURCE_LABEL_STATE=match
  else
    RESOURCE_LABEL_STATE=mismatch
  fi
}

backup_journal_write teardown-started "$run_id" "$container" "$volume" "$network"
for tuple in "container:$container" "volume:$volume" "network:$network"; do
  kind="${tuple%%:*}"; name="${tuple#*:}"
  backup_docker_inspect_state "$kind" "$name"
  case "$BACKUP_DOCKER_INSPECT_STATE" in
    absent) ;;
    error) backup_die "$BACKUP_EXIT_INTEGRITY" "drill_reconcile_${kind}_inspect_failed" ;;
    present)
      resource_label_state "$kind" "$name"
      case "$RESOURCE_LABEL_STATE" in
        match) ;;
        mismatch) backup_die "$BACKUP_EXIT_UNSAFE" "drill_reconcile_${kind}_label_mismatch" ;;
        *) backup_die "$BACKUP_EXIT_INTEGRITY" "drill_reconcile_${kind}_inspect_failed" ;;
      esac
      ;;
  esac
done
for tuple in "container:$container" "volume:$volume" "network:$network"; do
  kind="${tuple%%:*}"; name="${tuple#*:}"
  backup_docker_inspect_state "$kind" "$name"
  if [ "$BACKUP_DOCKER_INSPECT_STATE" = present ]; then
    case "$kind" in
      container) docker rm -f "$name" >/dev/null 2>&1 ||
        backup_die "$BACKUP_EXIT_INTEGRITY" drill_reconcile_container_remove_failed ;;
      volume|network) docker "$kind" rm "$name" >/dev/null 2>&1 ||
        backup_die "$BACKUP_EXIT_INTEGRITY" "drill_reconcile_${kind}_remove_failed" ;;
    esac
  elif [ "$BACKUP_DOCKER_INSPECT_STATE" = error ]; then
    backup_die "$BACKUP_EXIT_INTEGRITY" "drill_reconcile_${kind}_inspect_failed"
  fi
  backup_docker_inspect_state "$kind" "$name"
  case "$BACKUP_DOCKER_INSPECT_STATE" in
    absent) ;;
    present) backup_die "$BACKUP_EXIT_INTEGRITY" "drill_reconcile_${kind}_remains" ;;
    error) backup_die "$BACKUP_EXIT_INTEGRITY" "drill_reconcile_${kind}_inspect_failed" ;;
  esac
  backup_journal_write "${kind}-absent" "$run_id" "$container" "$volume" "$network"
done

backup_journal_write teardown-complete "$run_id" "$container" "$volume" "$network"
backup_journal_remove
cleanup_plaintext
backup_log info drill_resources_reconciled "run_id=$run_id" "teardown_complete=true"
