#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" offsite_prepare_arguments_refused
[ "$(id -un)" = startap-backup-upload ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" offsite_prepare_user_identity_mismatch
[ -n "${CREDENTIALS_DIRECTORY:-}" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" credentials_directory_missing

CONFIG_DIR=/etc/startap-backup
POLICY_FILE="$CONFIG_DIR/policy.conf"
KNOWN_HOSTS_FILE="$CONFIG_DIR/github_known_hosts"
DEPLOY_KEY="$CREDENTIALS_DIRECTORY/offsite_deploy_key"
UPLOADER_ROOT=/var/lib/startap-backup-uploader
REPOSITORY="$UPLOADER_ROOT/repository"

backup_verify_policy_file "$POLICY_FILE"
[ "$(backup_read_config "$POLICY_FILE" OFFSITE_REPOSITORY)" = BrunoMediador/startap-backups ] &&
  [ "$(backup_read_config "$POLICY_FILE" OFFSITE_BRANCH)" = main ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" offsite_prepare_policy_mismatch
backup_require_directory "$UPLOADER_ROOT" startap-backup-upload:startap-backup-upload 700
backup_require_regular_file "$KNOWN_HOSTS_FILE" root:root 644
backup_require_trusted_parent_chain "$KNOWN_HOSTS_FILE"
[ ! -L "$DEPLOY_KEY" ] && [ -f "$DEPLOY_KEY" ] && [ -r "$DEPLOY_KEY" ] ||
  backup_die "$BACKUP_EXIT_CONFIG" deploy_key_unreadable
[ ! -e "$REPOSITORY" ] || backup_die "$BACKUP_EXIT_INTEGRITY" offsite_checkout_target_exists
grep -Eq '^github\.com[[:space:]]+ssh-ed25519[[:space:]]+' "$KNOWN_HOSTS_FILE" ||
  backup_die "$BACKUP_EXIT_CONFIG" known_hosts_target_missing

export GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/false
export GIT_SSH_COMMAND="/usr/bin/ssh -F /dev/null -i $DEPLOY_KEY -o UserKnownHostsFile=$KNOWN_HOSTS_FILE -o StrictHostKeyChecking=yes -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -o ConnectionAttempts=1"
error_file="$UPLOADER_ROOT/offsite-prepare.err"
trap 'rm -f -- "$error_file"' EXIT INT TERM HUP
set +e
/usr/bin/timeout --signal=TERM --kill-after=10s 15m /usr/bin/git clone \
  --branch main --single-branch git@github.com:BrunoMediador/startap-backups.git \
  "$REPOSITORY" 2>"$error_file"
clone_exit=$?
set -e
if [ "$clone_exit" -ne 0 ]; then
  case "$clone_exit" in 124) event=offsite_prepare_timeout ;; *) event=offsite_prepare_failed ;; esac
  rm -f -- "$error_file"
  backup_die "$BACKUP_EXIT_TRANSIENT" "$event"
fi
rm -f -- "$error_file"
[ "$(/usr/bin/git -C "$REPOSITORY" remote get-url origin)" = \
  git@github.com:BrunoMediador/startap-backups.git ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" offsite_remote_mismatch
chmod 0700 "$REPOSITORY"
backup_log info offsite_checkout_prepared "uploader_enabled=false"
