#!/usr/bin/env bash
set -Eeuo pipefail
TEST_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SCRIPT_DIR="$(CDPATH='' cd -- "$TEST_DIR/.." && pwd)"

# Reconciliação de órfãos do próprio gate. O trap EXIT/INT/TERM/HUP não cobre
# SIGKILL (ex.: matar o gate no meio de uma execução anterior) — sobra sshd
# root vivo em LISTEN em porta de loopback, além de tmpdir/conta órfãos.
# Roda ANTES de qualquer trabalho novo, mesmo padrão do docker-reconcile.sh:
# probe primeiro, mata só o que casa a forma exata deste gate, nunca um match
# largo. Lê /proc/<pid>/cmdline (NUL-delimited) em vez de `ps`/`grep -f` sobre
# a lista de processos do shell atual — grep sobre `ps aux` casa o próprio
# comando de busca (foi o erro do QA que relatou "0 residuais" errado).
#
# OpenSSH reescreve o proctitle assim que o processo assume o papel de
# listener: /proc/<pid>/cmdline deixa de ser o argv exec original
# (["/usr/sbin/sshd","-D","-e","-f",path]) e vira UM ÚNICO elemento
# "sshd: /usr/sbin/sshd -D -e -f <path> [listener] N of M startups"
# (confirmado ao vivo na VPS, inclusive no sshd real de produção). Por isso
# casamos a STRING BRUTA (join dos argv por espaço) com um prefixo fixo e
# extraímos o path do -f por glob — nunca por argv[N] posicional, que
# depende de qual dos dois formatos o kernel expõe no instante da checagem.
reconcile_sshd_orphan_pid() {
  local pid="$1" raw has_dash_f=0 config_path=""
  [ -r "/proc/$pid/cmdline" ] || return 1
  raw="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)" || return 1
  case "$raw" in
    '/usr/sbin/sshd -D -e -f '*|'sshd: /usr/sbin/sshd -D -e -f '*) ;;
    *) return 1 ;;
  esac
  config_path="${raw#*-f }"
  config_path="${config_path%% *}"
  case "$config_path" in
    /tmp/startap-sshd-integration.*/sshd_config) has_dash_f=1 ;;
  esac
  [ "$has_dash_f" = 1 ]
}
reconcile_orphans() {
  [ "$(id -u)" = 0 ] || return 0
  local pid killed=0
  for pid_path in /proc/[0-9]*; do
    pid="${pid_path#/proc/}"
    [ "$pid" != "$$" ] || continue
    reconcile_sshd_orphan_pid "$pid" || continue
    kill -TERM "$pid" 2>/dev/null && killed=1
  done
  if [ "$killed" = 1 ]; then
    for _ in $(seq 1 50); do
      still=0
      for pid_path in /proc/[0-9]*; do
        pid="${pid_path#/proc/}"
        [ "$pid" != "$$" ] || continue
        reconcile_sshd_orphan_pid "$pid" || continue
        still=1
      done
      [ "$still" = 0 ] && break
      sleep 0.02
    done
  fi
  if command -v getent >/dev/null 2>&1 && command -v userdel >/dev/null 2>&1; then
    getent passwd | awk -F: '$1 ~ /^startap-sshd-it-[0-9]+$/ { print $1 }' |
      while IFS= read -r orphan_user; do userdel "$orphan_user" 2>/dev/null || true; done
  fi
  for dir in /tmp/startap-sshd-integration.*; do
    [ -e "$dir" ] || continue
    case "$dir" in /tmp/startap-sshd-integration.*) find "$dir" -depth -delete 2>/dev/null ;; esac
  done
}
reconcile_orphans

if [ ! -x /usr/sbin/sshd ]; then
  printf 'TAP version 13\n'
  printf 'ok 1 - restricted forced-command login # SKIP sshd unavailable\n'
  printf 'ok 2 - arbitrary shell command refused # SKIP sshd unavailable\n'
  printf 'ok 3 - legacy dump-only forced command # SKIP sshd unavailable\n'
  printf 'ok 4 - legacy arbitrary command refused # SKIP sshd unavailable\n'
  printf '1..4\n'
  exit 0
