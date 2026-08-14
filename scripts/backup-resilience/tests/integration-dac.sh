#!/usr/bin/env bash
set -Eeuo pipefail

printf 'TAP version 13\n'
if [ "$(uname -s)" != Linux ] || [ "$(id -u)" != 0 ] || ! command -v setpriv >/dev/null 2>&1; then
  printf 'ok 1 - producer reaches only its private runtime and outbound bridge # SKIP Linux root plus setpriv required\n'
  printf 'ok 2 - capless cycle reads bridge but not producer plaintext # SKIP Linux root plus setpriv required\n'
  printf 'ok 3 - producer cannot read credentials or mutate cycle bridge # SKIP Linux root plus setpriv required\n'
  printf '1..3\n'
  exit 0
fi

root="$(mktemp -d /tmp/startap-backup-dac.XXXXXX)"
trap 'find "$root" -xdev -depth -delete 2>/dev/null || true' EXIT INT TERM HUP
producer_uid=$((60000 + $$ % 1000))
producer_gid=$((61000 + $$ % 1000))
bridge_gid=$((62000 + $$ % 1000))
# mktemp starts at 0700, which would make every synthetic-UID assertion fail
# before it reached the boundary under test. The parent is root-owned and
# traverse-only; each child below carries the actual trust-boundary mode.
chown 0:0 "$root"
chmod 0711 "$root"
mkdir -p "$root/producer-private" "$root/producer-bridge" \
  "$root/cycle-private" "$root/cycle-bridge" "$root/credentials"
chown "$producer_uid:$producer_gid" "$root/producer-private"
chown "$producer_uid:$bridge_gid" "$root/producer-bridge"
chown 0:0 "$root/cycle-private" "$root/credentials"
chown "0:$bridge_gid" "$root/cycle-bridge"
chmod 0700 "$root/producer-private" "$root/cycle-private" "$root/credentials"
chmod 0750 "$root/producer-bridge" "$root/cycle-bridge"
printf 'fixture-credential-never-logged\n' >"$root/credentials/automation.agekey"
printf 'reconciled\n' >"$root/cycle-bridge/reconcile-complete"
chmod 0600 "$root/credentials/automation.agekey"
chmod 0640 "$root/cycle-bridge/reconcile-complete"
chown "0:$bridge_gid" "$root/cycle-bridge/reconcile-complete"

setpriv --reuid="$producer_uid" --regid="$producer_gid" --groups="$bridge_gid" \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
  /bin/sh -c 'umask 077; printf plaintext >"$1/producer-private/dump.sql"; printf ready >"$1/producer-bridge/ready-run"; chmod 0640 "$1/producer-bridge/ready-run"; chgrp "$2" "$1/producer-bridge/ready-run"; printf yes >"$1/producer-private/producer-expected-ran"' \
  fixture "$root" "$bridge_gid"
[ "$(stat -c %u "$root/producer-private/dump.sql")" = "$producer_uid" ]
[ "$(cat "$root/producer-private/producer-expected-ran")" = yes ]
printf 'ok 1 - producer reaches only its private runtime and outbound bridge\n'

value="$(setpriv --reuid=0 --regid=0 --groups="$bridge_gid" \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
  /bin/sh -c 'value="$(cat "$1/producer-bridge/ready-run")"; if cat "$1/producer-private/dump.sql" >/dev/null 2>&1; then exit 1; fi; printf yes >"$1/cycle-private/cycle-assertions-ran"; printf "%s" "$value"' \
  fixture "$root")"
[ "$value" = ready ]
[ "$(cat "$root/cycle-private/cycle-assertions-ran")" = yes ]
printf 'ok 2 - capless cycle reads bridge but not producer plaintext\n'

setpriv --reuid="$producer_uid" --regid="$producer_gid" --groups="$bridge_gid" \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- \
  /bin/sh -c 'test ! -r "$1/credentials/automation.agekey"; test -r "$1/cycle-bridge/reconcile-complete"; test ! -w "$1/cycle-bridge/reconcile-complete"; if { printf mutation >>"$1/cycle-bridge/reconcile-complete"; } 2>/dev/null; then exit 1; fi; if ls "$1" >/dev/null 2>&1; then exit 1; fi; printf yes >"$1/producer-private/producer-assertions-ran"' \
  fixture "$root"
[ "$(cat "$root/producer-private/producer-assertions-ran")" = yes ]
[ "$(cat "$root/cycle-bridge/reconcile-complete")" = reconciled ]
printf 'ok 3 - producer cannot read credentials or mutate cycle bridge\n'
printf '1..3\n'
