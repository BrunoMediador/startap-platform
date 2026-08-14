#!/usr/bin/env bash
set -Eeuo pipefail

# Stateful, synthetic Docker API fixture for the teardown/identity tests. It
# never starts a process, opens a socket, or touches a real Docker resource.
state="${FAKE_DOCKER_STATE:?FAKE_DOCKER_STATE is required}"
mkdir -p "$state"
printf '%q ' "$@" >>"$state/calls.log"
printf '\n' >>"$state/calls.log"

exists() { [ -f "$state/$1-$2" ]; }
label() { sed -n '1p' "$state/$1-$2"; }
not_found() {
  case "$1" in
    container) printf 'Error: No such container: %s\n' "$2" >&2 ;;
    volume) printf 'Error: No such volume: %s\n' "$2" >&2 ;;
    network) printf 'Error: No such network: %s\n' "$2" >&2 ;;
  esac
  exit 1
}
unsupported_contract() {
  printf 'unsupported fake docker contract\n' >&2
  exit 2
}

case "${1:-}:${2:-}" in
  container:inspect|volume:inspect|network:inspect)
    case "${FAKE_DOCKER_INSPECT_MODE:-normal}" in
      normal) ;;
      not-found) not_found "$1" "$3" ;;
      always-fail) printf 'synthetic daemon unavailable detail\n' >&2; exit 1 ;;
      permission) printf 'permission denied opening synthetic docker socket\n' >&2; exit 1 ;;
      timeout) exec sleep 30 ;;
      *) printf 'invalid fake inspect mode\n' >&2; exit 2 ;;
    esac
    ;;
esac

