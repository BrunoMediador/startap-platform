#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 5 ] || backup_die "$BACKUP_EXIT_CONFIG" anchor_arguments_invalid
mode="$1"
repo_root="$2"
health_file="$3"
previous_anchor="$4"
output_anchor="$5"
case "$mode" in verify|bootstrap) ;; *) backup_die "$BACKUP_EXIT_CONFIG" anchor_mode_invalid ;; esac
backup_require_command git
backup_require_command jq
[ ! -L "$repo_root" ] && [ -d "$repo_root/.git" ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" anchor_repository_invalid
[ "$(git -C "$repo_root" remote get-url origin)" = \
  git@github.com:BrunoMediador/startap-backups.git ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" anchor_repository_remote_mismatch
[ ! -L "$health_file" ] && [ -f "$health_file" ] &&
  [ "$(backup_stat_links "$health_file")" = 1 ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" anchor_health_file_unsafe

jq -e '.schema_version == 1 and .state == "healthy" and
  .external_anchor_required == true and .recovery_tuple_coherent == true and
  .local.state == "healthy" and .offsite.state == "healthy" and
  (.local.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$")) and
  .local.run_id == .offsite.run_id and .local.sha256 == .offsite.sha256 and
  .local.manifest_sha256 == .offsite.manifest_sha256 and
  .local.size_bytes == .offsite.size_bytes and
  (.offsite.commit_sha | test("^[a-f0-9]{40}$")) and
  (.offsite.sha256 | test("^[a-f0-9]{64}$")) and
  (.offsite.manifest_sha256 | test("^[a-f0-9]{64}$")) and
  (.offsite.manifest_path | test("^dumps/[0-9]{4}/[0-9]{2}/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}/manifest\\.json$")) and
  (.offsite.artifact_path | test("^dumps/[0-9]{4}/[0-9]{2}/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}/backup-[0-9]{8}T[0-9]{6}Z\\.sql\\.gz\\.age$")) and
  (.offsite.size_bytes | type == "number" and . > 0)' "$health_file" >/dev/null ||
  backup_die "$BACKUP_EXIT_INTEGRITY" anchor_health_tuple_invalid

verify_repository_tuple() {
  local commit="$1" run_id="$2" manifest_path="$3" expected_manifest_sha="$4"
  local expected_artifact_path="$5" expected_artifact_sha="$6" expected_size="$7"
  local manifest artifact artifact_path manifest_sha artifact_sha artifact_size

  git -C "$repo_root" cat-file -e "${commit}^{commit}" 2>/dev/null ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_commit_missing
  require_regular_git_blob "$commit" "$manifest_path" manifest
  manifest="$(git -C "$repo_root" show "$commit:$manifest_path")" ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_manifest_unreadable
  manifest_sha="$(printf '%s\n' "$manifest" | backup_sha256_text)"
  [ "$manifest_sha" = "$expected_manifest_sha" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_manifest_hash_mismatch
  artifact="$(printf '%s\n' "$manifest" | jq -er '.artifact')" ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_manifest_artifact_invalid
  [ "$artifact" = "backup-${run_id%-*}.sql.gz.age" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_artifact_name_mismatch
  artifact_path="${manifest_path%/manifest.json}/$artifact"
  [ "$artifact_path" = "$expected_artifact_path" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_artifact_path_mismatch
  printf '%s\n' "$manifest" | jq -e --arg run_id "$run_id" \
    --arg artifact "$artifact" --arg artifact_sha "$expected_artifact_sha" \
    --argjson artifact_size "$expected_size" '
      .schema_version == 1 and .run_id == $run_id and .artifact == $artifact and
      .sha256 == $artifact_sha and .size_bytes == $artifact_size
    ' >/dev/null || backup_die "$BACKUP_EXIT_INTEGRITY" anchor_manifest_tuple_mismatch
  require_regular_git_blob "$commit" "$artifact_path" artifact
  artifact_sha="$(git -C "$repo_root" show "$commit:$artifact_path" | backup_sha256_text)"
  artifact_size="$(git -C "$repo_root" cat-file -s "$commit:$artifact_path")"
  [ "$artifact_sha" = "$expected_artifact_sha" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_artifact_blob_hash_mismatch
  [ "$artifact_size" = "$expected_size" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_artifact_blob_size_mismatch
}

# `git show <commit>:<path>` alone accepts symlinks and executable blobs. Resolve
# one literal tree entry first and require Git's canonical regular-file mode.
# Paths are already constrained to the strict dumps/<year>/<month>/<run>/ shape.
require_regular_git_blob() {
  local commit="$1" path="$2" kind="$3" record metadata recorded_path mode type object
  record="$(LC_ALL=C git -C "$repo_root" ls-tree --full-tree "$commit" -- \
    ":(literal)$path")" || backup_die "$BACKUP_EXIT_INTEGRITY" "anchor_${kind}_tree_unreadable"
  [ -n "$record" ] || {
    if [ "$kind" = artifact ]; then
      backup_die "$BACKUP_EXIT_INTEGRITY" anchor_artifact_blob_missing
    fi
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_manifest_missing
  }
  [ "$(printf '%s\n' "$record" | wc -l | tr -d ' ')" = 1 ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" "anchor_${kind}_tree_ambiguous"
  case "$record" in *$'\t'*) ;; *)
    backup_die "$BACKUP_EXIT_INTEGRITY" "anchor_${kind}_tree_malformed" ;; esac
  metadata="${record%%$'\t'*}"
  recorded_path="${record#*$'\t'}"
  [ "$recorded_path" = "$path" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" "anchor_${kind}_tree_path_mismatch"
  read -r mode type object <<EOF
$metadata
EOF
  [ "$mode" = 100644 ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" "anchor_${kind}_git_mode_refused"
  [ "$type" = blob ] && printf '%s' "$object" | grep -Eq '^[a-f0-9]{40,64}$' ||
    backup_die "$BACKUP_EXIT_INTEGRITY" "anchor_${kind}_not_blob"
}

current_run="$(jq -r '.offsite.run_id' "$health_file")"
current_commit="$(jq -r '.offsite.commit_sha' "$health_file")"
current_manifest_sha="$(jq -r '.offsite.manifest_sha256' "$health_file")"
current_manifest_path="$(jq -r '.offsite.manifest_path' "$health_file")"
current_artifact_path="$(jq -r '.offsite.artifact_path' "$health_file")"
current_artifact_sha="$(jq -r '.offsite.sha256' "$health_file")"
current_size="$(jq -r '.offsite.size_bytes' "$health_file")"
expected_manifest_path="dumps/${current_run:0:4}/${current_run:4:2}/${current_run}/manifest.json"
[ "$current_manifest_path" = "$expected_manifest_path" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" anchor_manifest_path_run_mismatch
head_commit="$(git -C "$repo_root" rev-parse HEAD)"
[ "$current_commit" = "$head_commit" ] ||
  backup_die "$BACKUP_EXIT_INTEGRITY" anchor_health_head_mismatch
verify_repository_tuple "$current_commit" "$current_run" "$current_manifest_path" \
  "$current_manifest_sha" "$current_artifact_path" "$current_artifact_sha" "$current_size"

if [ "$mode" = verify ]; then
  [ "$previous_anchor" != - ] && [ ! -L "$previous_anchor" ] &&
    [ -f "$previous_anchor" ] && [ "$(backup_stat_links "$previous_anchor")" = 1 ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_previous_missing
  jq -e '.schema_version == 2 and .repository == "BrunoMediador/startap-backups" and
    .branch == "main" and (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$")) and
    (.commit_sha | test("^[a-f0-9]{40}$")) and
    (.manifest_sha256 | test("^[a-f0-9]{64}$")) and
    (.artifact_sha256 | test("^[a-f0-9]{64}$")) and
    (.artifact_size_bytes | type == "number" and . > 0) and
    (.manifest_path | test("^dumps/[0-9]{4}/[0-9]{2}/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}/manifest\\.json$")) and
    (.artifact_path | test("^dumps/[0-9]{4}/[0-9]{2}/[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}/backup-[0-9]{8}T[0-9]{6}Z\\.sql\\.gz\\.age$"))' \
    "$previous_anchor" >/dev/null ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_previous_invalid
  previous_run="$(jq -r '.run_id' "$previous_anchor")"
  previous_commit="$(jq -r '.commit_sha' "$previous_anchor")"
  previous_manifest_sha="$(jq -r '.manifest_sha256' "$previous_anchor")"
  previous_manifest_path="$(jq -r '.manifest_path' "$previous_anchor")"
  previous_artifact_path="$(jq -r '.artifact_path' "$previous_anchor")"
  previous_artifact_sha="$(jq -r '.artifact_sha256' "$previous_anchor")"
  previous_size="$(jq -r '.artifact_size_bytes' "$previous_anchor")"
  [ "$previous_manifest_path" = \
    "dumps/${previous_run:0:4}/${previous_run:4:2}/${previous_run}/manifest.json" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_previous_path_run_mismatch
  [ "$previous_artifact_path" = \
    "${previous_manifest_path%/manifest.json}/backup-${previous_run%-*}.sql.gz.age" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_previous_artifact_path_run_mismatch
  git -C "$repo_root" merge-base --is-ancestor "$previous_commit" "$current_commit" ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_history_rewrite_detected
  verify_repository_tuple "$previous_commit" "$previous_run" "$previous_manifest_path" \
    "$previous_manifest_sha" "$previous_artifact_path" "$previous_artifact_sha" "$previous_size"
  [ "$current_run" \> "$previous_run" ] || [ "$current_run" = "$previous_run" ] ||
    backup_die "$BACKUP_EXIT_INTEGRITY" anchor_run_rollback_detected
  if [ "$current_run" = "$previous_run" ]; then
    [ "$current_commit:$current_manifest_sha:$current_manifest_path:$current_artifact_sha:$current_size:$current_artifact_path" = \
      "$previous_commit:$previous_manifest_sha:$previous_manifest_path:$previous_artifact_sha:$previous_size:$previous_artifact_path" ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" anchor_same_run_tuple_changed
  fi
fi

temporary="${output_anchor}.tmp.$$"
jq -n --arg run_id "$current_run" --arg commit_sha "$current_commit" \
  --arg manifest_sha256 "$current_manifest_sha" --arg manifest_path "$current_manifest_path" \
  --arg artifact_sha256 "$current_artifact_sha" --arg artifact_path "$current_artifact_path" \
  --argjson artifact_size_bytes "$current_size" \
  '{schema_version:2,repository:"BrunoMediador/startap-backups",branch:"main",
    run_id:$run_id,commit_sha:$commit_sha,manifest_sha256:$manifest_sha256,
    manifest_path:$manifest_path,artifact_sha256:$artifact_sha256,
    artifact_path:$artifact_path,artifact_size_bytes:$artifact_size_bytes,
    anchored_at:(now|todateiso8601)}' >"$temporary"
chmod 0600 "$temporary"
mv -- "$temporary" "$output_anchor"
backup_log info external_anchor_verified "run_id=$current_run" \
  "bootstrap=$([ "$mode" = bootstrap ] && printf true || printf false)"
