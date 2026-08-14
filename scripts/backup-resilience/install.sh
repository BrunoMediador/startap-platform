#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

usage() {
  printf 'usage: %s preflight|stage|prepare-offsite|arm|activate|activate-uploader|enable-dispatch\n' "$0" >&2
  exit "$BACKUP_EXIT_CONFIG"
}
[ "$#" = 1 ] || usage
action="$1"
[ "$(id -u)" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" installer_requires_root

CONFIG_DIR=/etc/startap-backup
POLICY_FILE="$CONFIG_DIR/policy.conf"
CREDENTIAL_DIR="$CONFIG_DIR/credentials"
UNIT_SOURCE="$SCRIPT_DIR/../../infra/systemd"
PROOF_ROOT=/var/lib/startap-backup/drills

verify_installer_binaries() {
  local binary
  for binary in /usr/bin/docker /usr/bin/getent /usr/bin/git /usr/bin/install \
    /usr/bin/jq /usr/bin/ssh /usr/bin/ssh-keygen /usr/bin/sudo /usr/bin/systemctl \
    /usr/bin/systemd-sysusers /usr/bin/systemd-tmpfiles /usr/sbin/visudo; do
    backup_require_regular_file "$binary" root:root 755
    backup_require_trusted_parent_chain "$binary"
  done
}
verify_installer_binaries

require_root_marker() {
  local path="$1"
  backup_require_regular_file "$path" root:root 600
  backup_require_trusted_parent_chain "$path"
}

preflight_age() {
  backup_require_directory "$CONFIG_DIR" root:root 755
  backup_verify_policy_file "$POLICY_FILE"
  go_file="$CONFIG_DIR/APPROVED_GO_A"
  require_root_marker "$go_file"
  recipient_set_id="$(backup_read_config "$POLICY_FILE" RECIPIENT_SET_ID)"
  recipient_epoch="$(backup_read_config "$POLICY_FILE" RECIPIENT_EPOCH)"
  backup_validate_opaque_id "$recipient_set_id"
  case "$recipient_set_id" in replace-*|*placeholder*)
    backup_die "$BACKUP_EXIT_CONFIG" recipient_set_unapproved ;;
  esac
  printf '%s' "$recipient_epoch" | grep -Eq '^[1-9][0-9]*$' ||
    backup_die "$BACKUP_EXIT_CONFIG" recipient_epoch_invalid
  /usr/bin/jq -e --arg set_id "$recipient_set_id" --argjson epoch "$recipient_epoch" '
    .schema_version == 1 and .approved_go_a == true and .approved_by == "Bruno" and
    .recipient_set_id == $set_id and .recipient_epoch == $epoch
  ' "$go_file" >/dev/null || backup_die "$BACKUP_EXIT_CONFIG" go_a_invalid

  backup_verify_age_binary "$POLICY_FILE" >/dev/null
  backup_verify_age_keygen "$POLICY_FILE" >/dev/null
  backup_verify_recipients "$CONFIG_DIR/recipients.txt"
  backup_require_directory "$CREDENTIAL_DIR" root:root 700
  credential="$CREDENTIAL_DIR/automation.agekey"
  backup_require_regular_file "$credential" root:root 400
  /usr/bin/systemctl start --wait startap-backup-identity-preflight.service ||
    backup_die "$BACKUP_EXIT_CONFIG" identity_preflight_service_failed
  identity_attestation=/var/lib/startap-backup-attestations/identity-preflight.json
  backup_require_directory /var/lib/startap-backup-attestations \
    startap-backup-validator:startap-backup-validator 700
  backup_require_regular_file "$identity_attestation" \
    startap-backup-validator:startap-backup-validator 600
  automation_sha="$(/usr/bin/jq -er '.automation_recipient_sha256' "$identity_attestation")"
  offline_sha="$(/usr/bin/jq -er '.offline_recipient_sha256' "$identity_attestation")"
  /usr/bin/jq -e --arg set_id "$recipient_set_id" --argjson epoch "$recipient_epoch" '
    .schema_version == 1 and .recipient_set_id == $set_id and
    .recipient_epoch == $epoch and .identity_access_via_loadcredential == true and
    (.automation_recipient_sha256 | test("^[a-f0-9]{64}$")) and
    (.offline_recipient_sha256 | test("^[a-f0-9]{64}$"))
  ' "$identity_attestation" >/dev/null ||
    backup_die "$BACKUP_EXIT_CONFIG" identity_preflight_attestation_invalid
  custody="$CONFIG_DIR/recipient-custody-attestation.json"
  require_root_marker "$custody"
  /usr/bin/jq -e --arg set_id "$recipient_set_id" --argjson epoch "$recipient_epoch" \
    --arg automation_sha "$automation_sha" --arg offline_sha "$offline_sha" '
      .schema_version == 1 and .approved_go_a == true and
      .recipient_set_id == $set_id and .recipient_epoch == $epoch and
      .automation_recipient_sha256 == $automation_sha and
      .offline_recipient_sha256 == $offline_sha and .offline_proof_required == true
    ' "$custody" >/dev/null ||
    backup_die "$BACKUP_EXIT_CONFIG" recipient_custody_attestation_invalid
}

