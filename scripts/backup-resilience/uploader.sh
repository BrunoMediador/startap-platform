#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

CONFIG_DIR="$(backup_path STARTAP_BACKUP_CONFIG_DIR /etc/startap-backup)"
STATE_ROOT="$(backup_path STARTAP_BACKUP_STATE_ROOT /var/lib/startap-backup)"
GENERATIONS_ROOT="$STATE_ROOT/generations"
UPLOADER_ROOT="$(backup_path STARTAP_BACKUP_UPLOADER_ROOT /var/lib/startap-backup-uploader)"
OFFSITE_STATUS_ROOT="$(backup_path STARTAP_BACKUP_OFFSITE_STATUS_ROOT /var/lib/startap-backup-status/offsite)"
POLICY_FILE="$CONFIG_DIR/policy.conf"
KNOWN_HOSTS_FILE="$CONFIG_DIR/github_known_hosts"
WRITER_MARKER="$CONFIG_DIR/OFFSITE_WRITER_ENABLED"
ERROR_FILE=""
PREPARE_TMP=""
CURRENT_RUN_ID=""
CURRENT_ATTEMPT=0
UPLOAD_STARTED_AT=""
artifact_path=""

cleanup() {
  local code=$?
  set +e
  [ -n "$ERROR_FILE" ] && rm -f -- "$ERROR_FILE"
  if [ -n "$PREPARE_TMP" ] && [ -d "$PREPARE_TMP" ]; then
    case "$PREPARE_TMP" in "$UPLOADER_ROOT"/repository/dumps/*/.tmp-*)
      find "$PREPARE_TMP" -depth -delete 2>/dev/null || true ;;
    esac
  fi
  backup_release_lock
  trap - EXIT INT TERM HUP
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

backup_require_command git
backup_require_command jq
if ! backup_is_test; then backup_require_command timeout; fi
backup_verify_policy_file "$POLICY_FILE"
if ! backup_is_test; then
  [ "$(id -un)" = startap-backup-upload ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" uploader_user_identity_mismatch
  backup_require_directory "$GENERATIONS_ROOT" root:startap-backup-readers 750
  backup_require_directory "$UPLOADER_ROOT" startap-backup-upload:startap-backup-upload 700
  backup_require_directory "$OFFSITE_STATUS_ROOT" startap-backup-upload:startap-backup-upload 700
  backup_require_regular_file "$WRITER_MARKER" root:root 600
fi
backup_acquire_lock "$UPLOADER_ROOT/locks" uploader

if backup_is_test; then
  DEPLOY_KEY="${STARTAP_BACKUP_TEST_DEPLOY_KEY:-}"
  [ -n "$DEPLOY_KEY" ] || backup_die "$BACKUP_EXIT_CONFIG" deploy_key_missing
else
  [ -n "${CREDENTIALS_DIRECTORY:-}" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" credentials_directory_missing
  DEPLOY_KEY="$CREDENTIALS_DIRECTORY/offsite_deploy_key"
fi
[ ! -L "$DEPLOY_KEY" ] && [ -r "$DEPLOY_KEY" ] && [ -f "$DEPLOY_KEY" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" deploy_key_unreadable
if ! backup_is_test; then
  backup_require_regular_file "$KNOWN_HOSTS_FILE" root:root 644
else
  [ ! -L "$KNOWN_HOSTS_FILE" ] && [ -f "$KNOWN_HOSTS_FILE" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" known_hosts_missing
fi
grep -Eq '^github\.com[[:space:]]+ssh-ed25519[[:space:]]+' "$KNOWN_HOSTS_FILE" ||
  backup_die "$BACKUP_EXIT_CONFIG" known_hosts_target_missing

deploy_key_id="$(backup_read_config "$POLICY_FILE" DEPLOY_KEY_ID)"
backup_validate_opaque_id "$deploy_key_id"
[ "$deploy_key_id" != replace-with-approved-vps-only-key-id ] ||
  backup_die "$BACKUP_EXIT_CONFIG" deploy_key_not_approved
[ "$(backup_read_config "$POLICY_FILE" OFFSITE_REPOSITORY)" = BrunoMediador/startap-backups ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" offsite_repository_mismatch
branch="$(backup_read_config "$POLICY_FILE" OFFSITE_BRANCH)"
[ "$branch" = main ] || backup_die "$BACKUP_EXIT_UNSAFE" offsite_branch_mismatch

recovery_file="$OFFSITE_STATUS_ROOT/recovery-point.json"
last_recovery=""
if [ -e "$recovery_file" ]; then
  [ ! -L "$recovery_file" ] && [ -f "$recovery_file" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" offsite_recovery_status_unsafe
  if ! backup_is_test; then
    backup_require_regular_file "$recovery_file" startap-backup-upload:startap-backup-upload 600
  fi
  last_recovery="$(jq -er '.run_id' "$recovery_file")" ||
    backup_die "$BACKUP_EXIT_INTEGRITY" offsite_recovery_status_invalid
  backup_validate_run_id "$last_recovery"
fi

generation=""
for candidate in "$GENERATIONS_ROOT"/*; do
  [ -d "$candidate" ] && [ -f "$candidate/COMPLETE" ] || continue
  candidate_run="$(basename "$candidate")"
  printf '%s' "$candidate_run" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$' || continue
  if [ -z "$last_recovery" ] || [ "$candidate_run" \> "$last_recovery" ]; then
    if [ -z "$generation" ] || [ "$candidate_run" \< "$(basename "$generation")" ]; then
      generation="$candidate"
    fi
  fi
done
[ -n "$generation" ] || {
  backup_log info uploader_nothing_pending
  exit 0
}
CURRENT_RUN_ID="$(basename "$generation")"
backup_validate_run_id "$CURRENT_RUN_ID"
UPLOAD_STARTED_AT="$(backup_timestamp_now)"
backup_validate_cipher_generation "$generation" complete root:startap-backup-readers 550 440
manifest="$generation/manifest.json"
artifact="$(backup_manifest_field "$manifest" artifact)"
manifest_sha="$(backup_sha256 "$manifest")"

record_attempt() {
  local state="$1"
  local event="$2"
  local attempts="$3"
  local ended_at success=false
  printf '%s' "$event" | grep -Eq '^[a-z0-9_]{3,64}$' || event=status_event_invalid
  ended_at="$(backup_timestamp_now)"
  [ "$state" = success ] && success=true
  local temporary="$OFFSITE_STATUS_ROOT/.last-attempt.tmp.$$"
  jq -n --arg state "$state" --arg event "$event" --arg run_id "$CURRENT_RUN_ID" \
    --arg started_at "$UPLOAD_STARTED_AT" --arg ended_at "$ended_at" \
    --argjson success "$success" --argjson attempts "$attempts" \
    '{schema_version:1,state:$state,event:$event,run_id:$run_id,
      started_at:$started_at,ended_at:$ended_at,success:$success,attempts:$attempts}' \
    >"$temporary"
  chmod 0600 "$temporary"
  mv -- "$temporary" "$OFFSITE_STATUS_ROOT/last-attempt.json"
}

upload_die() {
  local code="$1"
  local event="$2"
  local attempts="${3:-$CURRENT_ATTEMPT}"
  record_attempt failed "$event" "$attempts"
  backup_die "$code" "$event" "attempts=$attempts"
}

repo_root="$UPLOADER_ROOT/repository"
[ -d "$repo_root/.git" ] || upload_die "$BACKUP_EXIT_CONFIG" offsite_checkout_missing 0
[ "$(git -C "$repo_root" remote get-url origin)" = \
  git@github.com:BrunoMediador/startap-backups.git ] ||
  upload_die "$BACKUP_EXIT_UNSAFE" offsite_remote_mismatch 0

export GIT_SSH_COMMAND="ssh -F /dev/null -i $DEPLOY_KEY -o UserKnownHostsFile=$KNOWN_HOSTS_FILE -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -o ConnectionAttempts=1"
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/bin/false
ERROR_FILE="$UPLOADER_ROOT/remote-error-${CURRENT_RUN_ID}.tmp"
chmod 0700 "$repo_root"
record_attempt running upload_started 0

classify_remote_error() {
  local exit_code="$1"
  local file="$2"
  if [ "$exit_code" = 124 ]; then
    printf 'transient\n'
  elif grep -Eqi 'Permission denied|Authentication failed|Repository not found|HTTP (401|403)|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|non-fast-forward|fetch first' "$file"; then
    printf 'terminal\n'
  elif grep -Eqi 'timed out|Connection reset|Could not resolve|Network is unreachable|Temporary failure|HTTP 429|HTTP 5[0-9][0-9]|remote end hung up|unexpected disconnect' "$file"; then
    printf 'transient\n'
  else
    printf 'terminal\n'
  fi
}

wait_before_retry() {
  local failed_attempt="$1"
  case "$failed_attempt" in 1) backoff=5 ;; 2) backoff=10 ;; *) backoff=20 ;; esac
  jitter="$(od -An -N1 -tu1 /dev/urandom | awk 'NF {print $1 % 4; exit}')"
  delay=$((backoff + jitter))
  [ "$delay" -le 30 ] || delay=30
  backup_log warn offsite_retry "attempt=$failed_attempt" "delay_seconds=$delay"
  if ! backup_is_test; then sleep "$delay"; fi
}

prepare_commit() {
  local year="${CURRENT_RUN_ID:0:4}"
  local month="${CURRENT_RUN_ID:4:2}"
  local destination="$repo_root/dumps/$year/$month/$CURRENT_RUN_ID"
  local destination_parent="$repo_root/dumps/$year/$month"
  manifest_path="dumps/$year/$month/$CURRENT_RUN_ID/manifest.json"
  artifact_path="dumps/$year/$month/$CURRENT_RUN_ID/$artifact"
  if [ -e "$destination" ]; then
    backup_validate_cipher_generation "$destination" complete \
      startap-backup-upload:startap-backup-upload 700 600
    [ "$(backup_sha256 "$destination/manifest.json")" = "$manifest_sha" ] ||
      upload_die "$BACKUP_EXIT_INTEGRITY" offsite_name_conflict "$CURRENT_ATTEMPT"
  else
    mkdir -p -- "$destination_parent"
    chmod 0700 "$repo_root/dumps" "$repo_root/dumps/$year" "$destination_parent"
    PREPARE_TMP="$destination_parent/.tmp-${CURRENT_RUN_ID}-$$"
    [ ! -e "$PREPARE_TMP" ] ||
      upload_die "$BACKUP_EXIT_INTEGRITY" offsite_prepare_conflict "$CURRENT_ATTEMPT"
    mkdir -- "$PREPARE_TMP"
    chmod 0700 "$PREPARE_TMP"
    for file in "$artifact" manifest.json SHA256SUMS PREPARED SEALED VALIDATED COMPLETE; do
      cp -- "$generation/$file" "$PREPARE_TMP/$file"
      chmod 0600 "$PREPARE_TMP/$file"
    done
    backup_validate_cipher_generation "$PREPARE_TMP" complete \
      startap-backup-upload:startap-backup-upload 700 600
    mv -- "$PREPARE_TMP" "$destination"
    PREPARE_TMP=""
    if [ "${STARTAP_BACKUP_TEST_FAILPOINT:-}" = upload_after_destination ]; then
      upload_die "$BACKUP_EXIT_TRANSIENT" offsite_prepare_interrupted "$CURRENT_ATTEMPT"
    fi
  fi
  git -C "$repo_root" add -- "dumps/$year/$month/$CURRENT_RUN_ID"
  if git -C "$repo_root" diff --cached --quiet -- "dumps/$year/$month/$CURRENT_RUN_ID"; then
    git -C "$repo_root" cat-file -e "HEAD:$manifest_path" 2>/dev/null &&
      [ "$(git -C "$repo_root" show "HEAD:$manifest_path" | backup_sha256_text)" = "$manifest_sha" ] &&
      [ -z "$(git -C "$repo_root" status --porcelain -- "dumps/$year/$month/$CURRENT_RUN_ID")" ] ||
      upload_die "$BACKUP_EXIT_INTEGRITY" offsite_tracked_tuple_mismatch "$CURRENT_ATTEMPT"
    return 0
  fi
  git -C "$repo_root" -c user.name='Startap Backup Automation' \
    -c user.email='backup-automation@users.noreply.github.com' \
    commit --quiet -m "backup: ${CURRENT_RUN_ID}" ||
    upload_die "$BACKUP_EXIT_INTEGRITY" offsite_commit_failed "$CURRENT_ATTEMPT"
}

upload_succeeded=0
for CURRENT_ATTEMPT in 1 2 3 4; do
  : >"$ERROR_FILE"
  fetch_exit=0
  if backup_is_test && [ "${STARTAP_BACKUP_TEST_SKIP_FETCH:-0}" = 1 ]; then
    :
  elif backup_is_test && [ -n "${STARTAP_BACKUP_TEST_FETCH_SEQUENCE:-}" ]; then
    fetch_outcome="$(printf '%s' "$STARTAP_BACKUP_TEST_FETCH_SEQUENCE" | awk -F, -v n="$CURRENT_ATTEMPT" '{print $n}')"
    case "$fetch_outcome" in
      success|'') ;;
      transient) printf 'Connection timed out\n' >"$ERROR_FILE"; fetch_exit=1 ;;
      auth) printf 'Permission denied\n' >"$ERROR_FILE"; fetch_exit=1 ;;
      host_mismatch) printf 'Host key verification failed\n' >"$ERROR_FILE"; fetch_exit=1 ;;
      *) printf 'unclassified failure\n' >"$ERROR_FILE"; fetch_exit=1 ;;
    esac
  else
    timeout --signal=TERM --kill-after=10s 15m \
      git -C "$repo_root" fetch --quiet origin "$branch" 2>"$ERROR_FILE" || fetch_exit=$?
  fi
  if [ "$fetch_exit" -ne 0 ]; then
    [ "$(classify_remote_error "$fetch_exit" "$ERROR_FILE")" = transient ] ||
      upload_die "$BACKUP_EXIT_AUTH" offsite_fetch_terminal "$CURRENT_ATTEMPT"
    [ "$CURRENT_ATTEMPT" -lt 4 ] ||
      upload_die "$BACKUP_EXIT_TRANSIENT" offsite_fetch_exhausted 4
    wait_before_retry "$CURRENT_ATTEMPT"
    continue
  fi

  if ! backup_is_test || [ "${STARTAP_BACKUP_TEST_SKIP_FETCH:-0}" != 1 ]; then
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
      if git -C "$repo_root" merge-base --is-ancestor "$branch" "origin/$branch"; then
        git -C "$repo_root" checkout --quiet "$branch"
        git -C "$repo_root" merge --ff-only --quiet "origin/$branch" ||
          upload_die "$BACKUP_EXIT_INTEGRITY" offsite_fast_forward_failed "$CURRENT_ATTEMPT"
      elif git -C "$repo_root" merge-base --is-ancestor "origin/$branch" "$branch"; then
        : # a prior local commit may still be awaiting push
      else
        upload_die "$BACKUP_EXIT_INTEGRITY" offsite_history_diverged "$CURRENT_ATTEMPT"
      fi
    else
      git -C "$repo_root" checkout --quiet -b "$branch" "origin/$branch"
    fi
  fi

  prepare_commit
  : >"$ERROR_FILE"
  push_exit=0
  if backup_is_test && [ -n "${STARTAP_BACKUP_TEST_PUSH_SEQUENCE:-}" ]; then
    outcome="$(printf '%s' "$STARTAP_BACKUP_TEST_PUSH_SEQUENCE" | awk -F, -v n="$CURRENT_ATTEMPT" '{print $n}')"
    case "$outcome" in
      success|'') ;;
      transient) printf 'Connection timed out\n' >"$ERROR_FILE"; push_exit=1 ;;
      auth) printf 'Permission denied\n' >"$ERROR_FILE"; push_exit=1 ;;
      host_mismatch) printf 'Host key verification failed\n' >"$ERROR_FILE"; push_exit=1 ;;
      non_fast_forward) printf 'non-fast-forward\n' >"$ERROR_FILE"; push_exit=1 ;;
      *) printf 'unclassified failure\n' >"$ERROR_FILE"; push_exit=1 ;;
    esac
  else
    timeout --signal=TERM --kill-after=10s 15m \
      git -C "$repo_root" push --porcelain origin "HEAD:$branch" \
      >/dev/null 2>"$ERROR_FILE" || push_exit=$?
  fi
  if [ "$push_exit" = 0 ]; then upload_succeeded=1; break; fi
  [ "$(classify_remote_error "$push_exit" "$ERROR_FILE")" = transient ] ||
    upload_die "$BACKUP_EXIT_AUTH" offsite_push_terminal "$CURRENT_ATTEMPT"
  [ "$CURRENT_ATTEMPT" -lt 4 ] ||
    upload_die "$BACKUP_EXIT_TRANSIENT" offsite_push_exhausted 4
  wait_before_retry "$CURRENT_ATTEMPT"
done
[ "$upload_succeeded" = 1 ] || upload_die "$BACKUP_EXIT_TRANSIENT" offsite_upload_exhausted 4

commit_sha="$(git -C "$repo_root" rev-parse HEAD)"
printf '%s' "$commit_sha" | grep -Eq '^[a-f0-9]{40}$' ||
  upload_die "$BACKUP_EXIT_INTEGRITY" offsite_commit_identity_invalid "$CURRENT_ATTEMPT"
uploaded_at="$(backup_timestamp_now)"
recovery_tmp="$OFFSITE_STATUS_ROOT/.recovery-point.tmp.$$"
jq -n --arg run_id "$CURRENT_RUN_ID" \
  --arg created_at "$(backup_manifest_field "$manifest" created_at)" \
  --arg uploaded_at "$uploaded_at" --arg sha256 "$(backup_manifest_field "$manifest" sha256)" \
  --arg manifest_sha256 "$manifest_sha" --arg manifest_path "$manifest_path" \
  --arg artifact_path "$artifact_path" \
  --arg commit_sha "$commit_sha" --argjson size_bytes "$(backup_manifest_field "$manifest" size_bytes)" \
  '{schema_version:1,state:"healthy",run_id:$run_id,created_at:$created_at,
    uploaded_at:$uploaded_at,sha256:$sha256,manifest_sha256:$manifest_sha256,
    manifest_path:$manifest_path,artifact_path:$artifact_path,
    commit_sha:$commit_sha,size_bytes:$size_bytes}' \
  >"$recovery_tmp"
chmod 0600 "$recovery_tmp"
# Record transport success first. If the process is interrupted before the
# recovery point rename, the older recovery remains authoritative and the next
# run retries; the inverse order could leave a permanent "running" attempt.
record_attempt success upload_complete "$CURRENT_ATTEMPT"
mv -- "$recovery_tmp" "$recovery_file"
rm -f -- "$ERROR_FILE"
ERROR_FILE=""
backup_log info offsite_upload_complete "run_id=$CURRENT_RUN_ID" "attempts=$CURRENT_ATTEMPT"
