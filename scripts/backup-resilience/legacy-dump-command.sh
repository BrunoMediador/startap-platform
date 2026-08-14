#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "${SSH_ORIGINAL_COMMAND:-}" = dump ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" legacy_dump_command_refused
[ "$#" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" legacy_dump_arguments_refused

if backup_is_test; then
  exec "$SCRIPT_DIR/legacy-dump-helper.sh"
fi
[ "$(id -un)" = startap-backup-legacy-dump ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" legacy_dump_user_mismatch
exec /usr/bin/sudo -n /usr/local/libexec/startap-backup/legacy-dump-helper.sh