case "${1:-}:${2:-}" in
  container:ls|volume:ls|network:ls)
    case "${FAKE_DOCKER_LIST_MODE:-normal}" in
      normal) ;;
      always-fail) printf 'synthetic list failure detail\n' >&2; exit 1 ;;
      timeout) exec sleep 30 ;;
      *) printf 'invalid fake list mode\n' >&2; exit 2 ;;
    esac
    kind="$1"
    case "$kind" in
      container)
        [ "$#" = 7 ] && [ "$3" = -a ] && [ "$4" = --filter ] &&
          [ "$5" = label=tech.startap.backup-drill ] && [ "$6" = --format ] &&
          [ "$7" = '{{.ID}}' ] || unsupported_contract
        ;;
      volume)
        [ "$#" = 6 ] && [ "$3" = --filter ] &&
          [ "$4" = label=tech.startap.backup-drill ] && [ "$5" = --format ] &&
          [ "$6" = '{{.Name}}' ] || unsupported_contract
        ;;
      network)
        [ "$#" = 6 ] && [ "$3" = --filter ] &&
          [ "$4" = label=tech.startap.backup-drill ] && [ "$5" = --format ] &&
          [ "$6" = '{{.ID}}' ] || unsupported_contract
        ;;
    esac
    for resource in "$state/$kind-"*; do
      [ -f "$resource" ] || continue
      if [ "$kind" = volume ]; then
        printf '%s\n' "${resource##*/volume-}"
      else
        printf 'fixture-%s\n' "${resource##*/}"
      fi
    done
    ;;
  container:inspect|volume:inspect|network:inspect)
    kind="$1"; name="$3"
    [ "$#" = 5 ] && [ "$4" = --format ] || unsupported_contract
    format="$5"
    case "$kind|$format" in
      'container|{{.Name}}'|'volume|{{.Name}}'|'network|{{.Name}}'|\
      'container|{{ index .Config.Labels "tech.startap.backup-drill" }}'|\
      'volume|{{ index .Labels "tech.startap.backup-drill" }}'|\
      'network|{{ index .Labels "tech.startap.backup-drill" }}'|\
      'network|{{.Internal}}'|\
      'container|{{json .HostConfig.PortBindings}}'|\
      'container|{{range .Mounts}}{{printf "%s|%s" .Type .Name}}{{end}}') ;;
      *) unsupported_contract ;;
    esac
    exists "$kind" "$name" || not_found "$kind" "$name"
    case "$format" in
      '{{.Name}}') printf '%s\n' "$name" ;;
      '{{.Internal}}') printf 'true\n' ;;
      '{{json .HostConfig.PortBindings}}') printf 'null\n' ;;
      '{{range .Mounts}}{{printf "%s|%s" .Type .Name}}{{end}}')
        suffix="${name#startap-backup-drill-}"
        case "${FAKE_DOCKER_MOUNT_OUTPUT_MODE:-normal}" in
          normal) printf 'volume|startap-backup-drill-%s-data\n' "$suffix" ;;
          extra-line)
            printf 'volume|startap-backup-drill-%s-data\nunexpected-extra-mount\n' "$suffix"
            ;;
          *) unsupported_contract ;;
        esac
        ;;
      *) label "$kind" "$name" ;;
    esac
    ;;
  network:create|volume:create)
    kind="$1"; name="${!#}"
    run_id="$(printf '%s\n' "$*" | sed -n 's/.*tech\.startap\.backup-drill=\([^ ]*\).*/\1/p')"
    printf '%s\n' "$run_id" >"$state/$kind-$name"
    ;;
  network:rm|volume:rm)
    kind="$1"; name="$3"
    if [ "${FAKE_DOCKER_TEARDOWN_FAIL:-}" = "$kind" ]; then exit 1; fi
    rm -f -- "$state/$kind-$name"
    if [ "$kind" = volume ]; then rm -f -- "$state/restored" "$state/preseeded"; fi
    ;;
  rm:-f)
    name="$3"
    if [ "${FAKE_DOCKER_TEARDOWN_FAIL:-}" = container ]; then exit 1; fi
    rm -f -- "$state/container-$name"
    ;;
  run:-d)
    name=""; run_id=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --name) name="$2"; shift 2 ;;
        --label) run_id="${2#*=}"; shift 2 ;;
        *) shift ;;
      esac
    done
    [ -n "$name" ] && [ -n "$run_id" ]
    printf '%s\n' "$run_id" >"$state/container-$name"
    ;;
  exec:*)
    shift
    stdin_mode=0
    if [ "${1:-}" = -i ]; then stdin_mode=1; shift; fi
    container="$1"; shift
    command_name="$1"; shift
    case "$command_name" in
      pg_isready|createdb) exit 0 ;;
      psql)
        if [ "$stdin_mode" = 1 ]; then
          if [ "${FAKE_DOCKER_RESTORE_FAIL:-0}" = 1 ]; then exit 1; fi
          cat >/dev/null
          : >"$state/restored"
          exit 0
        fi
        args="$*"
        if printf '%s\n' "$args" | grep -Fq 'CREATE TABLE fixture_preexisting'; then
          : >"$state/preseeded"; exit 0
        elif printf '%s\n' "$args" | grep -Fq 'SHOW server_version_num'; then
          printf '%s\n' "${FAKE_DOCKER_PG_VERSION:-160000}"
        elif printf '%s\n' "$args" | grep -Fq 'current_database()'; then
          database="$(printf '%s\n' "$args" | sed -n 's/.*-d \([^ ]*\).*/\1/p')"
          printf '%s:postgres\n' "$database"
        elif printf '%s\n' "$args" | grep -Fq "count(*) FROM pg_tables"; then
          if [ -f "$state/preseeded" ]; then printf '1\n'
          elif [ -f "$state/restored" ]; then printf '60\n'
          else printf '0\n'; fi
        elif printf '%s\n' "$args" | grep -Fq 'count(*) FROM schema_migrations'; then
          printf '80\n'
        else
          printf 't\n'
        fi
        ;;
      *) exit 2 ;;
    esac
    ;;
  *)
    printf 'unsupported fake docker invocation\n' >&2
    exit 2
    ;;
esac
