#!/usr/bin/env bash
set -Eeuo pipefail

readonly SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
readonly FORCED_COMMAND="$SCRIPT_DIR/legacy-dump-command.sh"
if [ "$#" = 2 ] && [ "$1" = -c ] && [ "$2" = "$FORCED_COMMAND" ]; then
  exec "$FORCED_COMMAND"
fi
printf 'backup level=error event=legacy_dump_shell_refused\n' >&2
exit 66
