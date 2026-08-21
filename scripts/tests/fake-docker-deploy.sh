#!/usr/bin/env bash
set -Eeuo pipefail

state_root="${STARTAP_DEPLOY_FAKE_DOCKER_STATE:?STARTAP_DEPLOY_FAKE_DOCKER_STATE is required}"
mkdir -p "$state_root"
printf '%q ' "$@" >>"$state_root/calls.log"
printf '\n' >>"$state_root/calls.log"

unsupported() {
  printf 'unsupported fake docker invocation\n' >&2
  exit 2
}

container_file() {
  printf '%s/container-%s\n' "$state_root" "$1"
}

load_container() {
  local file
  file="$(container_file "$1")"
  [ -f "$file" ] || {
    printf 'Error: No such object: %s\n' "$1" >&2
    exit 1
  }
  # shellcheck disable=SC1090
  . "$file"
}

print_label() {
  case "${1:-}" in
    '') printf '<no value>\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

case "${1:-}:${2:-}" in
  compose:config)
    [ "${3:-}" = --services ] || unsupported
    cat "$state_root/services"
    ;;
  ps:-a)
    [ "${3:-}" = --filter ] && [ "${4:-}" = status=created ] &&
      [ "${5:-}" = --format ] && [ "${6:-}" = '{{.ID}}' ] || unsupported
    for file in "$state_root"/container-*; do
      [ -f "$file" ] || continue
      unset NAME STATE PROJECT SERVICE WORKDIR CONFIG_FILES ONEOFF
      # shellcheck disable=SC1090
      . "$file"
      [ "${STATE:-}" = created ] || continue
      printf '%s\n' "${file##*/container-}"
    done
    ;;
  inspect:--format)
    format="${3:-}"
    id="${4:-}"
    load_container "$id"
    case "$format" in
      '{{.Name}}') printf '%s\n' "${NAME:?}" ;;
      '{{ index .Config.Labels "com.docker.compose.project" }}') print_label "${PROJECT:-}" ;;
      '{{ index .Config.Labels "com.docker.compose.service" }}') print_label "${SERVICE:-}" ;;
      '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}') print_label "${WORKDIR:-}" ;;
      '{{ index .Config.Labels "com.docker.compose.project.config_files" }}') print_label "${CONFIG_FILES:-}" ;;
      '{{ index .Config.Labels "com.docker.compose.oneoff" }}') print_label "${ONEOFF:-}" ;;
      *) unsupported ;;
    esac
    ;;
  rm:*)
    id="${2:-}"
    [ -n "$id" ] || unsupported
    rm -f -- "$(container_file "$id")"
    ;;
  *)
    unsupported
    ;;
esac
