#!/usr/bin/env bash
# Shared fail-closed Docker inspect primitives. The caller must source
# common.sh and define trusted absolute DOCKER_BIN and DOCKER_QUERY_ROOT paths.

BACKUP_DOCKER_QUERY_SEQUENCE=0
BACKUP_DOCKER_QUERY_VALUE=""
BACKUP_DOCKER_QUERY_ERROR_LINE=""
BACKUP_DOCKER_INSPECT_STATE="error"

backup_docker_query_capture() {
  local timeout_seconds=10 prefix output error timeout_marker pid watchdog code query_root output_size
  [ "$#" -ge 1 ] || return 125
  if backup_is_test; then
    timeout_seconds="${STARTAP_BACKUP_TEST_DOCKER_QUERY_TIMEOUT_SECONDS:-10}"
  fi
  printf '%s' "$timeout_seconds" | grep -Eq '^(0\.[0-9]{1,3}|[1-9][0-9]*)$' || return 125

  BACKUP_DOCKER_QUERY_SEQUENCE=$((BACKUP_DOCKER_QUERY_SEQUENCE + 1))
  query_root="${DOCKER_QUERY_ROOT:?DOCKER_QUERY_ROOT is required}"
  prefix="$query_root/.docker-query.$$.$BACKUP_DOCKER_QUERY_SEQUENCE"
  output="$prefix.out"
  error="$prefix.err"
  timeout_marker="$prefix.timeout"
  [ ! -e "$output" ] && [ ! -L "$output" ] &&
    [ ! -e "$error" ] && [ ! -L "$error" ] &&
    [ ! -e "$timeout_marker" ] && [ ! -L "$timeout_marker" ] || return 125
  (umask 077; set -C; : >"$output"; : >"$error") || {
    rm -f -- "$output" "$error"
    return 125
  }

  "$DOCKER_BIN" "$@" >"$output" 2>"$error" &
  pid=$!
  (
    sleep "$timeout_seconds"
    if kill -0 "$pid" 2>/dev/null; then
      (umask 077; set -C; printf 'timeout\n' >"$timeout_marker") || exit 1
      kill -TERM "$pid" 2>/dev/null || true
      sleep 0.2
      kill -KILL "$pid" 2>/dev/null || true
    fi
  ) &
  watchdog=$!
  # A signal-terminated background command makes bash print a diagnostic that
  # can include the full inspect command. The captured stderr remains private;
  # suppress the shell's job-status rendering as well.
  if wait "$pid" 2>/dev/null; then code=0; else code=$?; fi
  kill -TERM "$watchdog" 2>/dev/null || true
  if wait "$watchdog" 2>/dev/null; then :; fi
  if [ -f "$timeout_marker" ] && [ ! -L "$timeout_marker" ]; then code=124; fi

  output_size="$(backup_file_size "$output" 2>/dev/null || printf 65537)"
  if [ "$output_size" -gt 65536 ]; then code=125; fi
  BACKUP_DOCKER_QUERY_VALUE="$(sed -n '1p' "$output")"
  BACKUP_DOCKER_QUERY_ERROR_LINE="$(sed -n '1p' "$error")"
  BACKUP_DOCKER_QUERY_OUTPUT_LINES="$(wc -l <"$output" | tr -d ' ')"
  BACKUP_DOCKER_QUERY_ERROR_LINES="$(wc -l <"$error" | tr -d ' ')"
  rm -f -- "$output" "$error" "$timeout_marker"
  return "$code"
}

backup_docker_not_found_exact() {
  local kind="$1" name="$2" line="$BACKUP_DOCKER_QUERY_ERROR_LINE"
  [ "$BACKUP_DOCKER_QUERY_ERROR_LINES" = 1 ] || return 1
  case "$kind" in
    container)
      [ "$line" = "Error: No such container: $name" ] ||
        [ "$line" = "Error: No such object: $name" ] ||
        [ "$line" = "Error response from daemon: No such container: $name" ]
      ;;
    volume)
      [ "$line" = "Error: No such volume: $name" ] ||
        [ "$line" = "Error response from daemon: get $name: no such volume" ]
      ;;
    network)
      [ "$line" = "Error: No such network: $name" ] ||
        [ "$line" = "Error response from daemon: network $name not found" ]
      ;;
    *) return 1 ;;
  esac
}

backup_docker_inspect_state() {
  local kind="$1" name="$2" code
  case "$kind" in container|volume|network) ;; *) return 2 ;; esac
  if backup_docker_query_capture "$kind" inspect "$name" --format '{{.Name}}'; then
    BACKUP_DOCKER_INSPECT_STATE=present
    return 0
  else
    code=$?
  fi
  if [ "$code" != 124 ] && backup_docker_not_found_exact "$kind" "$name"; then
    BACKUP_DOCKER_INSPECT_STATE=absent
  else
    BACKUP_DOCKER_INSPECT_STATE=error
  fi
}

backup_docker_inspect_value() {
  local kind="$1" name="$2" format="$3"
  case "$kind" in container|volume|network) ;; *) return 2 ;; esac
  backup_docker_query_capture "$kind" inspect "$name" --format "$format" || return 1
  [ "$BACKUP_DOCKER_QUERY_OUTPUT_LINES" = 1 ] || return 1
}

backup_docker_probe_label_orphans() {
  local label_key="$1" kind
  [ "$label_key" = tech.startap.backup-drill ] || return 2
  BACKUP_DOCKER_ORPHAN_STATE=absent
  BACKUP_DOCKER_ORPHAN_COUNT=0
  for kind in container volume network; do
    case "$kind" in
      container)
        if ! backup_docker_query_capture container ls -a \
          --filter "label=$label_key" --format '{{.ID}}'; then
          BACKUP_DOCKER_ORPHAN_STATE=error
          return 0
        fi
        ;;
      volume)
        if ! backup_docker_query_capture volume ls \
          --filter "label=$label_key" --format '{{.Name}}'; then
          BACKUP_DOCKER_ORPHAN_STATE=error
          return 0
        fi
        ;;
      network)
        if ! backup_docker_query_capture network ls \
          --filter "label=$label_key" --format '{{.ID}}'; then
          BACKUP_DOCKER_ORPHAN_STATE=error
          return 0
        fi
        ;;
    esac
    if [ "$BACKUP_DOCKER_QUERY_OUTPUT_LINES" -gt 0 ]; then
      BACKUP_DOCKER_ORPHAN_STATE=present
      BACKUP_DOCKER_ORPHAN_COUNT=$((BACKUP_DOCKER_ORPHAN_COUNT + BACKUP_DOCKER_QUERY_OUTPUT_LINES))
      [ "$BACKUP_DOCKER_ORPHAN_COUNT" -le 1024 ] || BACKUP_DOCKER_ORPHAN_COUNT=1024
    fi
  done
}
