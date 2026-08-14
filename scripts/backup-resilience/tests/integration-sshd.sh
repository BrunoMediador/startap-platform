#!/usr/bin/env bash
set -Eeuo pipefail
TEST_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SCRIPT_DIR="$(CDPATH='' cd -- "$TEST_DIR/.." && pwd)"

if [ ! -x /usr/sbin/sshd ]; then
  printf 'TAP version 13\n'
  printf 'ok 1 - restricted forced-command login # SKIP sshd unavailable\n'
  printf 'ok 2 - arbitrary shell command refused # SKIP sshd unavailable\n'
  printf 'ok 3 - legacy dump-only forced command # SKIP sshd unavailable\n'
  printf 'ok 4 - legacy arbitrary command refused # SKIP sshd unavailable\n'
  printf '1..4\n'
  exit 0
fi

root="$(mktemp -d /tmp/startap-sshd-integration.XXXXXX)"
sshd_pid=""
cleanup() {
  set +e
  [ -z "$sshd_pid" ] || kill -TERM "$sshd_pid" 2>/dev/null
  [ -z "$sshd_pid" ] || wait "$sshd_pid" 2>/dev/null
  case "$root" in /tmp/startap-sshd-integration.*) find "$root" -depth -delete 2>/dev/null ;; esac
}
trap cleanup EXIT INT TERM HUP

port=$((22000 + $$ % 20000))
ssh-keygen -q -t ed25519 -N '' -f "$root/host_key"
ssh-keygen -q -t ed25519 -N '' -f "$root/client_key"
ssh-keygen -q -t ed25519 -N '' -f "$root/legacy_key"
public_key="$(awk '{print $1 " " $2}' "$root/client_key.pub")"
legacy_public_key="$(awk '{print $1 " " $2}' "$root/legacy_key.pub")"
forced="$SCRIPT_DIR/ssh-shell.sh -c $SCRIPT_DIR/external-command.sh"
printf '%s\n' '-- PostgreSQL database dump' \
  'CREATE TABLE public.fixture_table (id bigint PRIMARY KEY);' \
  '-- PostgreSQL database dump complete' >"$root/fixture.sql"
legacy_forced="STARTAP_BACKUP_TEST_MODE=1 STARTAP_BACKUP_FIXTURE_SQL=$root/fixture.sql $SCRIPT_DIR/legacy-dump-shell.sh -c $SCRIPT_DIR/legacy-dump-command.sh"
printf 'restrict,command="%s",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding %s fixture\n' \
  "$forced" "$public_key" >"$root/authorized_keys"
printf 'restrict,command="%s",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding %s legacy-fixture\n' \
  "$legacy_forced" "$legacy_public_key" >>"$root/authorized_keys"
printf '[127.0.0.1]:%s %s\n' "$port" "$(awk '{print $1 " " $2}' "$root/host_key.pub")" \
  >"$root/known_hosts"
chmod 0600 "$root/authorized_keys" "$root/known_hosts" "$root/client_key" "$root/legacy_key" "$root/host_key"

printf '%s\n' \
  "Port $port" \
  'ListenAddress 127.0.0.1' \
  "HostKey $root/host_key" \
  "PidFile $root/sshd.pid" \
  "AuthorizedKeysFile $root/authorized_keys" \
  "AllowUsers $(id -un)" \
  'StrictModes no' \
  'PubkeyAuthentication yes' \
  'PasswordAuthentication no' \
  'KbdInteractiveAuthentication no' \
  'ChallengeResponseAuthentication no' \
  'UsePAM no' \
  'PermitRootLogin no' \
  'AllowAgentForwarding no' \
  'AllowTcpForwarding no' \
  'PermitTTY no' \
  'X11Forwarding no' \
  'PermitUserEnvironment no' \
  'UseDNS no' \
  'LogLevel ERROR' >"$root/sshd_config"

/usr/sbin/sshd -t -f "$root/sshd_config"
/usr/sbin/sshd -D -e -f "$root/sshd_config" >"$root/sshd.log" 2>&1 &
sshd_pid=$!
ready=0
for _ in $(seq 1 100); do
  if nc -z 127.0.0.1 "$port" >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$sshd_pid" 2>/dev/null || break
  sleep 0.02
done
[ "$ready" = 1 ] || { sed -n '1,5p' "$root/sshd.log" >&2; exit 1; }

ssh_fixture() {
  ssh -F /dev/null -p "$port" -i "$root/client_key" \
    -o UserKnownHostsFile="$root/known_hosts" -o StrictHostKeyChecking=yes \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=2 \
    "$(id -un)@127.0.0.1" "$@"
}
legacy_ssh_fixture() {
  ssh -F /dev/null -p "$port" -i "$root/legacy_key" \
    -o UserKnownHostsFile="$root/known_hosts" -o StrictHostKeyChecking=yes \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=2 \
    "$(id -un)@127.0.0.1" "$@"
}

printf 'TAP version 13\n'
set +e; output="$(ssh_fixture arbitrary 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ] && printf '%s' "$output" | grep -Fq 'event=external_command_refused'
! printf '%s' "$output" | grep -Fq 'event=restricted_shell_refused'
printf 'ok 1 - restricted forced-command login reaches exact wrapper\n'

set +e; output="$(ssh_fixture 'sh -c id' 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ] && printf '%s' "$output" | grep -Fq 'event=external_command_refused'
! printf '%s' "$output" | grep -Eq 'uid=|gid='
printf 'ok 2 - arbitrary shell command is refused without execution\n'

legacy_ssh_fixture dump >"$root/legacy-result.sql"
cmp -s "$root/fixture.sql" "$root/legacy-result.sql"
printf 'ok 3 - legacy key streams only fixed artificial dump\n'

set +e; output="$(legacy_ssh_fixture 'dump; id' 2>&1)"; code=$?; set -e
[ "$code" -ne 0 ] && printf '%s' "$output" | grep -Fq 'event=legacy_dump_command_refused'
! printf '%s' "$output" | grep -Eq 'uid=|gid='
printf 'ok 4 - legacy arbitrary command is refused without shell execution\n'
printf '1..4\n'
