#!/usr/bin/env bash
set -Eeuo pipefail
TEST_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SCRIPT_DIR="$(CDPATH='' cd -- "$TEST_DIR/.." && pwd)"
GATE="$TEST_DIR/integration-sshd.sh"

# Prova dinâmica da reconciliação de órfãos do gate SSHD (SCRUM-167 follow-up:
# 4 sshd órfãos root sobreviveram a SIGKILL entre execuções na VPS). Só roda
# root + sshd real, igual ao gate que exercita: sem isso não há como
# criar/matar sshd de verdade nem provar o guard-rail contra o sshd real.
if [ "$(id -u)" != 0 ] || [ ! -x /usr/sbin/sshd ]; then
  printf 'TAP version 13\n'
  printf 'ok 1 - guard-rail never matches the real production sshd # SKIP requires root+sshd\n'
  printf 'ok 2 - guard-rail never matches an sshd with a foreign -f path # SKIP requires root+sshd\n'
  printf 'ok 3 - orphan reconciliation cleans previous SIGKILL and next run passes 4/4 # SKIP requires root+sshd\n'
  printf '1..3\n'
  exit 0
fi

# Reusa a função de matching exata do gate — nunca uma reimplementação que
# possa divergir e mascarar o guard-rail.
# shellcheck disable=SC1090
. <(sed -n '/^reconcile_sshd_orphan_pid()/,/^}/p' "$GATE")

printf 'TAP version 13\n'

# --- Teste 1: guard-rail nunca casa o sshd real de produção ---------------
real_pid=""
if command -v systemctl >/dev/null 2>&1; then
  real_pid="$(systemctl show -p MainPID ssh 2>/dev/null | cut -d= -f2)"
fi
if [ -z "$real_pid" ] || [ "$real_pid" = 0 ]; then
  real_pid="$(pgrep -x sshd | head -n1 || true)"
fi
if [ -z "$real_pid" ]; then
  printf 'ok 1 - guard-rail never matches the real production sshd # SKIP no live sshd found to test against\n'
else
  ! reconcile_sshd_orphan_pid "$real_pid"
  printf 'ok 1 - guard-rail never matches the real production sshd (pid=%s)\n' "$real_pid"
fi

# --- Teste 2: guard-rail nunca casa sshd com -f fora do padrão exato ------
foreign_root="$(mktemp -d /tmp/startap-sshd-foreign-check.XXXXXX)"
foreign_pid=""
cleanup_foreign() {
  set +e
  [ -z "$foreign_pid" ] || kill -TERM "$foreign_pid" 2>/dev/null
  [ -z "$foreign_pid" ] || wait "$foreign_pid" 2>/dev/null
  case "$foreign_root" in /tmp/startap-sshd-foreign-check.*) find "$foreign_root" -depth -delete 2>/dev/null ;; esac
}
trap cleanup_foreign EXIT INT TERM HUP
ssh-keygen -q -t ed25519 -N '' -f "$foreign_root/host_key"
foreign_port=$((23000 + $$ % 2000))
printf '%s\n' \
  "Port $foreign_port" 'ListenAddress 127.0.0.1' "HostKey $foreign_root/host_key" \
  "PidFile $foreign_root/sshd.pid" 'PasswordAuthentication no' 'PermitRootLogin no' \
  'UsePAM no' 'LogLevel ERROR' >"$foreign_root/sshd_config"
/usr/sbin/sshd -t -f "$foreign_root/sshd_config"
/usr/sbin/sshd -D -e -f "$foreign_root/sshd_config" >"$foreign_root/sshd.log" 2>&1 &
foreign_pid=$!
for _ in $(seq 1 100); do nc -z 127.0.0.1 "$foreign_port" >/dev/null 2>&1 && break; sleep 0.02; done
! reconcile_sshd_orphan_pid "$foreign_pid"
kill -TERM "$foreign_pid" 2>/dev/null; wait "$foreign_pid" 2>/dev/null || true
foreign_pid=""
trap - EXIT INT TERM HUP
cleanup_foreign
printf 'ok 2 - guard-rail never matches an sshd with a foreign -f path\n'

# --- Teste 3: SIGKILL mid-run deixa sshd órfão; a próxima execução do gate
# reconcilia sozinha (mata só o órfão, nunca o sshd real) e passa 4/4 ------
"$GATE" >/tmp/startap-sshd-reconcile-drill.out 2>&1 &
drill_pid=$!
observed=""
for _ in $(seq 1 200); do
  candidate="$(pgrep -f -a '/usr/sbin/sshd -D -e -f /tmp/startap-sshd-integration\.' 2>/dev/null |
    awk '{print $1}' | head -n1 || true)"
  [ -n "$candidate" ] && { observed=1; orphan_sshd_pid="$candidate"; break; }
  kill -0 "$drill_pid" 2>/dev/null || break
  sleep 0.01
done
[ -n "$observed" ] || { printf 'Bail out! could not observe sshd fixture before SIGKILL\n' >&2; exit 1; }
kill -KILL "$drill_pid" 2>/dev/null
wait "$drill_pid" 2>/dev/null || true
kill -0 "$orphan_sshd_pid" 2>/dev/null || {
  printf 'Bail out! orphan sshd (pid=%s) already gone before assertion\n' "$orphan_sshd_pid" >&2
  exit 1
}
orphan_raw="$(tr '\0' ' ' <"/proc/$orphan_sshd_pid/cmdline" 2>/dev/null)"
orphan_config="${orphan_raw#*-f }"
orphan_config="${orphan_config%% *}"
orphan_dir="${orphan_config%/sshd_config}"
case "$orphan_dir" in
  /tmp/startap-sshd-integration.*) ;;
  *) printf 'Bail out! could not resolve orphan tmpdir from cmdline (%s)\n' "$orphan_config" >&2; exit 1 ;;
esac

real_pid_after="$real_pid"
if [ -n "$real_pid_after" ]; then kill -0 "$real_pid_after" 2>/dev/null; fi

second_output="$("$GATE" 2>&1)"; second_code=$?
[ "$second_code" = 0 ]
printf '%s\n' "$second_output" | grep -Fq 'ok 1 - restricted forced-command login reaches exact wrapper'
printf '%s\n' "$second_output" | grep -Fq '1..4'
! kill -0 "$orphan_sshd_pid" 2>/dev/null
[ ! -e "$orphan_dir" ]
[ -z "$real_pid_after" ] || kill -0 "$real_pid_after" 2>/dev/null
printf 'ok 3 - orphan reconciliation cleans previous SIGKILL and next run passes 4/4\n'

printf '1..3\n'
