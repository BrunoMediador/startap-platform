#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

RUN_ROOT="$(backup_path STARTAP_BACKUP_CYCLE_RUN_ROOT /run/startap-backup-orchestrator)"
BRIDGE_ROOT="$(backup_path STARTAP_BACKUP_BRIDGE_ROOT /run/startap-backup-bridge/producer)"
STATE_ROOT="$(backup_path STARTAP_BACKUP_STATE_ROOT /var/lib/startap-backup)"
ATTESTATION_ROOT="$(backup_path STARTAP_BACKUP_ATTESTATION_ROOT /var/lib/startap-backup-attestations)"
STATUS_ROOT="$(backup_path STARTAP_BACKUP_STATUS_ROOT /var/lib/startap-backup-status)"
LOCAL_STATUS_ROOT="$STATUS_ROOT/local"
PENDING_FILE="$STATE_ROOT/pending-run"
READY_FILE="$BRIDGE_ROOT/ready-run"
ATTEMPT_FILE="$LOCAL_STATUS_ROOT/last-attempt.json"
ATTEMPT_STARTED_AT="$(backup_timestamp_now)"
ATTEMPT_RUN_ID="${STARTAP_BACKUP_TEST_RUN_ID:-$ATTEMPT_STARTED_AT-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')}"
ATTEMPT_EVENT=cycle_started
ATTEMPT_COMPONENT=orchestrator
ATTEMPT_SUCCESS=false
backup_validate_run_id "$ATTEMPT_RUN_ID"

if backup_is_test; then
  mkdir -p -- "$LOCAL_STATUS_ROOT"
else
  backup_require_directory "$LOCAL_STATUS_ROOT" root:root 700
  backup_require_directory "$BRIDGE_ROOT" startap-backup-producer:startap-backup-bridge 750
fi

resolve_attempt_run() {
  local path value
  for path in "$PENDING_FILE" "$READY_FILE"; do
    if [ ! -L "$path" ] && [ -f "$path" ]; then
      value="$(sed -n '1p' "$path" 2>/dev/null || true)"
      if printf '%s' "$value" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$'; then
        ATTEMPT_RUN_ID="$value"
        return 0
      fi
    fi
  done
}

record_local_attempt() {
  local state="$1" class="$2" ended_at temporary
  ended_at="$(backup_timestamp_now)"
  temporary="$LOCAL_STATUS_ROOT/.last-attempt.tmp.$$"
  jq -n --arg state "$state" --arg class "$class" --arg event "$ATTEMPT_EVENT" \
    --arg component "$ATTEMPT_COMPONENT" --arg run_id "$ATTEMPT_RUN_ID" \
    --arg started_at "$ATTEMPT_STARTED_AT" --arg ended_at "$ended_at" \
    --argjson success "$ATTEMPT_SUCCESS" \
    '{schema_version:1,state:$state,class:$class,event:$event,component:$component,
      run_id:$run_id,started_at:$started_at,ended_at:$ended_at,success:$success}' \
    >"$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$ATTEMPT_FILE"
}

cleanup() {
  local code=$? class state
  trap - EXIT INT TERM HUP
  set +e
  resolve_attempt_run
  if [ "$ATTEMPT_SUCCESS" = true ] && [ "$code" = 0 ]; then
    state=success; class=success
  else
    state=failed
    case "$code" in
      "$BACKUP_EXIT_TRANSIENT"|130|143) class=transient ;;
      "$BACKUP_EXIT_INTEGRITY") class=integrity ;;
      "$BACKUP_EXIT_UNSAFE") class=unsafe ;;
      "$BACKUP_EXIT_CONFIG") class=config ;;
      *) class=terminal ;;
    esac
  fi
  record_local_attempt "$state" "$class" >/dev/null 2>&1 || true
  backup_release_lock
  exit "$code"
}
trap cleanup EXIT
trap 'ATTEMPT_EVENT=cycle_interrupted; exit 130' INT
trap 'ATTEMPT_EVENT=cycle_interrupted; exit 143' TERM HUP

record_local_attempt running running
backup_acquire_lock "$RUN_ROOT/locks" cycle

run_component() {
  local component="$1"
  ATTEMPT_COMPONENT="$component"
  ATTEMPT_EVENT="${component}_started"
  if backup_is_test; then
    "$SCRIPT_DIR/$component.sh"
  else
    systemctl start --wait "startap-backup-${component}.service" ||
      backup_die "$BACKUP_EXIT_INTEGRITY" component_service_failed "component=$component"
  fi
}

recover_pending() {
  local pending_run
  [ ! -L "$PENDING_FILE" ] && [ -f "$PENDING_FILE" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" pending_marker_unsafe
  pending_run="$(sed -n '1p' "$PENDING_FILE")"
  backup_validate_run_id "$pending_run"
  ATTEMPT_RUN_ID="$pending_run"
  if [ ! -f "$ATTESTATION_ROOT/${pending_run}.json" ] &&
    [ ! -f "$STATE_ROOT/generations/$pending_run/COMPLETE" ]; then
    run_component validate
  fi
  run_component promote
  ATTEMPT_EVENT=pending_cycle_recovered
  ATTEMPT_COMPONENT=orchestrator
  backup_log info pending_cycle_recovered "run_id=$pending_run"
}

recover_ready() {
  local ready_run
  if backup_is_test; then
    [ ! -L "$READY_FILE" ] && [ -f "$READY_FILE" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" ready_marker_unsafe
  else
    backup_require_regular_file "$READY_FILE" \
      startap-backup-producer:startap-backup-bridge 640
  fi
  ready_run="$(sed -n '1p' "$READY_FILE")"
  backup_validate_run_id "$ready_run"
  ATTEMPT_RUN_ID="$ready_run"
  run_component seal
  if [ -e "$PENDING_FILE" ]; then recover_pending; fi
}

# Resume every published transition before asking the producer for a new name.
# A failed run is never discarded; the same ciphertext converges to COMPLETE.
if [ -e "$PENDING_FILE" ] || [ -L "$PENDING_FILE" ]; then
  recover_pending
  if [ -e "$READY_FILE" ] || [ -L "$READY_FILE" ]; then recover_ready; fi
  ATTEMPT_SUCCESS=true
  exit 0
fi
if [ -e "$READY_FILE" ] || [ -L "$READY_FILE" ]; then
  recover_ready
  ATTEMPT_SUCCESS=true
  exit 0
fi

ATTEMPT_COMPONENT=producer
ATTEMPT_EVENT=producer_started
if backup_is_test; then
  set +e
  "$SCRIPT_DIR/producer.sh"
  producer_exit=$?
  set -e
  [ "$producer_exit" = 0 ] || [ "$producer_exit" = 10 ] || exit "$producer_exit"
else
  run_component producer
fi

if [ -e "$READY_FILE" ] || [ -L "$READY_FILE" ]; then
  recover_ready
elif [ -e "$PENDING_FILE" ] || [ -L "$PENDING_FILE" ]; then
  recover_pending
else
  ATTEMPT_EVENT=backup_cycle_idempotent
  backup_log info backup_cycle_idempotent
fi

# Shadow rollout never starts the uploader here.  Legacy remains the only
# offsite writer until the explicit cutover proof arms its separate timer.
ATTEMPT_COMPONENT=orchestrator
ATTEMPT_EVENT=backup_cycle_complete
ATTEMPT_SUCCESS=true
backup_log info backup_cycle_complete "offsite_dispatch=false"