preflight_offline_recipient_proof() {
  preflight_age
  proof="$PROOF_ROOT/BRUNO_OFFLINE_PROOF.json"
  require_root_marker "$proof"
  recipient_set_id="$(backup_read_config "$POLICY_FILE" RECIPIENT_SET_ID)"
  recipient_epoch="$(backup_read_config "$POLICY_FILE" RECIPIENT_EPOCH)"
  offline_sha="$(/usr/bin/jq -er '.offline_recipient_sha256' "$CONFIG_DIR/recipient-custody-attestation.json")"
  /usr/bin/jq -e --arg set_id "$recipient_set_id" --argjson epoch "$recipient_epoch" \
    --arg offline_sha "$offline_sha" '
      .schema_version == 1 and .status == "success" and
      .recipient_set_id == $set_id and .recipient_epoch == $epoch and
      .offline_recipient_sha256 == $offline_sha and
      .offline_decrypt_succeeded == true and
      (.artifact_sha256 | test("^[a-f0-9]{64}$")) and
      (.run_id | test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$"))
    ' "$proof" >/dev/null || backup_die "$BACKUP_EXIT_CONFIG" bruno_offline_proof_invalid
}

preflight_offsite() {
  backup_verify_policy_file "$POLICY_FILE"
  go_file="$CONFIG_DIR/APPROVED_GO_B"
  require_root_marker "$go_file"
  deploy_key_id="$(backup_read_config "$POLICY_FILE" DEPLOY_KEY_ID)"
  backup_validate_opaque_id "$deploy_key_id"
  case "$deploy_key_id" in replace-*|*placeholder*)
    backup_die "$BACKUP_EXIT_CONFIG" deploy_key_unapproved ;;
  esac
  /usr/bin/jq -e --arg key_id "$deploy_key_id" '
    .schema_version == 1 and .approved_go_b == true and .approved_by == "Bruno" and
    .key_id == $key_id and .repository == "BrunoMediador/startap-backups"
  ' "$go_file" >/dev/null || backup_die "$BACKUP_EXIT_CONFIG" go_b_invalid
  backup_require_directory "$CREDENTIAL_DIR" root:root 700
  key="$CREDENTIAL_DIR/offsite_deploy_key"
  backup_require_regular_file "$key" root:root 400
  known_hosts="$CONFIG_DIR/github_known_hosts"
  backup_require_regular_file "$known_hosts" root:root 644
  backup_require_trusted_parent_chain "$known_hosts"
  /usr/bin/ssh-keygen -F github.com -f "$known_hosts" >/dev/null ||
    backup_die "$BACKUP_EXIT_CONFIG" known_hosts_target_missing
  /usr/bin/ssh-keygen -l -f "$known_hosts" >/dev/null ||
    backup_die "$BACKUP_EXIT_CONFIG" known_hosts_syntax_invalid
  rendered="$(/usr/bin/ssh -G -F /dev/null -i "$key" \
    -o UserKnownHostsFile="$known_hosts" -o StrictHostKeyChecking=yes \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 \
    -o ConnectionAttempts=1 git@github.com 2>/dev/null)" ||
    backup_die "$BACKUP_EXIT_CONFIG" ssh_effective_config_unreadable
  printf '%s\n' "$rendered" | grep -Eq '^hostname github\.com$' &&
    printf '%s\n' "$rendered" | grep -Eq '^port 22$' &&
    printf '%s\n' "$rendered" | grep -Eq '^user git$' &&
    printf '%s\n' "$rendered" | grep -Eq '^batchmode yes$' &&
    printf '%s\n' "$rendered" | grep -Eq '^identitiesonly yes$' &&
    printf '%s\n' "$rendered" | grep -Eq '^stricthostkeychecking (yes|true)$' &&
    printf '%s\n' "$rendered" | grep -Fqx "userknownhostsfile $known_hosts" ||
    backup_die "$BACKUP_EXIT_UNSAFE" ssh_effective_config_mismatch

  attestation="$CONFIG_DIR/deploy-key-attestation.json"
  require_root_marker "$attestation"
  /usr/bin/jq -e --arg key_id "$deploy_key_id" '
    .schema_version == 1 and .key_id == $key_id and
    .repository == "BrunoMediador/startap-backups" and
    .scope == "single-repository-write" and .vps_only == true and
    .reused_existing_key == false and .approved_go_b == true
  ' "$attestation" >/dev/null || backup_die "$BACKUP_EXIT_CONFIG" deploy_key_attestation_invalid
}

