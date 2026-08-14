#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

CONFIG_DIR="$(backup_path STARTAP_BACKUP_CONFIG_DIR /etc/startap-backup)"
STATE_ROOT="$(backup_path STARTAP_BACKUP_STATE_ROOT /var/lib/startap-backup)"
GENERATIONS_ROOT="$STATE_ROOT/generations"
ATTESTATION_ROOT="$(backup_path STARTAP_BACKUP_ATTESTATION_ROOT /var/lib/startap-backup-attestations)"
STATUS_ROOT="$(backup_path STARTAP_BACKUP_STATUS_ROOT /var/lib/startap-backup-status)"
POLICY_FILE="$CONFIG_DIR/policy.conf"
if ! backup_is_test; then
  backup_require_directory "$GENERATIONS_ROOT" root:startap-backup-readers 750
  backup_require_directory "$ATTESTATION_ROOT" startap-backup-validator:startap-backup-validator 700
  backup_require_directory "$STATUS_ROOT/offsite" startap-backup-upload:startap-backup-upload 700
  backup_require_directory "$STATUS_ROOT/local" root:root 700
fi
healthy_seconds="$(backup_read_config "$POLICY_FILE" FRESHNESS_HEALTHY_SECONDS)"
stale_seconds="$(backup_read_config "$POLICY_FILE" FRESHNESS_STALE_SECONDS)"
printf '%s:%s' "$healthy_seconds" "$stale_seconds" | grep -Eq '^[0-9]+:[0-9]+$' ||
  backup_die "$BACKUP_EXIT_CONFIG" freshness_policy_invalid
