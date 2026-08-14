#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 1 ] || backup_die "$BACKUP_EXIT_CONFIG" github_environment_proof_arguments_invalid
proof="$1"
if backup_is_test; then
  [ ! -L "$proof" ] && [ -f "$proof" ] && [ "$(backup_stat_links "$proof")" = 1 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" github_environment_proof_unsafe
else
  backup_require_regular_file "$proof" root:root 600
  backup_require_trusted_parent_chain "$proof"
fi
jq -e '
  .schema_version == 1 and .repository == "BrunoMediador/startap-platform" and
  .captured_from_github_api == true and .root_ssh_secret_absent == true and
  (.captured_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
  .repository_secrets_endpoint_checked == true and
  .environment_deployment_policies_endpoint_checked == true and
  .repository_level_backup_secrets_absent == true and
  (.environments | length == 3) and
  ([.environments[].name] | sort) ==
    (["backup-legacy-main","backup-recovery-main","backup-status-main"] | sort) and
  all(.environments[];
    .protected_branches_only == true and
    .allowed_refs == ["refs/heads/main"] and
    .deployment_branch_policy.custom_branch_policies == true and
    .deployment_branch_policy.protected_branches == false) and
  ([.environments[] | select(.name == "backup-legacy-main") | .secret_names][0] | sort) ==
    (["BACKUP_AGE_PUBKEY","BACKUP_LEGACY_DUMP_SSH_KEY","BACKUP_REPO_SSH_KEY"] | sort) and
  ([.environments[] | select(.name == "backup-status-main") | .secret_names][0] | sort) ==
    (["BACKUP_REPO_READONLY_SSH_KEY","BACKUP_STATUS_SSH_KEY"] | sort) and
  ([.environments[] | select(.name == "backup-recovery-main") | .secret_names][0] | sort) ==
    (["BACKUP_REPO_READONLY_SSH_KEY","BACKUP_STATUS_SSH_KEY"] | sort)
' "$proof" >/dev/null || backup_die "$BACKUP_EXIT_UNSAFE" github_environment_proof_invalid
backup_log info github_environment_proof_verified