preflight_database_identity() {
  [ "$(backup_read_config "$POLICY_FILE" PG_CONTAINER)" = automacoes-postgres-1 ] &&
    [ "$(backup_read_config "$POLICY_FILE" PG_DATABASE)" = startap_database ] &&
    [ "$(backup_read_config "$POLICY_FILE" PG_USER)" = startap_user ] &&
    [ "$(backup_read_config "$POLICY_FILE" PG_MAJOR)" = 16 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" database_policy_identity_mismatch
  docker_bin=/usr/bin/docker
  backup_require_regular_file "$docker_bin" root:root 755
  backup_require_trusted_parent_chain "$docker_bin"
  identity="$("$docker_bin" container inspect automacoes-postgres-1 \
    --format '{{.Name}}|{{.State.Running}}|{{index .Config.Labels "com.docker.compose.service"}}' \
    2>/dev/null)" || backup_die "$BACKUP_EXIT_UNSAFE" postgres_container_unverified
  [ "$identity" = '/automacoes-postgres-1|true|postgres' ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" postgres_container_identity_mismatch
  database_identity="$("$docker_bin" exec automacoes-postgres-1 psql -U startap_user \
    -d startap_database -v ON_ERROR_STOP=1 -Atqc \
    "SELECT current_database() || ':' || current_user || ':' || current_setting('server_version_num')" \
    2>/dev/null)" || backup_die "$BACKUP_EXIT_UNSAFE" postgres_database_unverified
  printf '%s' "$database_identity" | grep -Eq '^startap_database:startap_user:16[0-9]{4}$' ||
    backup_die "$BACKUP_EXIT_UNSAFE" postgres_database_identity_mismatch
}

preflight_external_ssh() {
  shell_path=/usr/local/libexec/startap-backup/ssh-shell.sh
  backup_require_regular_file "$shell_path" root:root 755
  backup_require_trusted_parent_chain "$shell_path"
  [ "$(/usr/bin/getent passwd startap-backup-status | cut -d: -f7)" = "$shell_path" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" status_account_shell_mismatch
  ssh_dir=/var/lib/startap-backup-status-ssh/.ssh
  auth_keys="$ssh_dir/authorized_keys"
  backup_require_directory "$ssh_dir" startap-backup-status:startap-backup-status 700
  backup_require_regular_file "$auth_keys" startap-backup-status:startap-backup-status 600
  [ "$(grep -Ev '^[[:space:]]*($|#)' "$auth_keys" | wc -l | tr -d ' ')" = 1 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" status_authorized_keys_count_invalid
  grep -Eq '^restrict,command="/usr/local/libexec/startap-backup/external-command\.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 [A-Za-z0-9+/=]+([[:space:]]+[^[:space:]]+)?$' \
    "$auth_keys" || backup_die "$BACKUP_EXIT_UNSAFE" status_authorized_key_restrictions_invalid
}

preflight_legacy_dump_ssh() {
  local shell_path ssh_dir auth_keys
  shell_path=/usr/local/libexec/startap-backup/legacy-dump-shell.sh
  backup_require_regular_file "$shell_path" root:root 755
  backup_require_trusted_parent_chain "$shell_path"
  backup_require_regular_file \
    /usr/local/libexec/startap-backup/legacy-dump-command.sh root:root 755
  backup_require_regular_file \
    /usr/local/libexec/startap-backup/legacy-dump-helper.sh root:root 755
  [ "$(/usr/bin/getent passwd startap-backup-legacy-dump | cut -d: -f7)" = "$shell_path" ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" legacy_dump_account_shell_mismatch
  ssh_dir=/var/lib/startap-backup-legacy-ssh/.ssh
  auth_keys="$ssh_dir/authorized_keys"
  backup_require_directory "$ssh_dir" \
    startap-backup-legacy-dump:startap-backup-legacy-dump 700
  backup_require_regular_file "$auth_keys" \
    startap-backup-legacy-dump:startap-backup-legacy-dump 600
  [ "$(grep -Ev '^[[:space:]]*($|#)' "$auth_keys" | wc -l | tr -d ' ')" = 1 ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" legacy_dump_authorized_keys_count_invalid
  grep -Eq '^restrict,command="/usr/local/libexec/startap-backup/legacy-dump-command\.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 [A-Za-z0-9+/=]+([[:space:]]+[^[:space:]]+)?$' \
    "$auth_keys" || backup_die "$BACKUP_EXIT_UNSAFE" legacy_dump_authorized_key_restrictions_invalid
}

# GitHub Environment protection is an external control and therefore cannot be
# proven by this repository's YAML.  Activation consumes a root-owned,
# operator-captured API attestation; the installer never fabricates it.
preflight_github_environments() {
  local proof
  proof="$CONFIG_DIR/GITHUB_ENVIRONMENT_PROOF.json"
  require_root_marker "$proof"
  "$SCRIPT_DIR/github-environment-verify.sh" "$proof" >/dev/null
}

preflight() {
  preflight_age
  preflight_offsite
  preflight_database_identity
  [ -d /var/lib/startap-backup-uploader/repository/.git ] ||
    backup_die "$BACKUP_EXIT_CONFIG" offsite_checkout_missing
  [ "$(/usr/bin/git -C /var/lib/startap-backup-uploader/repository remote get-url origin)" = \
    git@github.com:BrunoMediador/startap-backups.git ] ||
    backup_die "$BACKUP_EXIT_UNSAFE" offsite_remote_mismatch
  preflight_legacy_dump_ssh
  backup_log info activation_preflight_passed
}

case "$action" in
  stage)
    /usr/bin/install -d -o root -g root -m 0755 /usr/local/libexec/startap-backup
    for script in "$SCRIPT_DIR"/*.sh "$SCRIPT_DIR"/*.py; do
      /usr/bin/install -o root -g root -m 0755 "$script" "/usr/local/libexec/startap-backup/$(basename "$script")"
    done
    /usr/bin/install -o root -g root -m 0644 "$UNIT_SOURCE/startap-backup.sysusers" /usr/lib/sysusers.d/startap-backup.conf
    /usr/bin/systemd-sysusers /usr/lib/sysusers.d/startap-backup.conf
    /usr/bin/install -d -o root -g root -m 0755 "$CONFIG_DIR"
    /usr/bin/install -d -o root -g root -m 0700 "$CREDENTIAL_DIR"
    /usr/bin/install -o root -g root -m 0644 "$UNIT_SOURCE/startap-backup.tmpfiles" /usr/lib/tmpfiles.d/startap-backup.conf
    /usr/bin/systemd-tmpfiles --create /usr/lib/tmpfiles.d/startap-backup.conf
    /usr/bin/install -o root -g root -m 0440 "$UNIT_SOURCE/startap-backup.sudoers" /etc/sudoers.d/startap-backup
    /usr/sbin/visudo -cf /etc/sudoers.d/startap-backup >/dev/null
    for unit in "$UNIT_SOURCE"/*.service "$UNIT_SOURCE"/*.timer "$UNIT_SOURCE"/*.path; do
      /usr/bin/install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename "$unit")"
    done
    /usr/bin/systemctl daemon-reload
    backup_log info installation_staged "services_enabled=false"
    ;;
  preflight) preflight ;;
  prepare-offsite)
    preflight_offsite
    [ ! -e /var/lib/startap-backup-uploader/repository ] ||
      backup_die "$BACKUP_EXIT_INTEGRITY" offsite_checkout_target_exists
    /usr/bin/systemctl start --wait startap-backup-offsite-prepare.service ||
      backup_die "$BACKUP_EXIT_TRANSIENT" offsite_prepare_service_failed
    ;;
  arm)
    preflight
    /usr/bin/install -o root -g root -m 0600 /dev/null "$CONFIG_DIR/ENABLED"
    /usr/bin/systemctl enable --now startap-backup-drill-reconcile.service ||
      backup_die "$BACKUP_EXIT_INTEGRITY" drill_boot_reconciler_enable_failed
    /usr/bin/systemctl disable --now startap-backup-upload.timer >/dev/null 2>&1 || true
    rm -f -- "$CONFIG_DIR/OFFSITE_WRITER_ENABLED"
    backup_log info controlled_manual_window_armed "timers_enabled=false" "uploader_enabled=false"
    ;;
  activate)
    preflight
    preflight_offline_recipient_proof
    require_root_marker "$CONFIG_DIR/ENABLED"
    proof="$PROOF_ROOT/REAL_ARTIFACT_PROOF.json"
    require_root_marker "$proof"
    /usr/bin/jq -e '.schema_version == 1 and .status == "success" and
      .automation_decrypt == true and .postgres_major == 16 and
      .production_target == false and .teardown_complete == true' "$proof" >/dev/null ||
      backup_die "$BACKUP_EXIT_CONFIG" real_drill_proof_invalid
    rollout="$PROOF_ROOT/ROLLOUT_PROOF.json"
    require_root_marker "$rollout"
    /usr/bin/jq -e '.schema_version == 1 and .consecutive_local_successes >= 2 and
      .security_green == true and .qa_green == true' "$rollout" >/dev/null ||
      backup_die "$BACKUP_EXIT_CONFIG" rollout_proof_invalid
    [ ! -e "$CONFIG_DIR/OFFSITE_WRITER_ENABLED" ] ||
      backup_die "$BACKUP_EXIT_UNSAFE" shadow_rollout_writer_already_enabled
    /usr/bin/systemctl disable --now startap-backup-upload.timer >/dev/null 2>&1 || true
    /usr/bin/systemctl enable --now startap-backup-drill-reconcile.service ||
      backup_die "$BACKUP_EXIT_INTEGRITY" drill_boot_reconciler_enable_failed
    /usr/bin/systemctl enable --now startap-backup-producer.timer \
      startap-backup-freshness.timer startap-backup-drill.timer
    backup_log info shadow_timers_activated "legacy_writer=true" "uploader_enabled=false"
    ;;
  activate-uploader)
    preflight
    preflight_github_environments
    require_root_marker "$CONFIG_DIR/ENABLED"
    cutover="$CONFIG_DIR/LEGACY_WRITER_DISABLED_PROOF.json"
    require_root_marker "$cutover"
    /usr/bin/jq -e '.schema_version == 1 and .legacy_schedule_disabled == true and
      .legacy_manual_dispatch_available == true and .repository == "BrunoMediador/startap-platform"' \
      "$cutover" >/dev/null || backup_die "$BACKUP_EXIT_CONFIG" legacy_writer_cutover_proof_invalid
    /usr/bin/install -o root -g root -m 0600 /dev/null "$CONFIG_DIR/OFFSITE_WRITER_ENABLED"
    /usr/bin/systemctl enable --now startap-backup-upload.timer
    backup_log info offsite_writer_activated "legacy_writer=false"
    ;;
  enable-dispatch)
    preflight
    preflight_github_environments
    preflight_external_ssh
    preflight_offline_recipient_proof
    require_root_marker "$PROOF_ROOT/REAL_ARTIFACT_PROOF.json"
    /usr/bin/install -o root -g root -m 0600 /dev/null "$CONFIG_DIR/DRILL_DISPATCH_ENABLED"
    backup_log info drill_dispatch_enabled
    ;;
  *) usage ;;
esac