[ "$healthy_seconds" -lt "$stale_seconds" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" freshness_threshold_order_invalid

classify_age() {
  local age="$1"
  if [ "$age" -le "$healthy_seconds" ]; then printf 'healthy\n'
  elif [ "$age" -le "$stale_seconds" ]; then printf 'degraded\n'
  else printf 'stale\n'; fi
}

local_state=none local_run_id="" local_created="" local_sha="" local_manifest_sha=""
local_size=0 local_age=-1 latest_name="" latest_valid_name=""
for generation in "$GENERATIONS_ROOT"/*; do
  [ -d "$generation" ] || continue
  name="$(basename "$generation")"
  printf '%s' "$name" | grep -Eq '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$' || continue
  if [ -z "$latest_name" ] || [ "$name" \> "$latest_name" ]; then latest_name="$name"; fi
  if (backup_validate_cipher_generation "$generation" complete \
      root:startap-backup-readers 550 440) >/dev/null 2>&1; then
    if [ -z "$latest_valid_name" ] || [ "$name" \> "$latest_valid_name" ]; then
      latest_valid_name="$name"
    fi
  fi
done
if [ -n "$latest_valid_name" ]; then
  generation="$GENERATIONS_ROOT/$latest_valid_name"
  local_run_id="$(backup_manifest_field "$generation/manifest.json" run_id)"
  local_created="$(backup_manifest_field "$generation/manifest.json" created_at)"
  local_sha="$(backup_manifest_field "$generation/manifest.json" sha256)"
  local_manifest_sha="$(backup_sha256 "$generation/manifest.json")"
  local_size="$(backup_manifest_field "$generation/manifest.json" size_bytes)"
  local_age=$(( $(backup_epoch_now) - $(backup_timestamp_to_epoch "$local_created") ))
  if [ "$local_age" -lt 0 ]; then local_state=invalid
  else local_state="$(classify_age "$local_age")"; fi
fi
if [ -n "$latest_name" ] && [ "$latest_name" != "$latest_valid_name" ]; then local_state=invalid; fi
latest_generation_valid=false
[ -n "$latest_name" ] && [ "$latest_name" = "$latest_valid_name" ] && latest_generation_valid=true

local_attempt_state=none local_attempt_run_id="" local_attempt_event=""
local_attempt_class="" local_attempt_component="" local_attempt_started_at=""
local_attempt_ended_at="" local_attempt_success=false
local_attempt_file="$STATUS_ROOT/local/last-attempt.json"
if [ -e "$local_attempt_file" ] || [ -L "$local_attempt_file" ]; then
  if ! backup_is_test; then
    backup_require_regular_file "$local_attempt_file" root:root 600
  fi
  if [ ! -L "$local_attempt_file" ] && [ -f "$local_attempt_file" ] &&
    [ "$(backup_stat_links "$local_attempt_file")" = 1 ] &&
    jq -e '.schema_version == 1 and
      (.state == "running" or .state == "failed" or .state == "success") and
      (.class | test("^[a-z0-9_]{3,32}$")) and
      (.event | test("^[a-z0-9_]{3,64}$")) and
      (.component | test("^[a-z0-9_]{3,32}$")) and
      (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$")) and
      (.started_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
      (.ended_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
      (.success | type == "boolean") and
      ((.state == "success") == .success)' "$local_attempt_file" >/dev/null 2>&1; then
    local_attempt_state="$(jq -r '.state' "$local_attempt_file")"
    local_attempt_run_id="$(jq -r '.run_id' "$local_attempt_file")"
    local_attempt_event="$(jq -r '.event' "$local_attempt_file")"
    local_attempt_class="$(jq -r '.class' "$local_attempt_file")"
    local_attempt_component="$(jq -r '.component' "$local_attempt_file")"
    local_attempt_started_at="$(jq -r '.started_at' "$local_attempt_file")"
    local_attempt_ended_at="$(jq -r '.ended_at' "$local_attempt_file")"
    local_attempt_success="$(jq -r '.success' "$local_attempt_file")"
    if [ "$(backup_timestamp_to_epoch "$local_attempt_ended_at")" -lt \
      "$(backup_timestamp_to_epoch "$local_attempt_started_at")" ]; then
      local_attempt_state=invalid
    elif [ "$local_attempt_state" != success ] &&
      { [ -z "$local_run_id" ] || [ "$local_attempt_run_id" \> "$local_run_id" ] ||
        [ "$local_attempt_run_id" = "$local_run_id" ]; }; then
      [ "$local_state" = healthy ] && local_state=degraded
      [ "$local_state" = none ] && local_state=degraded
    fi
  else
    local_attempt_state=invalid
  fi
  if [ "$local_attempt_state" = invalid ] && [ "$local_state" = healthy ]; then local_state=degraded; fi
fi

identity_available=false identity_state=missing identity_checked_at="" identity_age=-1 identity_run_id=""
identity_file="$ATTESTATION_ROOT/identity-heartbeat.json"
if [ -e "$identity_file" ] || [ -L "$identity_file" ]; then
  if ! backup_is_test; then
    backup_require_regular_file "$identity_file" startap-backup-validator:startap-backup-validator 600
  fi
  if [ ! -L "$identity_file" ] && [ -f "$identity_file" ] &&
    [ "$(backup_stat_links "$identity_file")" = 1 ] &&
    jq -e '.schema_version == 1 and .state == "healthy" and .decrypt_succeeded == true and
      (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$")) and
      (.checked_at | test("^[0-9]{8}T[0-9]{6}Z$"))' "$identity_file" >/dev/null 2>&1; then
    identity_checked_at="$(jq -r '.checked_at' "$identity_file")"
    identity_run_id="$(jq -r '.run_id' "$identity_file")"
    identity_age=$(( $(backup_epoch_now) - $(backup_timestamp_to_epoch "$identity_checked_at") ))
    if [ "$identity_age" -ge 0 ] && [ "$identity_age" -le "$stale_seconds" ] &&
      { [ -z "$local_run_id" ] || [ "$identity_run_id" \> "$local_run_id" ] ||
        [ "$identity_run_id" = "$local_run_id" ]; }; then
      identity_available=true; identity_state=healthy
    else identity_state=stale; fi
  else identity_state=invalid; fi
fi

offsite_state=none offsite_run_id="" offsite_created="" offsite_uploaded=""
offsite_sha="" offsite_manifest_sha="" offsite_manifest_path="" offsite_artifact_path=""
offsite_commit_sha="" offsite_size=0 offsite_age=-1
recovery_file="$STATUS_ROOT/offsite/recovery-point.json"
if [ -e "$recovery_file" ] || [ -L "$recovery_file" ]; then
  if ! backup_is_test; then
    backup_require_regular_file "$recovery_file" startap-backup-upload:startap-backup-upload 600
  fi
  if [ ! -L "$recovery_file" ] && [ -f "$recovery_file" ] &&
    [ "$(backup_stat_links "$recovery_file")" = 1 ] &&
    jq -e '.schema_version == 1 and .state == "healthy" and
      (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$")) and
      (.created_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
      (.uploaded_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
      (.sha256 | test("^[a-f0-9]{64}$")) and
      (.manifest_sha256 | test("^[a-f0-9]{64}$")) and
      (.manifest_path | test("^dumps/[0-9]{4}/[0-9]{2}/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}/manifest\\.json$")) and
      (.artifact_path | test("^dumps/[0-9]{4}/[0-9]{2}/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}/backup-[0-9]{8}T[0-9]{6}Z\\.sql\\.gz\\.age$")) and
      (.commit_sha | test("^[a-f0-9]{40}$")) and
      (.size_bytes | type == "number" and . > 0)' "$recovery_file" >/dev/null 2>&1; then
    offsite_run_id="$(jq -r '.run_id' "$recovery_file")"
    offsite_created="$(jq -r '.created_at' "$recovery_file")"
    offsite_uploaded="$(jq -r '.uploaded_at' "$recovery_file")"
    offsite_sha="$(jq -r '.sha256' "$recovery_file")"
    offsite_manifest_sha="$(jq -r '.manifest_sha256' "$recovery_file")"
    offsite_manifest_path="$(jq -r '.manifest_path' "$recovery_file")"
    offsite_artifact_path="$(jq -r '.artifact_path' "$recovery_file")"
    offsite_commit_sha="$(jq -r '.commit_sha' "$recovery_file")"
    offsite_size="$(jq -r '.size_bytes' "$recovery_file")"
    expected_parent="dumps/${offsite_run_id:0:4}/${offsite_run_id:4:2}/$offsite_run_id"
    if [ "$offsite_created" != "${offsite_run_id%-*}" ] ||
      [ "$offsite_manifest_path" != "$expected_parent/manifest.json" ] ||
      [ "$offsite_artifact_path" != "$expected_parent/backup-${offsite_created}.sql.gz.age" ]; then
      offsite_state=invalid
    else
      offsite_age=$(( $(backup_epoch_now) - $(backup_timestamp_to_epoch "$offsite_created") ))
      if [ "$offsite_age" -lt 0 ]; then offsite_state=invalid
      else offsite_state="$(classify_age "$offsite_age")"; fi
    fi
  else offsite_state=invalid; fi
fi

offsite_attempt_state=none offsite_attempt_run_id="" offsite_attempt_event=""
offsite_attempt_started_at="" offsite_attempt_ended_at="" offsite_attempt_success=false offsite_attempts=0
last_attempt_file="$STATUS_ROOT/offsite/last-attempt.json"
if [ -e "$last_attempt_file" ] || [ -L "$last_attempt_file" ]; then
  if ! backup_is_test; then backup_require_regular_file "$last_attempt_file" startap-backup-upload:startap-backup-upload 600; fi
  if [ ! -L "$last_attempt_file" ] && [ -f "$last_attempt_file" ] &&
    [ "$(backup_stat_links "$last_attempt_file")" = 1 ] &&
    jq -e '.schema_version == 1 and
      (.state == "running" or .state == "failed" or .state == "success") and
      (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$")) and
      (.event | test("^[a-z0-9_]{3,64}$")) and
      (.started_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
      (.ended_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
      (.success | type == "boolean") and ((.state == "success") == .success) and
      (.attempts | type == "number" and . >= 0 and . <= 4)' "$last_attempt_file" >/dev/null 2>&1; then
    offsite_attempt_state="$(jq -r '.state' "$last_attempt_file")"
    offsite_attempt_run_id="$(jq -r '.run_id' "$last_attempt_file")"
    offsite_attempt_event="$(jq -r '.event' "$last_attempt_file")"
    offsite_attempt_started_at="$(jq -r '.started_at' "$last_attempt_file")"
    offsite_attempt_ended_at="$(jq -r '.ended_at' "$last_attempt_file")"
    offsite_attempt_success="$(jq -r '.success' "$last_attempt_file")"
    offsite_attempts="$(jq -r '.attempts' "$last_attempt_file")"
    if [ "$(backup_timestamp_to_epoch "$offsite_attempt_ended_at")" -lt \
      "$(backup_timestamp_to_epoch "$offsite_attempt_started_at")" ]; then
      offsite_attempt_state=invalid
    elif [ "$offsite_attempt_state" != success ] &&
      { [ -z "$offsite_run_id" ] || [ "$offsite_attempt_run_id" \> "$offsite_run_id" ] ||
        [ "$offsite_attempt_run_id" = "$offsite_run_id" ]; }; then
      [ "$offsite_state" = healthy ] && offsite_state=degraded
      [ "$offsite_state" = none ] && offsite_state=degraded
    fi
  else offsite_attempt_state=invalid; fi
  if [ "$offsite_attempt_state" = invalid ] && [ "$offsite_state" = healthy ]; then offsite_state=degraded; fi
fi

recovery_tuple_coherent=false
if [ -n "$local_run_id" ] && [ -n "$offsite_run_id" ] &&
  [ "$local_run_id" = "$offsite_run_id" ]; then
  if [ "$local_sha" = "$offsite_sha" ] && [ "$local_manifest_sha" = "$offsite_manifest_sha" ] &&
    [ "$local_size" = "$offsite_size" ]; then
    recovery_tuple_coherent=true
  else
    offsite_state=invalid
  fi
fi
if [ "$local_state" = healthy ] && [ -n "$local_run_id" ] &&
  { [ -z "$offsite_run_id" ] || [ "$local_run_id" \> "$offsite_run_id" ]; }; then
  case "$offsite_state" in healthy|none) offsite_state=degraded ;; esac
fi

if [ "$local_state" = healthy ] && [ "$offsite_state" = healthy ] &&
  [ "$identity_available" = true ] && [ "$recovery_tuple_coherent" = true ]; then
  overall=healthy
elif [ "$local_state" = healthy ] || [ "$offsite_state" = healthy ] ||
  [ "$local_state" = degraded ] || [ "$offsite_state" = degraded ]; then
  overall=degraded
elif [ "$local_state" = stale ] || [ "$offsite_state" = stale ]; then overall=stale
elif [ "$local_state" = invalid ] || [ "$offsite_state" = invalid ] ||
  [ "$identity_state" = invalid ]; then overall=invalid
else overall=none; fi

jq -n --arg state "$overall" --argjson recovery_tuple_coherent "$recovery_tuple_coherent" \
  --arg local_state "$local_state" --arg local_run_id "$local_run_id" \
  --arg local_latest_generation_run_id "$latest_name" --argjson local_latest_generation_valid "$latest_generation_valid" \
  --arg local_created_at "$local_created" --arg local_sha256 "$local_sha" \
  --arg local_manifest_sha256 "$local_manifest_sha" --argjson local_size_bytes "$local_size" \
  --argjson local_age_seconds "$local_age" --arg local_attempt_state "$local_attempt_state" \
  --arg local_attempt_run_id "$local_attempt_run_id" --arg local_attempt_event "$local_attempt_event" \
  --arg local_attempt_class "$local_attempt_class" --arg local_attempt_component "$local_attempt_component" \
  --arg local_attempt_started_at "$local_attempt_started_at" --arg local_attempt_ended_at "$local_attempt_ended_at" \
  --argjson local_attempt_success "$local_attempt_success" --arg offsite_state "$offsite_state" \
  --arg offsite_run_id "$offsite_run_id" --arg offsite_created_at "$offsite_created" \
  --arg offsite_uploaded_at "$offsite_uploaded" --arg offsite_sha256 "$offsite_sha" \
  --arg offsite_manifest_sha256 "$offsite_manifest_sha" --arg offsite_manifest_path "$offsite_manifest_path" \
  --arg offsite_artifact_path "$offsite_artifact_path" --arg offsite_commit_sha "$offsite_commit_sha" \
  --argjson offsite_size_bytes "$offsite_size" --argjson offsite_age_seconds "$offsite_age" \
  --arg offsite_attempt_state "$offsite_attempt_state" --arg offsite_attempt_run_id "$offsite_attempt_run_id" \
  --arg offsite_attempt_event "$offsite_attempt_event" --arg offsite_attempt_started_at "$offsite_attempt_started_at" \
  --arg offsite_attempt_ended_at "$offsite_attempt_ended_at" --argjson offsite_attempt_success "$offsite_attempt_success" \
  --argjson offsite_attempts "$offsite_attempts" --arg identity_state "$identity_state" \
  --arg identity_checked_at "$identity_checked_at" --arg identity_run_id "$identity_run_id" \
  --argjson identity_age_seconds "$identity_age" --argjson identity_available "$identity_available" \
  '{schema_version:1,state:$state,generated_at:(now|todateiso8601),recovery_tuple_coherent:$recovery_tuple_coherent,
    local:{state:$local_state,run_id:$local_run_id,latest_generation_run_id:$local_latest_generation_run_id,
      latest_generation_valid:$local_latest_generation_valid,created_at:$local_created_at,
      age_seconds:$local_age_seconds,sha256:$local_sha256,manifest_sha256:$local_manifest_sha256,
      size_bytes:$local_size_bytes,last_attempt:{state:$local_attempt_state,run_id:$local_attempt_run_id,
        event:$local_attempt_event,class:$local_attempt_class,component:$local_attempt_component,
        started_at:$local_attempt_started_at,ended_at:$local_attempt_ended_at,success:$local_attempt_success}},
    offsite:{state:$offsite_state,run_id:$offsite_run_id,created_at:$offsite_created_at,
      uploaded_at:$offsite_uploaded_at,age_seconds:$offsite_age_seconds,sha256:$offsite_sha256,
      manifest_sha256:$offsite_manifest_sha256,manifest_path:$offsite_manifest_path,
      artifact_path:$offsite_artifact_path,commit_sha:$offsite_commit_sha,size_bytes:$offsite_size_bytes,
      last_attempt:{state:$offsite_attempt_state,run_id:$offsite_attempt_run_id,event:$offsite_attempt_event,
        started_at:$offsite_attempt_started_at,ended_at:$offsite_attempt_ended_at,
        success:$offsite_attempt_success,attempts:$offsite_attempts}},
    automation_identity:{state:$identity_state,available:$identity_available,run_id:$identity_run_id,
      checked_at:$identity_checked_at,age_seconds:$identity_age_seconds},
    external_anchor_required:true,alert_delivery_affects_validity:false}'

case "$overall" in healthy) exit 0 ;; degraded) exit 2 ;; *) exit 1 ;; esac
