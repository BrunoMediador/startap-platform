#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_arguments_refused
RUN_ROOT="$(backup_path STARTAP_BACKUP_RUN_ROOT /run/startap-backup-producer)"
BRIDGE_ROOT="$(backup_path STARTAP_BACKUP_BRIDGE_ROOT /run/startap-backup-bridge/producer)"
ACK_ROOT="$(backup_path STARTAP_BACKUP_BRIDGE_ACK_ROOT /run/startap-backup-bridge/root)"
CLAIM_ROOT="$(backup_path STARTAP_BACKUP_DUMP_CLAIM_ROOT /run/startap-backup-dump-helper)"
request="$BRIDGE_ROOT/reconcile-request"

if ! backup_is_test; then
  [ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_requires_root
  backup_require_directory "$RUN_ROOT" startap-backup-producer:startap-backup-producer 700
  backup_require_directory "$BRIDGE_ROOT" startap-backup-producer:startap-backup-bridge 750
  backup_require_directory "$ACK_ROOT" root:startap-backup-bridge 750
  backup_require_directory "$CLAIM_ROOT" root:root 700
fi
# shellcheck source=quarantine.sh
. "$SCRIPT_DIR/quarantine.sh"
backup_quarantine_init
[ -e "$request" ] || [ -L "$request" ] ||
  backup_die "$BACKUP_EXIT_TRANSIENT" producer_reconcile_request_missing

nonce="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
claim="$CLAIM_ROOT/.producer-reconcile.$$.${nonce}.claim"
[ ! -e "$claim" ] && [ ! -L "$claim" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" producer_reconcile_claim_conflict
mv -- "$request" "$claim" 2>/dev/null ||
  backup_die "$BACKUP_EXIT_TRANSIENT" producer_reconcile_claim_failed
if [ -L "$claim" ]; then
  backup_quarantine_enqueue "$claim" reconcile-link
  backup_quarantine_recover 64
  backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_claim_symlink_removed
fi
[ ! -L "$claim" ] && [ -f "$claim" ] && [ "$(backup_stat_links "$claim")" = 1 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_claim_unsafe
if ! backup_is_test; then
  [ "$(backup_stat_identity_mode "$claim")" = startap-backup-producer:startap-backup-bridge:640 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_claim_metadata_invalid
fi
[ "$(wc -l <"$claim" | tr -d ' ')" = 1 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_claim_shape_invalid
token="$(sed -n '1p' "$claim")"
backup_validate_run_id "$token"

discard_tree() {
  local target="$1"
  [ -e "$target" ] || [ -L "$target" ] || return 0
  case "$target" in
    "$RUN_ROOT"/*) ;;
    *) backup_die "$BACKUP_EXIT_UNSAFE" producer_reconcile_delete_path_refused ;;
  esac
  if [ -d "$target" ] && [ ! -L "$target" ]; then
    find "$target" -xdev -depth -delete
  else
    rm -f -- "$target"
  fi
  [ ! -e "$target" ] && [ ! -L "$target" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" producer_reconcile_delete_failed
}

# Exact path-unit slots are detached before any traversal. Even a directory
# marker with hundreds of entries therefore cannot keep request-run occupied.
for marker in "$RUN_ROOT/request-run" "$RUN_ROOT/cleanup-request"; do
  [ -e "$marker" ] || [ -L "$marker" ] || continue
  backup_quarantine_enqueue "$marker" runtime-marker
done

runtime_scan=0
runtime_scan_pending=false
while IFS= read -r -d '' entry; do
  runtime_scan=$((runtime_scan + 1))
  if [ "$runtime_scan" -gt 512 ]; then
    runtime_scan_pending=true
    break
  fi
  name="${entry##*/}"
  case "$name" in
    plain|dump|locks) ;;
    .request-run.tmp.[0-9]*|.cleanup-request.tmp.[0-9]*)
      backup_quarantine_enqueue "$entry" runtime-marker
      ;;
    *) backup_die "$BACKUP_EXIT_UNSAFE" producer_runtime_entry_refused ;;
  esac
done < <(find "$RUN_ROOT" -mindepth 1 -maxdepth 1 -print0)

# Count only the three fixed runtime trees and stop at the cap; quarantined
# marker trees are recovered separately in bounded no-follow steps below.
runtime_inodes=1
for runtime_tree in "$RUN_ROOT/plain" "$RUN_ROOT/dump" "$RUN_ROOT/locks"; do
  [ -e "$runtime_tree" ] || [ -L "$runtime_tree" ] || continue
  while IFS= read -r -d '' _runtime_entry; do
    runtime_inodes=$((runtime_inodes + 1))
    [ "$runtime_inodes" -le 128 ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" producer_runtime_inode_cap_exceeded
  done < <(find "$runtime_tree" -xdev -print0)
done

# Plaintext lives only on tmpfs. Truncate regular files before unlinking; FIFO,
# socket and directory entries are never opened or followed.
if [ -d "$RUN_ROOT/plain" ] && [ ! -L "$RUN_ROOT/plain" ]; then
  while IFS= read -r -d '' plaintext; do backup_secure_unlink "$plaintext"; done \
    < <(find "$RUN_ROOT/plain" -xdev -type f -print0)
fi
for entry in "$RUN_ROOT/plain" "$RUN_ROOT/dump" "$RUN_ROOT/locks"; do
  discard_tree "$entry"
done

claim_scan=0
claim_scan_pending=false
while IFS= read -r -d '' entry; do
  [ "$entry" = "$claim" ] && continue
  claim_scan=$((claim_scan + 1))
  if [ "$claim_scan" -gt 512 ]; then
    claim_scan_pending=true
    break
  fi
  name="${entry##*/}"
  case "$name" in
    quarantine) [ "$entry" = "$QUARANTINE_ROOT" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" dump_helper_quarantine_path_invalid ; continue ;;
    active-run) quarantine_class=active ;;
    helper.lock) quarantine_class=lease ;;
    request.claim|.request.*.claim) quarantine_class=request ;;
    cleanup.claim|.cleanup.*.claim) quarantine_class=cleanup ;;
    .producer-reconcile.*.claim) quarantine_class=reconcile ;;
    *) backup_die "$BACKUP_EXIT_UNSAFE" dump_helper_runtime_entry_refused ;;
  esac
  backup_quarantine_enqueue "$entry" "$quarantine_class"
done < <(find "$CLAIM_ROOT" -mindepth 1 -maxdepth 1 -print0)
backup_quarantine_recover 512
if [ "$runtime_scan_pending" = true ] || [ "$claim_scan_pending" = true ] ||
  [ "$BACKUP_QUARANTINE_REMAINS" = true ]; then
  backup_log warn dump_quarantine_recovery_pending \
    "work=$BACKUP_QUARANTINE_WORK" "runtime_scan_pending=$runtime_scan_pending" \
    "claim_scan_pending=$claim_scan_pending"
fi

ack_tmp="$ACK_ROOT/.reconcile-complete.tmp.$$"
printf '%s\n' "$token" >"$ack_tmp"
chmod 0640 "$ack_tmp"
if ! backup_is_test; then chgrp startap-backup-bridge "$ack_tmp"; fi
mv -- "$ack_tmp" "$ACK_ROOT/reconcile-complete"
rm -f -- "$claim"
backup_log info producer_runtime_reconciled "runtime_inodes=$runtime_inodes" \
  "quarantine_work=$BACKUP_QUARANTINE_WORK"
