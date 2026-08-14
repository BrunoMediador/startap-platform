#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 1 ] || backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_request_arguments_invalid
case "$1" in wait|async) mode="$1" ;; *) backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_request_mode_invalid ;; esac

BRIDGE_ROOT="$(backup_path STARTAP_BACKUP_BRIDGE_ROOT /run/startap-backup-bridge/producer)"
ACK_ROOT="$(backup_path STARTAP_BACKUP_BRIDGE_ACK_ROOT /run/startap-backup-bridge/root)"
request="$BRIDGE_ROOT/reconcile-request"
ack="$ACK_ROOT/reconcile-complete"
temporary="$BRIDGE_ROOT/.reconcile-request.tmp.$$"

if backup_is_test; then
  mkdir -p -- "$BRIDGE_ROOT" "$ACK_ROOT"
else
  [ "$(id -un)" = startap-backup-producer ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_request_identity_invalid
  backup_require_directory "$BRIDGE_ROOT" startap-backup-producer:startap-backup-bridge 750
  backup_require_directory "$ACK_ROOT" root:startap-backup-bridge 750
fi

if [ -L "$request" ]; then
  rm -f -- "$request"
  backup_log warn producer_reconcile_request_symlink_removed
fi
if [ -e "$request" ] || [ -L "$request" ]; then
  [ ! -L "$request" ] && [ -f "$request" ] && [ "$(backup_stat_links "$request")" = 1 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_request_unsafe
  token="$(sed -n '1p' "$request")"
else
  token="$(backup_timestamp_now)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  backup_validate_run_id "$token"
  printf '%s\n' "$token" >"$temporary"
  chmod 0640 "$temporary"
  if ! backup_is_test; then chgrp startap-backup-bridge "$temporary"; fi
  if ! ln -- "$temporary" "$request" 2>/dev/null; then
    rm -f -- "$temporary"
    [ ! -L "$request" ] && [ -f "$request" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_request_race_unsafe
    token="$(sed -n '1p' "$request")"
  else
    rm -f -- "$temporary"
  fi
fi
backup_validate_run_id "$token"

if [ "$mode" = async ]; then
  backup_log info producer_reconcile_requested "wait=false"
  exit 0
fi

for _ in $(seq 1 300); do
  if [ ! -L "$ack" ] && [ -f "$ack" ] && [ "$(sed -n '1p' "$ack")" = "$token" ]; then
    backup_log info producer_reconcile_acknowledged
    exit 0
  fi
  sleep 0.1
done
backup_die "$BACKUP_EXIT_TRANSIENT" producer_reconcile_timeout
