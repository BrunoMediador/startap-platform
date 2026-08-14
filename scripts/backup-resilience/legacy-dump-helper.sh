#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

[ "$#" = 0 ] || backup_die "$BACKUP_EXIT_UNSAFE" legacy_dump_helper_arguments_refused
if backup_is_test; then
  fixture="${STARTAP_BACKUP_FIXTURE_SQL:-}"
  [ -n "$fixture" ] && [ ! -L "$fixture" ] && [ -f "$fixture" ] ||
    backup_die "$BACKUP_EXIT_CONFIG" fixture_missing
  exec /bin/cat -- "$fixture"
fi

[ "$(id -u)" = 0 ] && [ "${SUDO_USER:-}" = startap-backup-legacy-dump ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" legacy_dump_helper_identity_mismatch
docker_bin=/usr/bin/docker
backup_require_regular_file "$docker_bin" root:root 755
backup_require_trusted_parent_chain "$docker_bin"
identity="$($docker_bin container inspect automacoes-postgres-1 \
  --format '{{.Name}}|{{.State.Running}}|{{index .Config.Labels "com.docker.compose.service"}}' \
  2>/dev/null)" || backup_die "$BACKUP_EXIT_UNSAFE" postgres_container_unverified
[ "$identity" = '/automacoes-postgres-1|true|postgres' ] ||
  backup_die "$BACKUP_EXIT_UNSAFE" postgres_container_identity_mismatch
database_identity="$($docker_bin exec automacoes-postgres-1 psql \
  -U startap_user -d startap_database -v ON_ERROR_STOP=1 -Atqc \
  "SELECT current_database() || ':' || current_user || ':' || current_setting('server_version_num')" \
  2>/dev/null)" || backup_die "$BACKUP_EXIT_UNSAFE" postgres_database_unverified
printf '%s' "$database_identity" | grep -Eq '^startap_database:startap_user:16[0-9]{4}$' ||
  backup_die "$BACKUP_EXIT_UNSAFE" postgres_database_identity_mismatch

error_file=/run/startap-backup-legacy-dump/dump.err
mkdir -p -- /run/startap-backup-legacy-dump
chmod 0700 /run/startap-backup-legacy-dump
: >"$error_file"
chmod 0600 "$error_file"
set +e
/usr/bin/timeout --signal=TERM --kill-after=30s 31m \
  "$docker_bin" exec automacoes-postgres-1 pg_dump \
    -U startap_user -d startap_database --format=p --no-owner --no-privileges \
    2>"$error_file"
dump_exit=$?
set -e
rm -f -- "$error_file"
[ "$dump_exit" = 0 ] || backup_die "$BACKUP_EXIT_TRANSIENT" legacy_pg_dump_failed
