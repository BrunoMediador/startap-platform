#!/usr/bin/env bash
# Root-only, bounded, no-follow quarantine queue for malformed producer markers.
# The caller must source common.sh and define a trusted absolute CLAIM_ROOT.

QUARANTINE_ROOT="$CLAIM_ROOT/quarantine"
BACKUP_QUARANTINE_REMAINS=false
BACKUP_QUARANTINE_ENQUEUED=""

backup_quarantine_init() {
  backup_require_absolute_path "$CLAIM_ROOT"
  if backup_is_test; then
    mkdir -p -- "$QUARANTINE_ROOT"
    chmod 0700 "$CLAIM_ROOT" "$QUARANTINE_ROOT"
  else
    backup_require_directory "$CLAIM_ROOT" root:root 700
    if [ ! -e "$QUARANTINE_ROOT" ] && [ ! -L "$QUARANTINE_ROOT" ]; then
      mkdir -- "$QUARANTINE_ROOT"
      chown root:root "$QUARANTINE_ROOT"
      chmod 0700 "$QUARANTINE_ROOT"
    fi
    backup_require_directory "$QUARANTINE_ROOT" root:root 700
  fi
}

backup_quarantine_new_path() {
  local class="$1" attempt nonce candidate
  printf '%s' "$class" | grep -Eq '^[a-z][a-z0-9-]{0,23}$' ||
    backup_die "$BACKUP_EXIT_UNSAFE" dump_quarantine_class_refused
  for attempt in $(seq 1 8); do
    nonce="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
    candidate="$QUARANTINE_ROOT/.q.$$.${nonce}.${class}"
    if [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; then
      BACKUP_QUARANTINE_NEW_PATH="$candidate"
      return 0
    fi
  done
  backup_die "$BACKUP_EXIT_INTEGRITY" dump_quarantine_name_exhausted
}

backup_quarantine_enqueue() {
  local source="$1" class="$2"
  case "$source" in
    "$CLAIM_ROOT"/*)
      [ "${source%/*}" = "$CLAIM_ROOT" ] ||
        backup_die "$BACKUP_EXIT_UNSAFE" dump_quarantine_source_refused
      ;;
    "${RUN_ROOT:-/path-not-configured}"/*)
      [ -n "${RUN_ROOT:-}" ] && [ "${source%/*}" = "$RUN_ROOT" ] ||
        backup_die "$BACKUP_EXIT_UNSAFE" dump_quarantine_source_refused
      ;;
    *) backup_die "$BACKUP_EXIT_UNSAFE" dump_quarantine_source_refused ;;
  esac
  [ -e "$source" ] || [ -L "$source" ] || return 0
  backup_quarantine_new_path "$class"
  # Same-filesystem rename detaches the exact directory entry. No content is
  # opened, copied or traversed, and the producer-visible marker slot is free.
  mv -- "$source" "$BACKUP_QUARANTINE_NEW_PATH" 2>/dev/null ||
    backup_die "$BACKUP_EXIT_TRANSIENT" dump_quarantine_enqueue_failed
  BACKUP_QUARANTINE_ENQUEUED="$BACKUP_QUARANTINE_NEW_PATH"
}

backup_quarantine_path_allowed() {
  local target="$1"
  case "$target" in
    "$QUARANTINE_ROOT"/.q.*)
      [ "${target%/*}" = "$QUARANTINE_ROOT" ]
      ;;
    *) return 1 ;;
  esac
}

backup_quarantine_first_entry() {
  local directory="$1" entry
  BACKUP_QUARANTINE_FIRST=""
  while IFS= read -r -d '' entry; do
    BACKUP_QUARANTINE_FIRST="$entry"
    break
  done < <(find "$directory" -xdev -mindepth 1 -maxdepth 1 -print0 2>/dev/null)
}

backup_quarantine_process_one() {
  local target="$1" child
  backup_quarantine_path_allowed "$target" ||
    backup_die "$BACKUP_EXIT_UNSAFE" dump_quarantine_target_refused
  [ -e "$target" ] || [ -L "$target" ] || return 0

  if [ -d "$target" ] && [ ! -L "$target" ]; then
    backup_quarantine_first_entry "$target"
    child="$BACKUP_QUARANTINE_FIRST"
    if [ -z "$child" ]; then
      rmdir -- "$target" 2>/dev/null || return 1
    elif [ -d "$child" ] && [ ! -L "$child" ]; then
      # Flatten one directory level into the root-only queue. This bounds
      # stack depth and never follows nested links or recursively walks a tree.
      backup_quarantine_new_path node
      mv -- "$child" "$BACKUP_QUARANTINE_NEW_PATH" 2>/dev/null || return 1
    else
      # unlink(2) consumes regular files, symlinks, FIFOs and sockets without
      # opening their content or following a link target.
      rm -f -- "$child" 2>/dev/null || return 1
    fi
  else
    rm -f -- "$target" 2>/dev/null || return 1
  fi
}

backup_quarantine_recover() {
  local limit="$1" work=0 target
  printf '%s' "$limit" | grep -Eq '^[1-9][0-9]{0,2}$' ||
    backup_die "$BACKUP_EXIT_CONFIG" dump_quarantine_work_limit_invalid
  [ "$limit" -le 512 ] ||
    backup_die "$BACKUP_EXIT_CONFIG" dump_quarantine_work_limit_invalid
  backup_quarantine_init

  while [ "$work" -lt "$limit" ]; do
    backup_quarantine_first_entry "$QUARANTINE_ROOT"
    target="$BACKUP_QUARANTINE_FIRST"
    [ -n "$target" ] || break
    backup_quarantine_path_allowed "$target" ||
      backup_die "$BACKUP_EXIT_UNSAFE" dump_quarantine_queue_entry_refused
    backup_quarantine_process_one "$target" || true
    work=$((work + 1))
  done
  backup_quarantine_first_entry "$QUARANTINE_ROOT"
  if [ -n "$BACKUP_QUARANTINE_FIRST" ]; then
    BACKUP_QUARANTINE_REMAINS=true
  else
    BACKUP_QUARANTINE_REMAINS=false
  fi
  BACKUP_QUARANTINE_WORK="$work"
}