fi

# Produção nunca autentica como root nesta fronteira (contas dedicadas
# startap-backup-status/startap-backup-legacy-dump, ver sysusers). Quando o
# runner do gate É root (VPS root-only), testar a autenticação sob root
# contradiz 'PermitRootLogin no' e mascararia a fronteira real medida em
# produção. Cria um usuário de sistema descartável para autenticar como não-root,
# preservando 'PermitRootLogin no' com o mesmo significado que em produção.
test_user=""
if [ "$(id -u)" = 0 ]; then
  if ! command -v useradd >/dev/null 2>&1 || ! command -v userdel >/dev/null 2>&1 ||
    ! command -v runuser >/dev/null 2>&1; then
    printf 'Bail out! root runner requires useradd/userdel/runuser to test as non-root\n' >&2
    exit 1
  fi
  test_user="startap-sshd-it-$$"
fi

root="$(mktemp -d /tmp/startap-sshd-integration.XXXXXX)"
sshd_pid=""
cleanup() {
  set +e
  [ -z "$sshd_pid" ] || kill -TERM "$sshd_pid" 2>/dev/null
  [ -z "$sshd_pid" ] || wait "$sshd_pid" 2>/dev/null
  [ -z "$test_user" ] || userdel "$test_user" 2>/dev/null
  case "$root" in /tmp/startap-sshd-integration.*) find "$root" -depth -delete 2>/dev/null ;; esac
}
trap cleanup EXIT INT TERM HUP

if [ -n "$test_user" ]; then
  # Shell /usr/sbin/nologin recusa a sessão ANTES do ForceCommand do
  # authorized_keys rodar ("This account is currently not available"),
  # mascarando os 4 asserts. A conta real de produção evita nologin pelo
  # mesmo motivo (ver docs/runbooks/backup-resilience-setup.md, seção
  # "Usuário SSH de status"): usa /bin/sh só como login shell válido — o
  # forced command="..." do authorized_keys é o único caminho de execução
  # em todos os casos exercitados (nunca cai no shell interativo).
  useradd --system --no-create-home --home-dir "$root" --shell /bin/sh "$test_user"
  # useradd deixa a senha travada (shadow '!') por padrão; sshd recusa
  # qualquer método de auth (inclusive pubkey) para conta trancada mesmo com
  # PasswordAuthentication no. passwd -d zera a senha (NULL) sem travar a
  # conta; PasswordAuthentication/KbdInteractiveAuthentication no já barram
  # auth por senha, então NULL nunca é alcançável via rede — só desbloqueia
  # o pubkey.
  passwd -d "$test_user" >/dev/null
  chown "$test_user" "$root"
fi
sshd_user="${test_user:-$(id -un)}"
as_test_user() {
  if [ -n "$test_user" ]; then runuser -u "$test_user" -- "$@"; else "$@"; fi
}

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
if [ -n "$test_user" ]; then
  chown "$test_user" "$root/authorized_keys" "$root/known_hosts" \
    "$root/client_key" "$root/client_key.pub" "$root/legacy_key" "$root/legacy_key.pub"
fi

printf '%s\n' \
  "Port $port" \
  'ListenAddress 127.0.0.1' \
  "HostKey $root/host_key" \
  "PidFile $root/sshd.pid" \
  "AuthorizedKeysFile $root/authorized_keys" \
  "AllowUsers $sshd_user" \
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
  as_test_user ssh -F /dev/null -p "$port" -i "$root/client_key" \
    -o UserKnownHostsFile="$root/known_hosts" -o StrictHostKeyChecking=yes \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=2 \
    "$sshd_user@127.0.0.1" "$@"
}
legacy_ssh_fixture() {
  as_test_user ssh -F /dev/null -p "$port" -i "$root/legacy_key" \
    -o UserKnownHostsFile="$root/known_hosts" -o StrictHostKeyChecking=yes \
    -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=2 \
    "$sshd_user@127.0.0.1" "$@"
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
