#!/usr/bin/env bash
set -Eeuo pipefail

TEST_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$TEST_DIR/../.." && pwd)"

pass=0
fail=0
test_number=0
LOG_ROOT="$(mktemp -d /tmp/startap-deploy-test-logs.XXXXXX)"

cleanup_root() {
  case "$LOG_ROOT" in
    /tmp/startap-deploy-test-logs.*) find "$LOG_ROOT" -depth -delete 2>/dev/null || true ;;
  esac
}
trap cleanup_root EXIT INT TERM HUP

run_test() {
  local name="$1" function_name="$2" test_exit
  test_number=$((test_number + 1))
  set +e
  (set -Eeuo pipefail; "$function_name") >"$LOG_ROOT/$test_number.log" 2>&1
  test_exit=$?
  set -e
  if [ "$test_exit" = 0 ]; then
    printf 'ok %d - %s\n' "$test_number" "$name"
    pass=$((pass + 1))
  else
    printf 'not ok %d - %s\n' "$test_number" "$name"
    sed -n '1,80p' "$LOG_ROOT/$test_number.log" | sed 's/^/# /'
    fail=$((fail + 1))
  fi
}

setup_sandbox() {
  SANDBOX="$(mktemp -d /tmp/startap-deploy-test.XXXXXX)"
  trap teardown_sandbox EXIT INT TERM HUP
  mkdir -p "$SANDBOX/project" "$SANDBOX/docker-state"
  : >"$SANDBOX/project/docker-compose.yml"
  cat >"$SANDBOX/docker-state/services" <<'EOF'
api
worker
portal-api
EOF
  export STARTAP_DEPLOY_ROOT="$SANDBOX/project"
  export STARTAP_DEPLOY_COMPOSE_FILE="$SANDBOX/project/docker-compose.yml"
  export STARTAP_DEPLOY_TEST_DOCKER_BIN="$TEST_DIR/fake-docker-deploy.sh"
  export STARTAP_DEPLOY_FAKE_DOCKER_STATE="$SANDBOX/docker-state"
}

teardown_sandbox() {
  case "${SANDBOX:-}" in
    /tmp/startap-deploy-test.*) find "$SANDBOX" -depth -delete 2>/dev/null || true ;;
  esac
}

write_container() {
  local id="$1" state="$2" name="$3" project="$4" service="$5" workdir="$6" config_files="$7" oneoff="${8:-False}"
  cat >"$SANDBOX/docker-state/container-$id" <<EOF
STATE=$state
NAME=$name
PROJECT=$project
SERVICE=$service
WORKDIR=$workdir
CONFIG_FILES=$config_files
ONEOFF=$oneoff
EOF
}

test_safe_created_orphan_is_removed() {
  setup_sandbox
  write_container c1 created /startap-api project api "$SANDBOX/project" "$SANDBOX/project/docker-compose.yml"
  # shellcheck disable=SC1090
  . "$REPO_ROOT/scripts/deploy.sh"
  deploy_preflight_remove_created_orphans
  [ ! -f "$SANDBOX/docker-state/container-c1" ]
  grep -Fq "rm c1" "$SANDBOX/docker-state/calls.log"
}

test_foreign_created_container_is_ignored() {
  setup_sandbox
  write_container c2 created /foreign-api other-project api /tmp/other /tmp/other/docker-compose.yml
  # shellcheck disable=SC1090
  . "$REPO_ROOT/scripts/deploy.sh"
  deploy_preflight_remove_created_orphans
  [ -f "$SANDBOX/docker-state/container-c2" ]
  ! grep -Fq "rm c2" "$SANDBOX/docker-state/calls.log"
}

test_ambiguous_created_container_aborts() {
  local output_file output exit_code
  setup_sandbox
  write_container c3 created /startap-api project api /tmp/wrong "$SANDBOX/project/docker-compose.yml"
  output_file="$SANDBOX/ambiguous.log"
  set +e
  bash -lc 'source "$1"; deploy_preflight_remove_created_orphans' _ "$REPO_ROOT/scripts/deploy.sh" >"$output_file" 2>&1
  exit_code=$?
  set -e
  output="$(cat "$output_file")"
  [ "$exit_code" -ne 0 ]
  printf '%s\n' "$output" | grep -Fq 'abortando para evitar remocao insegura'
  [ -f "$SANDBOX/docker-state/container-c3" ]
  ! grep -Fq "rm c3" "$SANDBOX/docker-state/calls.log"
}

test_rollback_continues_even_with_ambiguous_created_container() {
  local output_file output
  setup_sandbox
  write_container c4 created /startap-api project api /tmp/wrong "$SANDBOX/project/docker-compose.yml"
  output_file="$SANDBOX/rollback.log"
  # shellcheck disable=SC1090
  . "$REPO_ROOT/scripts/deploy.sh"
  deploy_run_rollback >"$output_file" 2>&1
  output="$(cat "$output_file")"
  printf '%s\n' "$output" | grep -Fq 'rollback encontrou container created ambiguo'
  printf '%s\n' "$output" | grep -Fq 'seguindo com docker compose up -d para priorizar a recuperacao'
  grep -Fq "compose up -d" "$SANDBOX/docker-state/calls.log"
  [ -f "$SANDBOX/docker-state/container-c4" ]
  ! grep -Fq "rm c4" "$SANDBOX/docker-state/calls.log"
}

run_test 'remove created orphan only with full compose proof' test_safe_created_orphan_is_removed
run_test 'ignore created container from another compose project' test_foreign_created_container_is_ignored
run_test 'abort on ambiguous created container without safe proof' test_ambiguous_created_container_aborts
run_test 'rollback keeps recovery path even with ambiguous created container' test_rollback_continues_even_with_ambiguous_created_container

printf '1..%d\n' "$test_number"
printf '# pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
