#!/usr/bin/env bash
set -Eeuo pipefail
TEST_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
SCRIPT_DIR="$(CDPATH='' cd -- "$TEST_DIR/.." && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd)"

AGE_BIN_UNDER_TEST="${AGE_BIN_UNDER_TEST:-$(command -v age || true)}"
AGE_KEYGEN_UNDER_TEST="${AGE_KEYGEN_UNDER_TEST:-$(command -v age-keygen || true)}"
[ -n "$AGE_BIN_UNDER_TEST" ] && [ -n "$AGE_KEYGEN_UNDER_TEST" ] || {
  printf 'Bail out! age and age-keygen are required for focused tests\n' >&2
  exit 1
}

pass=0 fail=0 test_number=0
LOG_ROOT="$(mktemp -d /tmp/startap-backup-test-logs.XXXXXX)"
cleanup_root() { case "$LOG_ROOT" in /tmp/startap-backup-test-logs.*) find "$LOG_ROOT" -depth -delete 2>/dev/null || true ;; esac; }
trap cleanup_root EXIT INT TERM HUP

run_test() {
  local name="$1" function_name="$2" test_exit
  test_number=$((test_number + 1))
  if [ -n "${SCRUM167_TEST_FILTER:-}" ] &&
    ! printf '%s %s' "$name" "$function_name" | grep -Fq "$SCRUM167_TEST_FILTER"; then
    printf 'ok %d - %s # SKIP filter\n' "$test_number" "$name"
    pass=$((pass + 1))
    return 0
  fi
  set +e
  (set -Eeuo pipefail; [ "${SCRUM167_TEST_XTRACE:-0}" != 1 ] || set -x; "$function_name") \
    >"$LOG_ROOT/$test_number.log" 2>&1
  test_exit=$?
  set -e
  if [ "$test_exit" = 0 ]; then
    printf 'ok %d - %s\n' "$test_number" "$name"; pass=$((pass + 1))
  else
    printf 'not ok %d - %s\n' "$test_number" "$name"
    sed -n "1,$([ "${SCRUM167_TEST_XTRACE:-0}" = 1 ] && printf 220 || printf 35)p" \
      "$LOG_ROOT/$test_number.log" | sed 's/^/# /'
    fail=$((fail + 1))
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
file_size() {
  if stat -c '%s' "$1" >/dev/null 2>&1; then stat -c '%s' "$1"
  else stat -f '%z' "$1"; fi
}
file_links() {
  if stat -c '%h' "$1" >/dev/null 2>&1; then stat -c '%h' "$1"
  else stat -f '%l' "$1"; fi
}

setup_sandbox() {
  SANDBOX="$(mktemp -d /tmp/startap-backup-test.XXXXXX)"
  trap teardown_sandbox EXIT INT TERM HUP
  mkdir -p "$SANDBOX/config" "$SANDBOX/state/incoming" "$SANDBOX/state/sealed" \
    "$SANDBOX/state/generations" "$SANDBOX/run" "$SANDBOX/bridge" "$SANDBOX/bridge-ack" "$SANDBOX/dump-claims" "$SANDBOX/cycle" \
    "$SANDBOX/validation" "$SANDBOX/attestations" "$SANDBOX/uploader" \
    "$SANDBOX/status/offsite" "$SANDBOX/status/local" "$SANDBOX/drill" \
    "$SANDBOX/drill-journal" "$SANDBOX/docker-query" "$SANDBOX/report"
  chmod 0700 "$SANDBOX" "$SANDBOX"/* "$SANDBOX/state"/* "$SANDBOX/status/offsite" "$SANDBOX/status/local"

  "$AGE_KEYGEN_UNDER_TEST" -o "$SANDBOX/automation.agekey" 2>/dev/null
  "$AGE_KEYGEN_UNDER_TEST" -o "$SANDBOX/offline.agekey" 2>/dev/null
  "$AGE_KEYGEN_UNDER_TEST" -o "$SANDBOX/wrong.agekey" 2>/dev/null
  automation_recipient="$($AGE_KEYGEN_UNDER_TEST -y "$SANDBOX/automation.agekey")"
  offline_recipient="$($AGE_KEYGEN_UNDER_TEST -y "$SANDBOX/offline.agekey")"
  printf '%s\n%s\n' "$offline_recipient" "$automation_recipient" >"$SANDBOX/config/recipients.txt"
  chmod 0600 "$SANDBOX"/*.agekey "$SANDBOX/config/recipients.txt"
  age_sha="$(sha256_file "$AGE_BIN_UNDER_TEST")"
  keygen_sha="$(sha256_file "$AGE_KEYGEN_UNDER_TEST")"
  age_version="$($AGE_BIN_UNDER_TEST --version | head -n 1)"
  {
    printf 'EXPECTED_HOSTNAME=test-host\n'
    printf 'PG_CONTAINER=automacoes-postgres-1\nPG_DATABASE=startap_database\nPG_USER=startap_user\nPG_MAJOR=16\n'
    printf 'PG_IMAGE=postgres:16@sha256:ce5c12ac6952df86affd04ade354cfcb9a0aa1171cd7912e6dbd81578a989a63\n'
    printf 'AGE_BIN=%s\nAGE_KEYGEN_BIN=%s\nAGE_VERSION=%s\nAGE_BINARY_SHA256=%s\nAGE_KEYGEN_BINARY_SHA256=%s\n' \
      "$AGE_BIN_UNDER_TEST" "$AGE_KEYGEN_UNDER_TEST" "$age_version" "$age_sha" "$keygen_sha"
    printf 'AGE_ORIGIN=https://github.com/FiloSottile/age/releases/tag/v1.3.1\n'
    printf 'AGE_ARCHIVE_SHA256=bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377\n'
    printf 'RECIPIENT_SET_ID=fixture-epoch-one\nRECIPIENT_EPOCH=1\nPLAINTEXT_CAP_BYTES=10485760\n'
    printf 'FRESHNESS_HEALTHY_SECONDS=108000\nFRESHNESS_STALE_SECONDS=129600\n'
    printf 'OFFSITE_REPOSITORY=BrunoMediador/startap-backups\nOFFSITE_BRANCH=main\n'
    printf 'DEPLOY_KEY_ID=fixture-vps-only-key\n'
  } >"$SANDBOX/config/policy.conf"
  printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureOnlyNotARealHostKey000000' \
    >"$SANDBOX/config/github_known_hosts"
  printf '%s\n' 'fixture-deploy-key-never-used' >"$SANDBOX/deploy-key"
  chmod 0600 "$SANDBOX/config/"* "$SANDBOX/deploy-key"
  {
    printf '%s\n' '-- PostgreSQL database dump'
    printf '%s\n' 'CREATE TABLE public.fixture_table (id bigint PRIMARY KEY);'
    printf '%s\n' 'COPY public.fixture_table (id) FROM stdin;' '1' '\.'
    printf '%s\n' '-- PostgreSQL database dump complete'
  } >"$SANDBOX/fixture.sql"

  export STARTAP_BACKUP_TEST_MODE=1
  export STARTAP_BACKUP_CONFIG_DIR="$SANDBOX/config"
  export STARTAP_BACKUP_STATE_ROOT="$SANDBOX/state"
  export STARTAP_BACKUP_RUN_ROOT="$SANDBOX/run"
  export STARTAP_BACKUP_BRIDGE_ROOT="$SANDBOX/bridge"
  export STARTAP_BACKUP_BRIDGE_ACK_ROOT="$SANDBOX/bridge-ack"
  export STARTAP_BACKUP_DUMP_CLAIM_ROOT="$SANDBOX/dump-claims"
  export STARTAP_BACKUP_CYCLE_RUN_ROOT="$SANDBOX/cycle"
  export STARTAP_BACKUP_LOCK_ROOT="$SANDBOX/cycle"
  export STARTAP_BACKUP_VALIDATION_ROOT="$SANDBOX/validation"
  export STARTAP_BACKUP_ATTESTATION_ROOT="$SANDBOX/attestations"
  export STARTAP_BACKUP_UPLOADER_ROOT="$SANDBOX/uploader"
  export STARTAP_BACKUP_STATUS_ROOT="$SANDBOX/status"
  export STARTAP_BACKUP_OFFSITE_STATUS_ROOT="$SANDBOX/status/offsite"
  export STARTAP_BACKUP_DRILL_ROOT="$SANDBOX/drill"
  export STARTAP_BACKUP_DRILL_JOURNAL_ROOT="$SANDBOX/drill-journal"
  export STARTAP_BACKUP_DOCKER_QUERY_ROOT="$SANDBOX/docker-query"
  export STARTAP_BACKUP_REPORT_ROOT="$SANDBOX/report"
  export STARTAP_BACKUP_FIXTURE_SQL="$SANDBOX/fixture.sql"
  export STARTAP_BACKUP_TEST_IDENTITY_FILE="$SANDBOX/automation.agekey"
  export STARTAP_BACKUP_TEST_DEPLOY_KEY="$SANDBOX/deploy-key"
  export STARTAP_BACKUP_TEST_RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-a1b2c3d4"
  unset STARTAP_BACKUP_TEST_FAILPOINT STARTAP_BACKUP_TEST_PUSH_SEQUENCE \
    STARTAP_BACKUP_TEST_FETCH_SEQUENCE STARTAP_BACKUP_TEST_SKIP_FETCH \
    STARTAP_BACKUP_TEST_DATABASE_NAME \
    STARTAP_BACKUP_TEST_DOCKER_QUERY_TIMEOUT_SECONDS \
    FAKE_DOCKER_TEARDOWN_FAIL FAKE_DOCKER_RESTORE_FAIL FAKE_DOCKER_PG_VERSION \
    FAKE_DOCKER_INSPECT_MODE FAKE_DOCKER_LIST_MODE FAKE_DOCKER_MOUNT_OUTPUT_MODE
  export STARTAP_BACKUP_TEST_DOCKER_BIN="$TEST_DIR/fake-docker.sh"
  export FAKE_DOCKER_STATE="$SANDBOX/fake-docker"
  mkdir -p -- "$FAKE_DOCKER_STATE"
}

teardown_sandbox() {
  case "${SANDBOX:-}" in /tmp/startap-backup-test.*) find "$SANDBOX" -depth -delete 2>/dev/null || true ;; esac
}

assert_no_plaintext() {
  ! find "$SANDBOX/state" "$SANDBOX/run" "$SANDBOX/drill" -type f \
    \( -name '*.sql' -o -name '*.sql.gz' \) -print | grep -q .
}
expect_failure() {
  local expected_event="$1" output="$SANDBOX/expected-failure.log" command_exit
  shift
  set +e; "$@" >"$output" 2>&1; command_exit=$?; set -e
  [ "$command_exit" -ne 0 ]
  grep -Fq "event=$expected_event" "$output" || {
    sed -n '1,20p' "$output" >&2
    return 1
  }
}
generation() { printf '%s/state/generations/%s\n' "$SANDBOX" "$STARTAP_BACKUP_TEST_RUN_ID"; }
incoming() { printf '%s/state/incoming/%s.incoming\n' "$SANDBOX" "$STARTAP_BACKUP_TEST_RUN_ID"; }
sealed() { printf '%s/state/sealed/%s\n' "$SANDBOX" "$STARTAP_BACKUP_TEST_RUN_ID"; }
produce_seal() { "$SCRIPT_DIR/producer.sh"; "$SCRIPT_DIR/seal.sh"; }

replace_sealed_payload() {
  local source_gzip="$1" directory manifest artifact new_sha new_size
  directory="$(sealed)"; manifest="$directory/manifest.json"
  artifact="$(jq -r '.artifact' "$manifest")"
  chmod 0700 "$directory"; chmod 0600 "$directory"/*
  "$AGE_BIN_UNDER_TEST" -r "$automation_recipient" -r "$offline_recipient" \
    -o "$directory/$artifact.new" "$source_gzip"
  mv -- "$directory/$artifact.new" "$directory/$artifact"
  new_sha="$(sha256_file "$directory/$artifact")"; new_size="$(file_size "$directory/$artifact")"
  jq --arg sha "$new_sha" --argjson size "$new_size" '.sha256=$sha | .size_bytes=$size' \
    "$manifest" >"$manifest.new"
  mv -- "$manifest.new" "$manifest"
  printf '%s  %s\n' "$new_sha" "$artifact" >"$directory/SHA256SUMS"
  printf '%s\n' "$new_sha" >"$directory/PREPARED"
  printf '%s\n' "$(sha256_file "$manifest")" >"$directory/SEALED"
  chmod 0440 "$directory"/*; chmod 0550 "$directory"
}

setup_uploader_repo() {
  mkdir -p "$SANDBOX/uploader/repository"
  git -C "$SANDBOX/uploader/repository" init -q -b main
  printf 'fixture\n' >"$SANDBOX/uploader/repository/README.md"
  git -C "$SANDBOX/uploader/repository" add README.md
  git -C "$SANDBOX/uploader/repository" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm seed
  git -C "$SANDBOX/uploader/repository" remote add origin git@github.com:BrunoMediador/startap-backups.git
  export STARTAP_BACKUP_TEST_SKIP_FETCH=1
}

test_valid_chain() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"
  final="$(generation)"
  [ -f "$final/COMPLETE" ] && [ -f "$final/VALIDATED" ] && [ -f "$final/manifest.json" ]
  [ "$(jq -r '.recipient_count' "$final/manifest.json")" = 2 ]
  [ ! -e "$SANDBOX/state/pending-run" ]
  assert_no_plaintext
}
test_producer_has_no_docker_or_credentials() {
  ! rg -n 'docker (ps|exec)|docker\.sock|CREDENTIALS_DIRECTORY|\.env' "$SCRIPT_DIR/producer.sh" \
    "$REPO_ROOT/infra/systemd/startap-backup-producer.service"
  grep -Fq 'User=startap-backup-producer' "$REPO_ROOT/infra/systemd/startap-backup-producer.service"
  grep -Fq '/usr/bin/docker exec automacoes-postgres-1 pg_dump' "$SCRIPT_DIR/dump-helper.sh"
  grep -Fq 'DUMP_OK' "$SCRIPT_DIR/dump-helper.sh"
  ! rg -n '/usr/bin/(sudo|systemctl)|docker (ps|exec)' "$SCRIPT_DIR/producer.sh"
  grep -Fq 'NoNewPrivileges=yes' "$REPO_ROOT/infra/systemd/startap-backup-producer.service"
  grep -Fq 'startap-backup-dump.path' "$REPO_ROOT/infra/systemd/startap-backup-producer.service"
  grep -Fq 'PathExists=/run/startap-backup-producer/request-run' \
    "$REPO_ROOT/infra/systemd/startap-backup-dump.path"
  grep -Fq 'PathExists=/run/startap-backup-producer/cleanup-request' \
    "$REPO_ROOT/infra/systemd/startap-backup-dump-cleanup.path"
  grep -Fq 'ExecStart=/usr/local/libexec/startap-backup/dump-helper.sh dump' \
    "$REPO_ROOT/infra/systemd/startap-backup-dump.service"
  ! grep -Fq '/var/run/docker.sock' "$REPO_ROOT/infra/systemd/startap-backup-dump.service"
  ! grep -Fq 'startap-backup-producer' "$REPO_ROOT/infra/systemd/startap-backup.sudoers"
  grep -Fq '"$UNIT_SOURCE"/*.path' "$SCRIPT_DIR/install.sh"
}
test_dump_helper_failure_no_prepare() {
  setup_sandbox; export STARTAP_BACKUP_TEST_FAILPOINT=dump_helper_fail
  expect_failure pg_dump_helper_failed "$SCRIPT_DIR/producer.sh"
  ! find "$SANDBOX/state/incoming" -name PREPARED -print | grep -q .; assert_no_plaintext
}
test_dump_helper_partial_failure_no_prepare() {
  setup_sandbox; export STARTAP_BACKUP_TEST_FAILPOINT=dump_helper_partial_fail
  expect_failure pg_dump_helper_failed "$SCRIPT_DIR/producer.sh"
  ! find "$SANDBOX/state/incoming" -name PREPARED -print | grep -q .; assert_no_plaintext
}
test_storage_full_fails_closed() {
  setup_sandbox; export STARTAP_BACKUP_TEST_FAILPOINT=storage_full
  expect_failure storage_write_failed "$SCRIPT_DIR/producer.sh"
  ! find "$SANDBOX/state/generations" -name COMPLETE -print | grep -q .; assert_no_plaintext
}
test_interruption_cleans_plaintext() {
  setup_sandbox; export STARTAP_BACKUP_TEST_FAILPOINT=pause_after_plaintext STARTAP_BACKUP_TEST_PAUSE_SECONDS=2
  "$SCRIPT_DIR/producer.sh" >"$SANDBOX/interrupted.log" 2>&1 & producer_pid=$!
  for _ in $(seq 1 150); do find "$SANDBOX/run" -name dump.sql -print | grep -q . && break; sleep 0.02; done
  kill -TERM "$producer_pid"; set +e; wait "$producer_pid"; code=$?; set -e
  [ "$code" -ne 0 ]; assert_no_plaintext
  ! find "$SANDBOX/state/generations" -name COMPLETE -print | grep -q .
}
test_sigkill_plaintext_reconciler_allows_next_cycle() {
  setup_sandbox
  killed_run="$STARTAP_BACKUP_TEST_RUN_ID"
  export STARTAP_BACKUP_TEST_FAILPOINT=pause_after_plaintext
  export STARTAP_BACKUP_TEST_PAUSE_SECONDS=300
  "$SCRIPT_DIR/producer.sh" >"$SANDBOX/killed-producer.log" 2>&1 & producer_pid=$!
  plaintext="$SANDBOX/run/plain/$killed_run/dump.sql"
  observed=0
  for _ in $(seq 1 500); do
    if [ -s "$plaintext" ]; then observed=1; break; fi
    kill -0 "$producer_pid" 2>/dev/null || break
    sleep 0.01
  done
  [ "$observed" = 1 ]
  kill -KILL "$producer_pid"
  set +e; wait "$producer_pid"; killed_exit=$?; set -e
  [ "$killed_exit" -ne 0 ] && [ -s "$plaintext" ]

  "$SCRIPT_DIR/producer-reconcile-request.sh" async >/dev/null
  "$SCRIPT_DIR/producer-reconcile.sh" >/dev/null
  [ ! -e "$SANDBOX/run/plain" ] && [ ! -e "$SANDBOX/run/dump" ]
  [ ! -e "$SANDBOX/dump-claims/active-run" ]
  [ -f "$SANDBOX/bridge-ack/reconcile-complete" ]
  [ "$(sed -n '1p' "$SANDBOX/bridge-ack/reconcile-complete")" != "$killed_run" ]

  unset STARTAP_BACKUP_TEST_FAILPOINT STARTAP_BACKUP_TEST_PAUSE_SECONDS
  export STARTAP_BACKUP_TEST_RUN_ID=20260814T235959Z-b1c2d3e4
  "$SCRIPT_DIR/cycle.sh"
  [ -f "$(generation)/COMPLETE" ]
  assert_no_plaintext
}
test_cycle_uses_group_bridge_without_plaintext_access() {
  cycle_unit="$REPO_ROOT/infra/systemd/startap-backup-cycle.service"
  producer_unit="$REPO_ROOT/infra/systemd/startap-backup-producer.service"
  grep -Fxq 'CapabilityBoundingSet=' "$cycle_unit"
  grep -Fq 'SupplementaryGroups=startap-backup-bridge' "$cycle_unit"
  grep -Fq 'ReadOnlyPaths=/run/startap-backup-bridge/producer' "$cycle_unit"
  grep -Fq 'InaccessiblePaths=/run/startap-backup-producer' "$cycle_unit"
  grep -Fq 'ExecStartPre=/usr/local/libexec/startap-backup/producer-reconcile-request.sh wait' "$producer_unit"
  grep -Fq 'ExecStopPost=/usr/local/libexec/startap-backup/producer-reconcile-request.sh async' "$producer_unit"
  grep -Fq 'd /run/startap-backup-bridge/producer' "$REPO_ROOT/infra/systemd/startap-backup.tmpfiles"
  grep -Fq 'm startap-backup-producer  startap-backup-bridge' "$REPO_ROOT/infra/systemd/startap-backup.sysusers"
}
test_concurrent_producer_refused() {
  setup_sandbox; mkdir -p "$SANDBOX/run/locks/producer.lock"
  expect_failure concurrent_run_refused "$SCRIPT_DIR/producer.sh"
}
test_duplicate_run_idempotent() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; before="$(sha256_file "$(generation)/manifest.json")"
  "$SCRIPT_DIR/cycle.sh"; [ "$before" = "$(sha256_file "$(generation)/manifest.json")" ]
  [ "$(find "$SANDBOX/state/generations" -name COMPLETE | wc -l | tr -d ' ')" = 1 ]
}
test_seal_rejects_symlink() {
  setup_sandbox; "$SCRIPT_DIR/producer.sh"; directory="$(incoming)"
  rm "$directory/SHA256SUMS"; ln -s manifest.json "$directory/SHA256SUMS"
  expect_failure trusted_file_invalid "$SCRIPT_DIR/seal.sh"
}
test_seal_rejects_hardlink() {
  setup_sandbox; "$SCRIPT_DIR/producer.sh"; directory="$(incoming)"
  rm "$directory/SHA256SUMS"; ln "$directory/manifest.json" "$directory/SHA256SUMS"
  expect_failure trusted_file_hardlink_refused "$SCRIPT_DIR/seal.sh"
}
test_seal_rejects_extra_entry() {
  setup_sandbox; "$SCRIPT_DIR/producer.sh"; printf x >"$(incoming)/EXTRA"
  expect_failure generation_extra_entry_refused "$SCRIPT_DIR/seal.sh"
}
test_generation_allowlist_rejects_compound_name() {
  setup_sandbox; "$SCRIPT_DIR/producer.sh"
  artifact="$(jq -r '.artifact' "$(incoming)/manifest.json")"
  : >"$(incoming)/PREPARED $artifact"
  expect_failure generation_extra_entry_refused "$SCRIPT_DIR/seal.sh"
}
test_seal_allowlist_rejects_newline_name() {
  setup_sandbox; "$SCRIPT_DIR/producer.sh"
  export STARTAP_BACKUP_TEST_FAILPOINT=seal_after_incoming_claim
  expect_failure seal_interrupted_after_incoming_claim "$SCRIPT_DIR/seal.sh"
  unset STARTAP_BACKUP_TEST_FAILPOINT
  staging="$SANDBOX/state/sealed/.${STARTAP_BACKUP_TEST_RUN_ID}.sealing"
  : >"$staging/"$'SEALED\nVALIDATED'
  expect_failure seal_staging_extra_entry_refused "$SCRIPT_DIR/seal.sh"
}
test_promote_allowlist_rejects_space_name() {
  setup_sandbox; produce_seal; "$SCRIPT_DIR/validate.sh"
  export STARTAP_BACKUP_TEST_FAILPOINT=promote_after_sealed_claim
  expect_failure promotion_interrupted_after_sealed_claim "$SCRIPT_DIR/promote.sh"
  unset STARTAP_BACKUP_TEST_FAILPOINT
  temporary="$SANDBOX/state/generations/.${STARTAP_BACKUP_TEST_RUN_ID}.tmp"
  : >"$temporary/VALIDATED "
  expect_failure generation_extra_entry_refused "$SCRIPT_DIR/promote.sh"
}
test_sealed_mutation_denied() {
  setup_sandbox; produce_seal; artifact="$(jq -r '.artifact' "$(sealed)/manifest.json")"
  ! printf x >>"$(sealed)/$artifact"
}
test_checksum_mismatch_rejected() {
  setup_sandbox; produce_seal; directory="$(sealed)"; artifact="$(jq -r '.artifact' "$directory/manifest.json")"
  chmod 0640 "$directory/$artifact"; printf x >>"$directory/$artifact"; chmod 0440 "$directory/$artifact"
  expect_failure checksum_mismatch "$SCRIPT_DIR/validate.sh"
}
test_marker_missing_rejected() {
  setup_sandbox; produce_seal; chmod 0750 "$(sealed)"; rm "$(sealed)/SEALED"; chmod 0550 "$(sealed)"
  expect_failure generation_required_entry_missing "$SCRIPT_DIR/validate.sh"
}
test_truncated_gzip_rejected() {
  setup_sandbox; produce_seal; gzip -n -c "$SANDBOX/fixture.sql" >"$SANDBOX/full.gz"
  size="$(file_size "$SANDBOX/full.gz")"; dd if="$SANDBOX/full.gz" of="$SANDBOX/truncated.gz" bs=1 count=$((size / 2)) 2>/dev/null
  replace_sealed_payload "$SANDBOX/truncated.gz"
  expect_failure gzip_truncated_or_invalid "$SCRIPT_DIR/validate.sh"
}
test_corrupt_dump_rejected() {
  setup_sandbox; produce_seal; printf 'synthetic invalid payload\n' | gzip -n -c >"$SANDBOX/corrupt.gz"
  replace_sealed_payload "$SANDBOX/corrupt.gz"
  expect_failure dump_header_invalid "$SCRIPT_DIR/validate.sh"
}
test_wrong_identity_rejected() {
  setup_sandbox; produce_seal; export STARTAP_BACKUP_TEST_IDENTITY_FILE="$SANDBOX/wrong.agekey"
  expect_failure age_decrypt_failed "$SCRIPT_DIR/validate.sh"
}
test_age_failure_sanitized_and_cleanup() {
  setup_sandbox; fake_age="$SANDBOX/fake-age"
  printf '%s\n' '#!/usr/bin/env bash' \
    'if [ "${1:-}" = "--version" ]; then echo v1.3.1; exit 0; fi' \
    'echo AGE-SECRET-KEY-DO-NOT-LOG >&2' 'exit 1' >"$fake_age"
  chmod 0755 "$fake_age"; fake_sha="$(sha256_file "$fake_age")"
  sed -e "s|^AGE_BIN=.*|AGE_BIN=$fake_age|" -e "s|^AGE_BINARY_SHA256=.*|AGE_BINARY_SHA256=$fake_sha|" \
    "$SANDBOX/config/policy.conf" >"$SANDBOX/config/policy.new"
  mv "$SANDBOX/config/policy.new" "$SANDBOX/config/policy.conf"
  expect_failure age_encrypt_failed "$SCRIPT_DIR/producer.sh"
  ! grep -Fq AGE-SECRET-KEY-DO-NOT-LOG "$SANDBOX/expected-failure.log"; assert_no_plaintext
}
test_attestation_external_then_bound() {
  setup_sandbox; produce_seal; "$SCRIPT_DIR/validate.sh"
  [ -f "$SANDBOX/attestations/$STARTAP_BACKUP_TEST_RUN_ID.json" ]
  [ ! -e "$(sealed)/VALIDATED" ]; "$SCRIPT_DIR/promote.sh"
  [ -f "$(generation)/VALIDATED" ] && [ -f "$(generation)/COMPLETE" ]
}
test_attestation_tamper_rejected() {
  setup_sandbox; produce_seal; "$SCRIPT_DIR/validate.sh"
  jq '.artifact_sha256=("0"*64)' "$SANDBOX/attestations/$STARTAP_BACKUP_TEST_RUN_ID.json" >"$SANDBOX/a"
  mv "$SANDBOX/a" "$SANDBOX/attestations/$STARTAP_BACKUP_TEST_RUN_ID.json"
  expect_failure validation_attestation_mismatch "$SCRIPT_DIR/promote.sh"
}
test_precomplete_hidden_and_recoverable() {
  setup_sandbox; produce_seal; "$SCRIPT_DIR/validate.sh"; export STARTAP_BACKUP_TEST_FAILPOINT=promote_after_complete_temp
  expect_failure promotion_interrupted_after_complete_temp "$SCRIPT_DIR/promote.sh"
  [ -d "$SANDBOX/state/generations/.$STARTAP_BACKUP_TEST_RUN_ID.tmp" ]
  [ ! -e "$(generation)/COMPLETE" ]
  set +e; "$SCRIPT_DIR/health.sh" >"$SANDBOX/health.json"; health_exit=$?; set -e
  [ "$health_exit" = 1 ] && [ "$(jq -r '.local.state' "$SANDBOX/health.json")" = none ]
  unset STARTAP_BACKUP_TEST_FAILPOINT; "$SCRIPT_DIR/cycle.sh"; [ -f "$(generation)/COMPLETE" ]
}

assert_cycle_converged_without_replacing_ciphertext() {
  local expected_sha="$1" final artifact
  final="$(generation)"; artifact="$(jq -r '.artifact' "$final/manifest.json")"
  [ -f "$final/COMPLETE" ] && [ "$(sha256_file "$final/$artifact")" = "$expected_sha" ]
  [ ! -e "$SANDBOX/state/pending-run" ] && [ ! -e "$SANDBOX/bridge/ready-run" ]
  ! find "$SANDBOX/state/incoming" "$SANDBOX/state/sealed" -mindepth 1 -print | grep -q .
}
exercise_producer_boundary() {
  local failpoint="$1" event="$2" artifact source_sha
  setup_sandbox; export STARTAP_BACKUP_TEST_FAILPOINT="$failpoint"
  expect_failure "$event" "$SCRIPT_DIR/producer.sh"
  artifact="backup-${STARTAP_BACKUP_TEST_RUN_ID%-*}.sql.gz.age"
  source_sha="$(sha256_file "$(incoming)/$artifact")"
  unset STARTAP_BACKUP_TEST_FAILPOINT; "$SCRIPT_DIR/cycle.sh"
  assert_cycle_converged_without_replacing_ciphertext "$source_sha"
}
test_recover_producer_after_incoming() { exercise_producer_boundary producer_after_incoming_publish producer_interrupted_after_incoming_publish; }
test_recover_producer_after_ready_temp() { exercise_producer_boundary producer_after_ready_temp producer_interrupted_after_ready_temp; }
test_recover_producer_after_ready_publish() { exercise_producer_boundary producer_after_ready_publish producer_interrupted_after_ready_publish; }

exercise_seal_boundary() {
  local failpoint="$1" event="$2" artifact source_sha
  setup_sandbox; "$SCRIPT_DIR/producer.sh"
  artifact="$(jq -r '.artifact' "$(incoming)/manifest.json")"
  source_sha="$(sha256_file "$(incoming)/$artifact")"
  export STARTAP_BACKUP_TEST_FAILPOINT="$failpoint"
  expect_failure "$event" "$SCRIPT_DIR/seal.sh"
  unset STARTAP_BACKUP_TEST_FAILPOINT; "$SCRIPT_DIR/cycle.sh"
  assert_cycle_converged_without_replacing_ciphertext "$source_sha"
}
test_recover_seal_after_claim() { exercise_seal_boundary seal_after_incoming_claim seal_interrupted_after_incoming_claim; }
test_recover_seal_after_marker_temp() { exercise_seal_boundary seal_after_marker_temp seal_interrupted_after_marker_temp; }
test_recover_seal_after_staging() { exercise_seal_boundary seal_after_staging_complete seal_interrupted_after_staging_complete; }
test_recover_seal_after_publish() { exercise_seal_boundary seal_after_publish seal_interrupted_after_publish; }
test_recover_seal_after_pending_temp() { exercise_seal_boundary seal_after_pending_temp seal_interrupted_after_pending_temp; }
test_recover_seal_after_pending_publish() { exercise_seal_boundary seal_after_pending_publish seal_interrupted_after_pending_publish; }

exercise_promote_boundary() {
  local failpoint="$1" event="$2" artifact source_sha
  setup_sandbox; produce_seal; "$SCRIPT_DIR/validate.sh"
  artifact="$(jq -r '.artifact' "$(sealed)/manifest.json")"
  source_sha="$(sha256_file "$(sealed)/$artifact")"
  export STARTAP_BACKUP_TEST_FAILPOINT="$failpoint"
  expect_failure "$event" "$SCRIPT_DIR/promote.sh"
  unset STARTAP_BACKUP_TEST_FAILPOINT; "$SCRIPT_DIR/cycle.sh"
  assert_cycle_converged_without_replacing_ciphertext "$source_sha"
}
test_recover_promote_after_claim() { exercise_promote_boundary promote_after_sealed_claim promotion_interrupted_after_sealed_claim; }
test_recover_promote_after_validated() { exercise_promote_boundary promote_after_validated promotion_interrupted_after_validated; }
test_recover_promote_after_complete_temp() { exercise_promote_boundary promote_after_complete_temp promotion_interrupted_after_complete_temp; }
test_recover_promote_after_complete_marker() { exercise_promote_boundary promote_after_complete_marker promotion_interrupted_after_complete_marker; }
test_recover_promote_after_final_publish() { exercise_promote_boundary promote_after_final_publish promotion_interrupted_after_final_publish; }
test_recover_promote_after_latest() { exercise_promote_boundary promote_after_latest promotion_interrupted_after_latest; }

test_local_attempt_success_is_atomic() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"
  jq -e --arg run "$STARTAP_BACKUP_TEST_RUN_ID" '
    .schema_version == 1 and .state == "success" and .success == true and
    .class == "success" and .run_id == $run and
    (.started_at | test("^[0-9]{8}T[0-9]{6}Z$")) and
    (.ended_at | test("^[0-9]{8}T[0-9]{6}Z$"))' \
    "$SANDBOX/status/local/last-attempt.json" >/dev/null
  ! find "$SANDBOX/status/local" -name '.last-attempt.tmp.*' -print | grep -q .
}
test_later_local_failure_degrades_without_erasing_rpo() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; recovery_run="$STARTAP_BACKUP_TEST_RUN_ID"
  recovery_sha="$(jq -r '.sha256' "$(generation)/manifest.json")"
  export STARTAP_BACKUP_TEST_RUN_ID="${STARTAP_BACKUP_TEST_RUN_ID%-*}-ffffffff"
  export STARTAP_BACKUP_TEST_FAILPOINT=storage_full
  expect_failure storage_write_failed "$SCRIPT_DIR/cycle.sh"
  unset STARTAP_BACKUP_TEST_FAILPOINT
  set +e; "$SCRIPT_DIR/health.sh" >"$SANDBOX/health.json"; health_exit=$?; set -e
  [ "$health_exit" = 2 ]
  jq -e --arg recovery "$recovery_run" --arg failed "$STARTAP_BACKUP_TEST_RUN_ID" \
    --arg sha "$recovery_sha" '
      .state == "degraded" and .local.state == "degraded" and
      .local.run_id == $recovery and .local.sha256 == $sha and
      .local.last_attempt.state == "failed" and .local.last_attempt.success == false and
      .local.last_attempt.run_id == $failed' "$SANDBOX/health.json" >/dev/null
}
test_transient_retry_then_success() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; setup_uploader_repo
  export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=transient,success
  "$SCRIPT_DIR/uploader.sh" >"$SANDBOX/uploader.log"
  grep -Fq 'event=offsite_retry attempt=1' "$SANDBOX/uploader.log"
  [ "$(jq -r '.state' "$SANDBOX/status/offsite/recovery-point.json")" = healthy ]
}
test_all_primary_fail_fallback_survives() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; setup_uploader_repo
  export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=transient,transient,transient,transient
  expect_failure offsite_push_exhausted "$SCRIPT_DIR/uploader.sh"
  [ -f "$(generation)/COMPLETE" ]
  [ "$(jq -r '.state' "$SANDBOX/status/offsite/last-attempt.json")" = failed ]
  [ ! -e "$SANDBOX/status/offsite/recovery-point.json" ]
}
test_uploader_interruption_recovers_without_duplicate() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; setup_uploader_repo
  export STARTAP_BACKUP_TEST_FAILPOINT=upload_after_destination
  expect_failure offsite_prepare_interrupted "$SCRIPT_DIR/uploader.sh"
  [ -d "$SANDBOX/uploader/repository/dumps/${STARTAP_BACKUP_TEST_RUN_ID:0:4}/${STARTAP_BACKUP_TEST_RUN_ID:4:2}/$STARTAP_BACKUP_TEST_RUN_ID" ]
  unset STARTAP_BACKUP_TEST_FAILPOINT; export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=success
  "$SCRIPT_DIR/uploader.sh"
  [ "$(git -C "$SANDBOX/uploader/repository" log --format=%s | grep -Fxc "backup: $STARTAP_BACKUP_TEST_RUN_ID")" = 1 ]
  [ "$(jq -r '.state' "$SANDBOX/status/offsite/recovery-point.json")" = healthy ]
}
test_auth_terminal_no_retry() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; setup_uploader_repo; export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=auth,success
  expect_failure offsite_push_terminal "$SCRIPT_DIR/uploader.sh"
  ! grep -Fq offsite_retry "$SANDBOX/expected-failure.log"; grep -Fq attempts=1 "$SANDBOX/expected-failure.log"
}
test_host_mismatch_terminal() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; setup_uploader_repo; export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=host_mismatch,success
  expect_failure offsite_push_terminal "$SCRIPT_DIR/uploader.sh"; ! grep -Fq offsite_retry "$SANDBOX/expected-failure.log"
}
test_non_fast_forward_terminal() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; setup_uploader_repo; export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=non_fast_forward,success
  expect_failure offsite_push_terminal "$SCRIPT_DIR/uploader.sh"; ! grep -Fq offsite_retry "$SANDBOX/expected-failure.log"
}
test_failed_attempt_preserves_rpo() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; setup_uploader_repo; export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=success
  "$SCRIPT_DIR/uploader.sh"; previous_run="$(jq -r '.run_id' "$SANDBOX/status/offsite/recovery-point.json")"
  export STARTAP_BACKUP_TEST_RUN_ID="${STARTAP_BACKUP_TEST_RUN_ID%-*}-ffffffff"
  "$SCRIPT_DIR/cycle.sh"; export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=transient,transient,transient,transient
  expect_failure offsite_push_exhausted "$SCRIPT_DIR/uploader.sh"
  [ "$(jq -r '.run_id' "$SANDBOX/status/offsite/recovery-point.json")" = "$previous_run" ]
  set +e; "$SCRIPT_DIR/health.sh" >"$SANDBOX/health.json"; code=$?; set -e
  [ "$code" = 2 ] && [ "$(jq -r '.state' "$SANDBOX/health.json")" = degraded ]
  [ "$(jq -r '.offsite.last_attempt.state' "$SANDBOX/health.json")" = failed ]
}
test_health_truth_local_healthy_offsite_invalid() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; printf '{"broken":true}\n' >"$SANDBOX/status/offsite/recovery-point.json"
  set +e; "$SCRIPT_DIR/health.sh" >"$SANDBOX/health.json"; code=$?; set -e
  [ "$code" = 2 ] && [ "$(jq -r '.state' "$SANDBOX/health.json")" = degraded ]
  [ "$(jq -r '.local.state' "$SANDBOX/health.json")" = healthy ]
  [ "$(jq -r '.offsite.state' "$SANDBOX/health.json")" = invalid ]
}
test_identity_heartbeat_affects_health() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; setup_uploader_repo; export STARTAP_BACKUP_TEST_PUSH_SEQUENCE=success
  "$SCRIPT_DIR/uploader.sh"; rm "$SANDBOX/attestations/identity-heartbeat.json"
  set +e; "$SCRIPT_DIR/health.sh" >"$SANDBOX/health.json"; code=$?; set -e
  [ "$code" = 2 ] && [ "$(jq -r '.state' "$SANDBOX/health.json")" = degraded ]
  [ "$(jq -r '.automation_identity.available' "$SANDBOX/health.json")" = false ]
}
test_duplicate_recipients_rejected() {
  setup_sandbox; printf '%s\n%s\n' "$automation_recipient" "$automation_recipient" >"$SANDBOX/config/recipients.txt"
  expect_failure duplicate_recipient_refused "$SCRIPT_DIR/producer.sh"
}
test_drill_reads_generation_without_copy() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; "$SCRIPT_DIR/drill-prepare.sh"
  [ -f "$SANDBOX/drill/$STARTAP_BACKUP_TEST_RUN_ID/dump.sql.gz" ]
  ! rg -n 'drill-source|cp .*generation' "$SCRIPT_DIR/drill-prepare.sh" "$SCRIPT_DIR/promote.sh"
  "$SCRIPT_DIR/drill-cleanup.sh"; assert_no_plaintext
  grep -Eq '^ReadOnlyPaths=.*(/var/lib/startap-backup/generations).*(/etc/startap-backup)|^ReadOnlyPaths=.*(/etc/startap-backup).*(/var/lib/startap-backup/generations)' \
    "$REPO_ROOT/infra/systemd/startap-backup-drill-prepare.service"
}
test_drill_interruption_cleanup() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; export STARTAP_BACKUP_TEST_FAILPOINT=after_drill_prepare
  expect_failure drill_interrupted_between_units "$SCRIPT_DIR/drill-cycle.sh"
  [ ! -e "$SANDBOX/drill/pending-run" ]; assert_no_plaintext
}
test_drill_cleanup_unlinks_symlink_without_following() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh"; "$SCRIPT_DIR/drill-prepare.sh"
  target="$SANDBOX/drill/$STARTAP_BACKUP_TEST_RUN_ID/input.json"
  outside="$SANDBOX/outside-drill-entry"
  printf 'outside-unchanged\n' >"$outside"
  rm "$target"; ln -s "$outside" "$target"
  "$SCRIPT_DIR/drill-cleanup.sh" >"$SANDBOX/drill-cleanup.log" 2>&1
  [ "$(sed -n '1p' "$outside")" = outside-unchanged ]
  [ ! -e "$SANDBOX/drill/pending-run" ] && [ ! -L "$SANDBOX/drill/pending-run" ]
  [ ! -e "$SANDBOX/drill/$STARTAP_BACKUP_TEST_RUN_ID" ] &&
    [ ! -L "$SANDBOX/drill/$STARTAP_BACKUP_TEST_RUN_ID" ]
  grep -Fq 'event=drill_cleanup_entry_symlink_removed' "$SANDBOX/drill-cleanup.log"
}

prepare_fake_drill() {
  "$SCRIPT_DIR/cycle.sh"; "$SCRIPT_DIR/drill-prepare.sh"
}
fake_resources_absent() { ! find "$FAKE_DOCKER_STATE" -type f \( -name 'container-*' -o -name 'volume-*' -o -name 'network-*' \) -print | grep -q .; }
seed_fake_reconcile_state() {
  local suffix="${STARTAP_BACKUP_TEST_RUN_ID##*-}"
  local container="startap-backup-drill-$suffix"
  local volume="startap-backup-drill-$suffix-data"
  local network="startap-backup-drill-$suffix-net"
  printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$FAKE_DOCKER_STATE/container-$container"
  printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$FAKE_DOCKER_STATE/volume-$volume"
  printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$FAKE_DOCKER_STATE/network-$network"
  jq -n --arg run "$STARTAP_BACKUP_TEST_RUN_ID" --arg container "$container" \
    --arg volume "$volume" --arg network "$network" \
    '{schema_version:2,phase:"restore-complete",run_id:$run,container:$container,
      volume:$volume,network:$network,label_key:"tech.startap.backup-drill"}' \
    >"$SANDBOX/drill-journal/docker-reconcile.json"
}
test_fake_pg16_drill_teardown_success() {
  setup_sandbox; prepare_fake_drill; "$SCRIPT_DIR/docker-helper.sh" drill
  jq -e '.status == "success" and .postgres_major == 16 and .production_target == false and .teardown_complete == true and .rto_seconds >= 0' \
    "$SANDBOX/report/$STARTAP_BACKUP_TEST_RUN_ID.json" >/dev/null
  fake_resources_absent
  grep -Fq 'container ls -a --filter label=tech.startap.backup-drill --format \{\{.ID\}\}' \
    "$FAKE_DOCKER_STATE/calls.log"
  grep -Fq 'volume ls --filter label=tech.startap.backup-drill --format \{\{.Name\}\}' \
    "$FAKE_DOCKER_STATE/calls.log"
  grep -Fq 'network ls --filter label=tech.startap.backup-drill --format \{\{.ID\}\}' \
    "$FAKE_DOCKER_STATE/calls.log"
}
test_orphan_probe_empty_state_uses_type_specific_formats() {
  setup_sandbox
  "$SCRIPT_DIR/docker-reconcile.sh" reconcile >"$SANDBOX/empty-reconcile.log" 2>&1
  grep -Fq 'event=drill_reconcile_nothing_pending' "$SANDBOX/empty-reconcile.log"
  grep -Fq 'container ls -a --filter label=tech.startap.backup-drill --format \{\{.ID\}\}' \
    "$FAKE_DOCKER_STATE/calls.log"
  grep -Fq 'volume ls --filter label=tech.startap.backup-drill --format \{\{.Name\}\}' \
    "$FAKE_DOCKER_STATE/calls.log"
  grep -Fq 'network ls --filter label=tech.startap.backup-drill --format \{\{.ID\}\}' \
    "$FAKE_DOCKER_STATE/calls.log"
}
test_fake_docker_rejects_unknown_query_placeholder_and_option() {
  local code
  setup_sandbox
  set +e
  "$STARTAP_BACKUP_TEST_DOCKER_BIN" volume ls --filter label=tech.startap.backup-drill \
    --format '{{.ID}}' >/dev/null 2>&1
  code=$?
  set -e
  [ "$code" -ne 0 ]
  set +e
  "$STARTAP_BACKUP_TEST_DOCKER_BIN" volume inspect fixture --format '{{.ID}}' \
    >/dev/null 2>&1
  code=$?
  set -e
  [ "$code" -ne 0 ]
  set +e
  "$STARTAP_BACKUP_TEST_DOCKER_BIN" container inspect fixture --format '{{.Name}}' \
    --size >/dev/null 2>&1
  code=$?
  set -e
  [ "$code" -ne 0 ]
  set +e
  "$STARTAP_BACKUP_TEST_DOCKER_BIN" volume ls --filter label=tech.startap.backup-drill \
    --format '{{.Name}}' --quiet >/dev/null 2>&1
  code=$?
  set -e
  [ "$code" -ne 0 ]
}
test_mount_inspect_format_has_no_embedded_newline() {
  local helper="$SCRIPT_DIR/docker-helper.sh" fake="$TEST_DIR/fake-docker.sh" code
  ! grep -Fq '{{range .Mounts}}{{printf "%s|%s\n" .Type .Name}}{{end}}' "$helper"
  grep -Fq '{{range .Mounts}}{{printf "%s|%s" .Type .Name}}{{end}}' "$helper"
  setup_sandbox
  set +e
  "$STARTAP_BACKUP_TEST_DOCKER_BIN" container inspect fixture \
    --format '{{range .Mounts}}{{printf "%s|%s\n" .Type .Name}}{{end}}' \
    >/dev/null 2>&1
  code=$?
  set -e
  [ "$code" -ne 0 ]
  grep -Fq '{{range .Mounts}}{{printf "%s|%s" .Type .Name}}{{end}}' "$fake"
}
test_mount_inspect_multiline_response_fails_closed() {
  setup_sandbox; prepare_fake_drill
  export FAKE_DOCKER_MOUNT_OUTPUT_MODE=extra-line
  expect_failure drill_container_inspect_failed "$SCRIPT_DIR/docker-helper.sh" drill
  fake_resources_absent
  [ ! -e "$SANDBOX/report/$STARTAP_BACKUP_TEST_RUN_ID.json" ]
  [ ! -e "$SANDBOX/status/drill.json" ]
}
test_labelled_volume_without_journal_is_detected_and_preserved() {
  local suffix volume
  setup_sandbox
  suffix="${STARTAP_BACKUP_TEST_RUN_ID##*-}"
  volume="startap-backup-drill-${suffix}-data"
  printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$FAKE_DOCKER_STATE/volume-$volume"
  expect_failure drill_orphans_without_journal "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  [ -f "$FAKE_DOCKER_STATE/volume-$volume" ]
  ! grep -Eq '^(volume rm|rm -f)' "$FAKE_DOCKER_STATE/calls.log"
  grep -Fq 'volume ls --filter label=tech.startap.backup-drill --format \{\{.Name\}\}' \
    "$FAKE_DOCKER_STATE/calls.log"
}
test_volume_only_durable_tuple_is_reconciled() {
  local suffix container volume network
  setup_sandbox
  suffix="${STARTAP_BACKUP_TEST_RUN_ID##*-}"
  container="startap-backup-drill-$suffix"
  volume="startap-backup-drill-$suffix-data"
  network="startap-backup-drill-$suffix-net"
  printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$FAKE_DOCKER_STATE/volume-$volume"
  jq -n --arg run "$STARTAP_BACKUP_TEST_RUN_ID" --arg container "$container" \
    --arg volume "$volume" --arg network "$network" \
    '{schema_version:2,phase:"volume-created",run_id:$run,container:$container,
      volume:$volume,network:$network,label_key:"tech.startap.backup-drill"}' \
    >"$SANDBOX/drill-journal/docker-reconcile.json"
  "$SCRIPT_DIR/docker-reconcile.sh" reconcile >/dev/null
  [ ! -e "$FAKE_DOCKER_STATE/volume-$volume" ]
  [ ! -e "$SANDBOX/drill-journal/docker-reconcile.json" ]
}
test_docker_journal_uses_persistent_root_write_path_with_readonly_input() {
  setup_sandbox; prepare_fake_drill
  chmod 0555 "$SANDBOX/drill"
  "$SCRIPT_DIR/docker-helper.sh" drill
  chmod 0700 "$SANDBOX/drill"
  [ ! -e "$SANDBOX/drill-journal/.docker-reconcile.tmp" ]
  [ ! -e "$SANDBOX/drill-journal/docker-reconcile.json" ]
  jq -e '.status == "success" and .teardown_complete == true' \
    "$SANDBOX/report/$STARTAP_BACKUP_TEST_RUN_ID.json" >/dev/null
  grep -Fq 'ReadOnlyPaths=/etc/startap-backup /run/startap-backup-drill' \
    "$REPO_ROOT/infra/systemd/startap-backup-drill-restore.service"
  grep -Fq 'ReadWritePaths=/run/startap-backup-drill-query /var/lib/startap-backup/drill-journal ' \
    "$REPO_ROOT/infra/systemd/startap-backup-drill-restore.service"
}
test_docker_journal_removes_symlink_without_follow_and_refuses_hardlink() {
  setup_sandbox; prepare_fake_drill
  printf 'outside-unchanged\n' >"$SANDBOX/journal-outside"
  ln -s "$SANDBOX/journal-outside" "$SANDBOX/drill-journal/docker-reconcile.json"
  "$SCRIPT_DIR/docker-helper.sh" drill >/dev/null
  [ "$(sed -n '1p' "$SANDBOX/journal-outside")" = outside-unchanged ]
  [ ! -L "$SANDBOX/drill-journal/docker-reconcile.json" ]
  fake_resources_absent
  printf 'peer\n' >"$SANDBOX/state-peer"
  ln "$SANDBOX/state-peer" "$SANDBOX/drill-journal/.docker-reconcile.tmp"
  expect_failure drill_journal_temp_unsafe "$SCRIPT_DIR/docker-helper.sh" drill
  [ "$(file_links "$SANDBOX/state-peer")" = 2 ]
  fake_resources_absent
}
test_teardown_failure_propagates_no_success() {
  setup_sandbox; prepare_fake_drill; export FAKE_DOCKER_TEARDOWN_FAIL=volume
  expect_failure drill_teardown_failed "$SCRIPT_DIR/docker-helper.sh" drill
  [ ! -e "$SANDBOX/report/$STARTAP_BACKUP_TEST_RUN_ID.json" ]
  [ ! -e "$SANDBOX/status/drill.json" ]
}
test_sql_failure_tears_down_no_success() {
  setup_sandbox; prepare_fake_drill; export FAKE_DOCKER_RESTORE_FAIL=1
  expect_failure drill_restore_sql_failed "$SCRIPT_DIR/docker-helper.sh" drill
  fake_resources_absent; [ ! -e "$SANDBOX/status/drill.json" ]
  grep -Fq 'ON_ERROR_STOP=1' "$FAKE_DOCKER_STATE/calls.log"
}
test_nonempty_destination_refused_and_torn_down() {
  setup_sandbox; prepare_fake_drill; export STARTAP_BACKUP_TEST_FAILPOINT=preseed_destination
  expect_failure drill_destination_not_empty "$SCRIPT_DIR/docker-helper.sh" drill
  fake_resources_absent; [ ! -e "$SANDBOX/status/drill.json" ]
}
test_wrong_pg_refused_and_torn_down() {
  setup_sandbox; prepare_fake_drill; export FAKE_DOCKER_PG_VERSION=150000
  expect_failure drill_postgres_version_mismatch "$SCRIPT_DIR/docker-helper.sh" drill
  fake_resources_absent; [ ! -e "$SANDBOX/status/drill.json" ]
}
test_prod_like_destination_refused() {
  setup_sandbox; prepare_fake_drill; export STARTAP_BACKUP_TEST_DATABASE_NAME=startap_database
  expect_failure drill_database_name_unsafe "$SCRIPT_DIR/docker-helper.sh" drill
  fake_resources_absent; [ ! -e "$SANDBOX/status/drill.json" ]
}
test_docker_sigkill_reconciles_exact_resources_and_next_drill() {
  setup_sandbox; prepare_fake_drill
  export STARTAP_BACKUP_TEST_FAILPOINT=pause_after_docker_restore
  export STARTAP_BACKUP_TEST_PAUSE_SECONDS=300
  "$SCRIPT_DIR/docker-helper.sh" drill >"$SANDBOX/killed-drill.log" 2>&1 & drill_pid=$!
  suffix="${STARTAP_BACKUP_TEST_RUN_ID##*-}"
  observed=0
  for _ in $(seq 1 500); do
    if [ -f "$FAKE_DOCKER_STATE/container-startap-backup-drill-$suffix" ] &&
      [ -f "$FAKE_DOCKER_STATE/volume-startap-backup-drill-$suffix-data" ] &&
      [ -f "$FAKE_DOCKER_STATE/network-startap-backup-drill-$suffix-net" ] &&
      [ -f "$FAKE_DOCKER_STATE/restored" ] &&
      [ -f "$SANDBOX/drill-journal/docker-reconcile.json" ]; then observed=1; break; fi
    kill -0 "$drill_pid" 2>/dev/null || break
    sleep 0.01
  done
  [ "$observed" = 1 ]
  kill -KILL "$drill_pid"
  set +e; wait "$drill_pid"; killed_exit=$?; set -e
  [ "$killed_exit" -ne 0 ] && [ -f "$FAKE_DOCKER_STATE/restored" ]

  unset STARTAP_BACKUP_TEST_FAILPOINT STARTAP_BACKUP_TEST_PAUSE_SECONDS
  "$SCRIPT_DIR/docker-reconcile.sh" reconcile >/dev/null
  fake_resources_absent
  [ ! -e "$FAKE_DOCKER_STATE/restored" ] && [ ! -e "$SANDBOX/drill-journal/docker-reconcile.json" ]
  [ ! -e "$SANDBOX/drill/pending-run" ] && [ ! -e "$SANDBOX/drill/$STARTAP_BACKUP_TEST_RUN_ID" ]

  "$SCRIPT_DIR/drill-prepare.sh"
  "$SCRIPT_DIR/docker-helper.sh" drill
  jq -e '.status == "success" and .teardown_complete == true' \
    "$SANDBOX/report/$STARTAP_BACKUP_TEST_RUN_ID.json" >/dev/null
  fake_resources_absent
}
run_docker_power_loss_frontier() {
  local failpoint="$1" expected_phase="$2" expected_resource_count="$3" expected_restored="$4"
  local drill_pid observed=0 killed_exit resource_count phase
  setup_sandbox; prepare_fake_drill
  export STARTAP_BACKUP_TEST_FAILPOINT="$failpoint"
  export STARTAP_BACKUP_TEST_PAUSE_SECONDS=300
  "$SCRIPT_DIR/docker-helper.sh" drill >"$SANDBOX/power-loss.log" 2>&1 & drill_pid=$!
  for _ in $(seq 1 800); do
    if [ -f "$SANDBOX/drill-journal/docker-reconcile.json" ]; then
      phase="$(jq -r '.phase' "$SANDBOX/drill-journal/docker-reconcile.json" 2>/dev/null || true)"
      resource_count="$(find "$FAKE_DOCKER_STATE" -type f \
        \( -name 'container-*' -o -name 'volume-*' -o -name 'network-*' \) | wc -l | tr -d ' ')"
      if [ "$phase" = "$expected_phase" ] && [ "$resource_count" = "$expected_resource_count" ]; then
        if [ "$expected_restored" = true ] && [ ! -f "$FAKE_DOCKER_STATE/restored" ]; then
          :
        elif [ "$expected_restored" = false ] && [ -f "$FAKE_DOCKER_STATE/restored" ]; then
          :
        else
          observed=1
          break
        fi
      fi
    fi
    kill -0 "$drill_pid" 2>/dev/null || break
    sleep 0.01
  done
  [ "$observed" = 1 ]
  kill -KILL "$drill_pid"
  set +e; wait "$drill_pid"; killed_exit=$?; set -e
  [ "$killed_exit" -ne 0 ]
  [ -f "$SANDBOX/drill-journal/docker-reconcile.json" ]

  # Simulate reboot: tmpfs input and query scratch disappear, while the
  # dedicated /var/lib journal and Docker resources survive.
  find "$SANDBOX/drill" "$SANDBOX/docker-query" -depth -delete
  mkdir -p "$SANDBOX/drill" "$SANDBOX/docker-query"
  chmod 0700 "$SANDBOX/drill" "$SANDBOX/docker-query"
  unset STARTAP_BACKUP_TEST_FAILPOINT STARTAP_BACKUP_TEST_PAUSE_SECONDS
  "$SCRIPT_DIR/docker-reconcile.sh" reconcile >"$SANDBOX/reboot-reconcile.log" 2>&1
  fake_resources_absent
  [ ! -e "$FAKE_DOCKER_STATE/restored" ]
  [ ! -e "$SANDBOX/drill-journal/docker-reconcile.json" ]
  grep -Fq 'teardown_complete=true' "$SANDBOX/reboot-reconcile.log"
}
test_power_loss_after_journal_armed_recovers_after_run_loss() {
  run_docker_power_loss_frontier pause_after_journal_armed armed 0 false
}
test_power_loss_after_network_create_recovers_after_run_loss() {
  run_docker_power_loss_frontier pause_after_network_create network-created 1 false
}
test_power_loss_after_volume_create_recovers_after_run_loss() {
  run_docker_power_loss_frontier pause_after_volume_create volume-created 2 false
}
test_power_loss_after_container_create_recovers_after_run_loss() {
  run_docker_power_loss_frontier pause_after_docker_create container-created 3 false
}
test_power_loss_after_restore_removes_volume_plaintext() {
  run_docker_power_loss_frontier pause_after_docker_restore restore-complete 3 true
}
test_power_loss_during_teardown_resumes_from_durable_phase() {
  run_docker_power_loss_frontier pause_after_container_teardown container-absent 2 true
}
test_power_loss_network_created_before_phase_update_recovers() {
  run_docker_power_loss_frontier pause_after_network_create_before_journal armed 1 false
}
test_power_loss_volume_created_before_phase_update_recovers() {
  run_docker_power_loss_frontier pause_after_volume_create_before_journal network-created 2 false
}
test_power_loss_container_created_before_phase_update_recovers() {
  run_docker_power_loss_frontier pause_after_docker_create_before_journal volume-created 3 false
}
test_power_loss_restore_completed_before_phase_update_recovers() {
  run_docker_power_loss_frontier pause_after_docker_restore_before_journal container-created 3 true
}
test_power_loss_resource_removed_before_teardown_phase_update_recovers() {
  run_docker_power_loss_frontier pause_after_container_remove_before_journal teardown-started 2 true
}
test_missing_journal_with_labelled_orphans_fails_closed_without_delete() {
  setup_sandbox; seed_fake_reconcile_state
  rm -f -- "$SANDBOX/drill-journal/docker-reconcile.json"
  expect_failure drill_orphans_without_journal "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  ! fake_resources_absent
  [ ! -e "$FAKE_DOCKER_STATE/restored" ]
  ! grep -Eq '^(rm -f|volume rm|network rm)' "$FAKE_DOCKER_STATE/calls.log"
}
test_missing_journal_orphan_probe_error_fails_closed_and_sanitizes() {
  setup_sandbox; export FAKE_DOCKER_LIST_MODE=always-fail
  expect_failure drill_orphan_probe_failed "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  ! grep -Fq 'synthetic list failure detail' "$SANDBOX/expected-failure.log"
}
test_docker_reconciler_refuses_foreign_label_conflict() {
  setup_sandbox; prepare_fake_drill
  suffix="${STARTAP_BACKUP_TEST_RUN_ID##*-}"
  container="startap-backup-drill-$suffix"
  volume="startap-backup-drill-$suffix-data"
  network="startap-backup-drill-$suffix-net"
  printf 'foreign-owner\n' >"$FAKE_DOCKER_STATE/container-$container"
  jq -n --arg run "$STARTAP_BACKUP_TEST_RUN_ID" --arg container "$container" \
    --arg volume "$volume" --arg network "$network" \
    '{schema_version:2,phase:"container-created",run_id:$run,container:$container,
      volume:$volume,network:$network,label_key:"tech.startap.backup-drill"}' \
    >"$SANDBOX/drill-journal/docker-reconcile.json"
  expect_failure drill_reconcile_container_label_mismatch "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  [ "$(sed -n '1p' "$FAKE_DOCKER_STATE/container-$container")" = foreign-owner ]
  [ -f "$SANDBOX/drill-journal/docker-reconcile.json" ]
}
test_docker_inspect_daemon_error_keeps_reconcile_state() {
  setup_sandbox; prepare_fake_drill; seed_fake_reconcile_state
  export FAKE_DOCKER_INSPECT_MODE=always-fail
  expect_failure drill_reconcile_container_inspect_failed "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  [ -f "$SANDBOX/drill-journal/docker-reconcile.json" ]
  ! fake_resources_absent
  ! grep -Fq 'synthetic daemon unavailable detail' "$SANDBOX/expected-failure.log"
}
test_docker_inspect_timeout_keeps_reconcile_state() {
  setup_sandbox; prepare_fake_drill; seed_fake_reconcile_state
  export FAKE_DOCKER_INSPECT_MODE=timeout
  export STARTAP_BACKUP_TEST_DOCKER_QUERY_TIMEOUT_SECONDS=0.05
  expect_failure drill_reconcile_container_inspect_failed "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  [ -f "$SANDBOX/drill-journal/docker-reconcile.json" ]
  ! fake_resources_absent
  ! grep -Eq 'sleep 30|Terminated' "$SANDBOX/expected-failure.log" || {
    sed -n '1,5p' "$SANDBOX/expected-failure.log" >&2
    return 1
  }
}
test_docker_inspect_permission_error_keeps_reconcile_state() {
  setup_sandbox; prepare_fake_drill; seed_fake_reconcile_state
  export FAKE_DOCKER_INSPECT_MODE=permission
  expect_failure drill_reconcile_container_inspect_failed "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  [ -f "$SANDBOX/drill-journal/docker-reconcile.json" ]
  ! fake_resources_absent
  ! grep -Fq 'permission denied opening synthetic docker socket' "$SANDBOX/expected-failure.log"
}
test_docker_inspect_exact_not_found_allows_reconcile() {
  setup_sandbox; prepare_fake_drill; seed_fake_reconcile_state
  find "$FAKE_DOCKER_STATE" -type f \( -name 'container-*' -o -name 'volume-*' -o -name 'network-*' \) -delete
  export FAKE_DOCKER_INSPECT_MODE=not-found
  "$SCRIPT_DIR/docker-reconcile.sh" reconcile >"$SANDBOX/reconcile.log" 2>&1
  [ ! -e "$SANDBOX/drill-journal/docker-reconcile.json" ]
  [ ! -e "$SANDBOX/drill/pending-run" ]
  ! grep -Fq 'No such' "$SANDBOX/reconcile.log"
}
test_docker_inspect_actual_present_is_removed_and_verified() {
  setup_sandbox; prepare_fake_drill; seed_fake_reconcile_state
  "$SCRIPT_DIR/docker-reconcile.sh" reconcile >"$SANDBOX/reconcile.log" 2>&1
  fake_resources_absent
  [ ! -e "$SANDBOX/drill-journal/docker-reconcile.json" ]
  grep -Fq 'teardown_complete=true' "$SANDBOX/reconcile.log"
}

setup_anchor_repo() {
  ANCHOR_REPO="$SANDBOX/anchor-repo"; mkdir "$ANCHOR_REPO"; git -C "$ANCHOR_REPO" init -q -b main
  printf seed >"$ANCHOR_REPO/README"; git -C "$ANCHOR_REPO" add README
  git -C "$ANCHOR_REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm seed
  ANCHOR_BASE="$(git -C "$ANCHOR_REPO" rev-parse HEAD)"
  git -C "$ANCHOR_REPO" remote add origin git@github.com:BrunoMediador/startap-backups.git
}
anchor_add_run() {
  local run="$1" char="$2" path="dumps/${run:0:4}/${run:4:2}/$run/manifest.json"
  local artifact artifact_path artifact_sha artifact_size
  artifact="backup-${run%-*}.sql.gz.age"; artifact_path="${path%/manifest.json}/$artifact"
  mkdir -p "$ANCHOR_REPO/${path%/*}"
  printf 'fixture-ciphertext-%s-%s' "$char" "$run" >"$ANCHOR_REPO/$artifact_path"
  artifact_sha="$(sha256_file "$ANCHOR_REPO/$artifact_path")"
  artifact_size="$(file_size "$ANCHOR_REPO/$artifact_path")"
  jq -n --arg run_id "$run" --arg artifact "$artifact" --arg sha "$artifact_sha" \
    --argjson size "$artifact_size" \
    '{schema_version:1,run_id:$run,artifact:$artifact,sha256:$sha,size_bytes:$size}' >"$ANCHOR_REPO/$path"
  git -C "$ANCHOR_REPO" add "$path" "$artifact_path"
  git -C "$ANCHOR_REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm "$run"
  ANCHOR_COMMIT="$(git -C "$ANCHOR_REPO" rev-parse HEAD)"
  ANCHOR_MANIFEST_SHA="$(sha256_file "$ANCHOR_REPO/$path")"; ANCHOR_ARTIFACT_SHA="$artifact_sha"
  ANCHOR_ARTIFACT_SIZE="$artifact_size"; ANCHOR_PATH="$path"; ANCHOR_ARTIFACT_PATH="$artifact_path"
}
anchor_health() {
  local output="$1" run="$2"
  jq -n --arg run "$run" --arg commit "$ANCHOR_COMMIT" --arg msha "$ANCHOR_MANIFEST_SHA" \
    --arg path "$ANCHOR_PATH" --arg apath "$ANCHOR_ARTIFACT_PATH" --arg asha "$ANCHOR_ARTIFACT_SHA" \
    --argjson size "$ANCHOR_ARTIFACT_SIZE" \
    '{schema_version:1,state:"healthy",external_anchor_required:true,recovery_tuple_coherent:true,
      local:{state:"healthy",run_id:$run,manifest_sha256:$msha,sha256:$asha,size_bytes:$size},
      offsite:{state:"healthy",run_id:$run,commit_sha:$commit,manifest_sha256:$msha,
        manifest_path:$path,artifact_path:$apath,sha256:$asha,size_bytes:$size}}' >"$output"
}
test_anchor_descendant_valid() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  anchor_health "$SANDBOX/h1.json" "$run1"; "$SCRIPT_DIR/anchor-verify.sh" bootstrap "$ANCHOR_REPO" "$SANDBOX/h1.json" - "$SANDBOX/anchor.json"
  run2=20260814T020202Z-22222222; anchor_add_run "$run2" b; anchor_health "$SANDBOX/h2.json" "$run2"
  "$SCRIPT_DIR/anchor-verify.sh" verify "$ANCHOR_REPO" "$SANDBOX/h2.json" "$SANDBOX/anchor.json" "$SANDBOX/anchor2.json"
  [ "$(jq -r '.run_id' "$SANDBOX/anchor2.json")" = "$run2" ]
}
test_anchor_missing_fails_closed() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  anchor_health "$SANDBOX/h.json" "$run1"
  expect_failure anchor_previous_missing "$SCRIPT_DIR/anchor-verify.sh" verify "$ANCHOR_REPO" "$SANDBOX/h.json" "$SANDBOX/missing" "$SANDBOX/out"
}
test_anchor_tuple_mismatch_fails_closed() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  anchor_health "$SANDBOX/h1.json" "$run1"; "$SCRIPT_DIR/anchor-verify.sh" bootstrap "$ANCHOR_REPO" "$SANDBOX/h1.json" - "$SANDBOX/anchor.json"
  jq '.manifest_sha256=("f"*64)' "$SANDBOX/anchor.json" >"$SANDBOX/bad-anchor.json"
  expect_failure anchor_manifest_hash_mismatch "$SCRIPT_DIR/anchor-verify.sh" verify "$ANCHOR_REPO" "$SANDBOX/h1.json" "$SANDBOX/bad-anchor.json" "$SANDBOX/out"
}
test_anchor_artifact_blob_missing_fails_closed() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  git -C "$ANCHOR_REPO" rm -q -- "$ANCHOR_ARTIFACT_PATH"
  git -C "$ANCHOR_REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm missing
  ANCHOR_COMMIT="$(git -C "$ANCHOR_REPO" rev-parse HEAD)"; anchor_health "$SANDBOX/h.json" "$run1"
  expect_failure anchor_artifact_blob_missing "$SCRIPT_DIR/anchor-verify.sh" bootstrap "$ANCHOR_REPO" "$SANDBOX/h.json" - "$SANDBOX/out"
}
test_anchor_artifact_blob_altered_fails_closed() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  printf tampered >"$ANCHOR_REPO/$ANCHOR_ARTIFACT_PATH"
  git -C "$ANCHOR_REPO" add "$ANCHOR_ARTIFACT_PATH"
  git -C "$ANCHOR_REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm tampered
  ANCHOR_COMMIT="$(git -C "$ANCHOR_REPO" rev-parse HEAD)"; anchor_health "$SANDBOX/h.json" "$run1"
  expect_failure anchor_artifact_blob_hash_mismatch "$SCRIPT_DIR/anchor-verify.sh" bootstrap "$ANCHOR_REPO" "$SANDBOX/h.json" - "$SANDBOX/out"
}
test_anchor_current_manifest_symlink_mode_refused() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  rm -- "$ANCHOR_REPO/$ANCHOR_PATH"; ln -s README "$ANCHOR_REPO/$ANCHOR_PATH"
  git -C "$ANCHOR_REPO" add "$ANCHOR_PATH"
  git -C "$ANCHOR_REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm symlink
  ANCHOR_COMMIT="$(git -C "$ANCHOR_REPO" rev-parse HEAD)"; anchor_health "$SANDBOX/h.json" "$run1"
  expect_failure anchor_manifest_git_mode_refused "$SCRIPT_DIR/anchor-verify.sh" bootstrap \
    "$ANCHOR_REPO" "$SANDBOX/h.json" - "$SANDBOX/out"
}
test_anchor_current_artifact_executable_mode_refused() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  chmod 0755 "$ANCHOR_REPO/$ANCHOR_ARTIFACT_PATH"; git -C "$ANCHOR_REPO" add "$ANCHOR_ARTIFACT_PATH"
  git -C "$ANCHOR_REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm executable
  ANCHOR_COMMIT="$(git -C "$ANCHOR_REPO" rev-parse HEAD)"; anchor_health "$SANDBOX/h.json" "$run1"
  expect_failure anchor_artifact_git_mode_refused "$SCRIPT_DIR/anchor-verify.sh" bootstrap \
    "$ANCHOR_REPO" "$SANDBOX/h.json" - "$SANDBOX/out"
}
test_anchor_previous_artifact_gitlink_mode_refused() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  anchor_health "$SANDBOX/h1.json" "$run1"
  "$SCRIPT_DIR/anchor-verify.sh" bootstrap "$ANCHOR_REPO" "$SANDBOX/h1.json" - "$SANDBOX/anchor.json"
  git -C "$ANCHOR_REPO" update-index --add --cacheinfo 160000,"$ANCHOR_BASE","$ANCHOR_ARTIFACT_PATH"
  git -C "$ANCHOR_REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm gitlink
  bad_commit="$(git -C "$ANCHOR_REPO" rev-parse HEAD)"
  jq --arg commit "$bad_commit" '.commit_sha=$commit' "$SANDBOX/anchor.json" >"$SANDBOX/bad-anchor.json"
  run2=20260814T020202Z-22222222; anchor_add_run "$run2" b; anchor_health "$SANDBOX/h2.json" "$run2"
  expect_failure anchor_artifact_git_mode_refused "$SCRIPT_DIR/anchor-verify.sh" verify \
    "$ANCHOR_REPO" "$SANDBOX/h2.json" "$SANDBOX/bad-anchor.json" "$SANDBOX/out"
}
test_anchor_previous_manifest_executable_mode_refused() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  anchor_health "$SANDBOX/h1.json" "$run1"
  "$SCRIPT_DIR/anchor-verify.sh" bootstrap "$ANCHOR_REPO" "$SANDBOX/h1.json" - "$SANDBOX/anchor.json"
  chmod 0755 "$ANCHOR_REPO/$ANCHOR_PATH"; git -C "$ANCHOR_REPO" add "$ANCHOR_PATH"
  git -C "$ANCHOR_REPO" -c user.name=Fixture -c user.email=fixture@example.invalid commit -qm executable
  bad_commit="$(git -C "$ANCHOR_REPO" rev-parse HEAD)"
  jq --arg commit "$bad_commit" '.commit_sha=$commit' "$SANDBOX/anchor.json" >"$SANDBOX/bad-anchor.json"
  run2=20260814T020202Z-22222222; anchor_add_run "$run2" b; anchor_health "$SANDBOX/h2.json" "$run2"
  expect_failure anchor_manifest_git_mode_refused "$SCRIPT_DIR/anchor-verify.sh" verify \
    "$ANCHOR_REPO" "$SANDBOX/h2.json" "$SANDBOX/bad-anchor.json" "$SANDBOX/out"
}
test_anchor_weird_path_refused() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  anchor_health "$SANDBOX/h.json" "$run1"
  jq '.offsite.manifest_path += "\nmanifest.json"' "$SANDBOX/h.json" >"$SANDBOX/weird.json"
  expect_failure anchor_health_tuple_invalid "$SCRIPT_DIR/anchor-verify.sh" bootstrap \
    "$ANCHOR_REPO" "$SANDBOX/weird.json" - "$SANDBOX/out"
}
test_anchor_local_offsite_tuple_divergence_fails_closed() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  anchor_health "$SANDBOX/h.json" "$run1"
  jq '.local.sha256=("f"*64)' "$SANDBOX/h.json" >"$SANDBOX/divergent.json"
  expect_failure anchor_health_tuple_invalid "$SCRIPT_DIR/anchor-verify.sh" bootstrap "$ANCHOR_REPO" "$SANDBOX/divergent.json" - "$SANDBOX/out"
}
test_anchor_rewrite_fails_closed() {
  setup_sandbox; setup_anchor_repo; run1=20260814T010101Z-11111111; anchor_add_run "$run1" a
  anchor_health "$SANDBOX/h1.json" "$run1"; "$SCRIPT_DIR/anchor-verify.sh" bootstrap "$ANCHOR_REPO" "$SANDBOX/h1.json" - "$SANDBOX/anchor.json"
  git -C "$ANCHOR_REPO" checkout -q --detach "$ANCHOR_BASE"
  run2=20260814T020202Z-22222222; anchor_add_run "$run2" b; anchor_health "$SANDBOX/h2.json" "$run2"
  expect_failure anchor_history_rewrite_detected "$SCRIPT_DIR/anchor-verify.sh" verify "$ANCHOR_REPO" "$SANDBOX/h2.json" "$SANDBOX/anchor.json" "$SANDBOX/out"
}

test_known_hosts_and_restricted_shell() {
  setup_sandbox
  ! grep -Eq '^\[187\.77\.242\.220\]:22' "$REPO_ROOT/.github/backup-known_hosts"
  grep -Eq '^187\.77\.242\.220[[:space:]]+ssh-ed25519' "$REPO_ROOT/.github/backup-known_hosts"
  ssh-keygen -F 187.77.242.220 -f "$REPO_ROOT/.github/backup-known_hosts" >/dev/null
  ! rg -n 'ssh-keyscan|StrictHostKeyChecking[= ]no' "$REPO_ROOT/.github/workflows" \
    "$SCRIPT_DIR/uploader.sh" "$SCRIPT_DIR/install.sh"
  export SSH_ORIGINAL_COMMAND=arbitrary
  expect_failure external_command_refused "$SCRIPT_DIR/ssh-shell.sh" -c "$SCRIPT_DIR/external-command.sh"
  expect_failure restricted_shell_refused "$SCRIPT_DIR/ssh-shell.sh" -c /bin/sh
  grep -Eq '^restrict,command="/usr/local/libexec/startap-backup/external-command\.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 ' \
    "$SCRIPT_DIR/status-authorized_keys.example"
}
test_dump_helper_consumes_invalid_marker_without_retrigger() {
  setup_sandbox; printf 'not-a-run\n' >"$SANDBOX/run/request-run"; chmod 0600 "$SANDBOX/run/request-run"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ ! -e "$SANDBOX/run/request-run" ]
  ! find "$SANDBOX/dump-claims" -mindepth 1 -maxdepth 1 -name '.request.*.claim' -print | grep -q .
  "$SCRIPT_DIR/cycle.sh"; [ -f "$(generation)/COMPLETE" ]
}
test_dump_helper_consumes_symlink_marker_without_following() {
  setup_sandbox; printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$SANDBOX/outside-marker"
  ln -s "$SANDBOX/outside-marker" "$SANDBOX/run/request-run"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ ! -e "$SANDBOX/run/request-run" ] && [ -f "$SANDBOX/outside-marker" ]
  [ "$(sed -n '1p' "$SANDBOX/outside-marker")" = "$STARTAP_BACKUP_TEST_RUN_ID" ]
}
test_dump_helper_consumes_broken_symlink_marker_and_next_cycle_converges() {
  setup_sandbox
  outside="$SANDBOX/missing-request-target"
  ln -s "$outside" "$SANDBOX/run/request-run"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ ! -e "$SANDBOX/run/request-run" ] && [ ! -L "$SANDBOX/run/request-run" ]
  [ ! -e "$outside" ] && [ ! -L "$outside" ]
  "$SCRIPT_DIR/cycle.sh" >/dev/null
  [ -f "$(generation)/COMPLETE" ]
}
test_dump_helper_consumes_broken_active_claim_and_next_cycle_converges() {
  setup_sandbox
  outside="$SANDBOX/missing-active-target"
  ln -s "$outside" "$SANDBOX/dump-claims/active-run"
  "$SCRIPT_DIR/cycle.sh" >/dev/null
  [ ! -e "$SANDBOX/dump-claims/active-run" ] && [ ! -L "$SANDBOX/dump-claims/active-run" ]
  [ ! -e "$outside" ] && [ ! -L "$outside" ]
  [ -f "$(generation)/COMPLETE" ]
}
test_dump_helper_consumes_broken_cleanup_marker_and_next_cycle_converges() {
  setup_sandbox
  outside="$SANDBOX/missing-cleanup-target"
  ln -s "$outside" "$SANDBOX/run/cleanup-request"
  expect_failure dump_cleanup_request_quarantined "$SCRIPT_DIR/dump-helper.sh" cleanup
  [ ! -e "$SANDBOX/run/cleanup-request" ] && [ ! -L "$SANDBOX/run/cleanup-request" ]
  [ ! -e "$outside" ] && [ ! -L "$outside" ]
  "$SCRIPT_DIR/cycle.sh" >/dev/null
  [ -f "$(generation)/COMPLETE" ]
}
test_producer_reconcile_request_replaces_broken_link_without_following() {
  setup_sandbox
  outside="$SANDBOX/missing-bridge-target"
  ln -s "$outside" "$SANDBOX/bridge/reconcile-request"
  "$SCRIPT_DIR/producer-reconcile-request.sh" async >"$SANDBOX/request.log" 2>&1
  [ ! -L "$SANDBOX/bridge/reconcile-request" ] && [ -f "$SANDBOX/bridge/reconcile-request" ]
  [ ! -e "$outside" ] && [ ! -L "$outside" ]
  "$SCRIPT_DIR/producer-reconcile.sh" >/dev/null
  [ -f "$SANDBOX/bridge-ack/reconcile-complete" ]
  grep -Fq 'event=producer_reconcile_request_symlink_removed' "$SANDBOX/request.log"
}
test_producer_reconciler_claims_broken_link_no_follow_then_next_request_converges() {
  setup_sandbox
  outside="$SANDBOX/missing-current-claim-target"
  ln -s "$outside" "$SANDBOX/bridge/reconcile-request"
  expect_failure producer_reconcile_claim_symlink_removed "$SCRIPT_DIR/producer-reconcile.sh"
  [ ! -e "$SANDBOX/bridge/reconcile-request" ] && [ ! -L "$SANDBOX/bridge/reconcile-request" ]
  [ ! -e "$outside" ] && [ ! -L "$outside" ]
  "$SCRIPT_DIR/producer-reconcile-request.sh" async >/dev/null
  "$SCRIPT_DIR/producer-reconcile.sh" >/dev/null
  [ -f "$SANDBOX/bridge-ack/reconcile-complete" ]
}
test_drill_pending_broken_link_is_cleaned_then_next_drill_converges() {
  setup_sandbox; "$SCRIPT_DIR/cycle.sh" >/dev/null; "$SCRIPT_DIR/drill-prepare.sh" >/dev/null
  outside="$SANDBOX/missing-pending-target"
  rm -f -- "$SANDBOX/drill/pending-run"
  ln -s "$outside" "$SANDBOX/drill/pending-run"
  "$SCRIPT_DIR/docker-reconcile.sh" reconcile >"$SANDBOX/pending-reconcile.log" 2>&1
  [ ! -e "$SANDBOX/drill/pending-run" ] && [ ! -L "$SANDBOX/drill/pending-run" ]
  [ ! -e "$SANDBOX/drill/$STARTAP_BACKUP_TEST_RUN_ID" ] &&
    [ ! -L "$SANDBOX/drill/$STARTAP_BACKUP_TEST_RUN_ID" ]
  [ ! -e "$outside" ] && [ ! -L "$outside" ]
  assert_no_plaintext
  "$SCRIPT_DIR/drill-prepare.sh" >/dev/null
  "$SCRIPT_DIR/docker-helper.sh" drill >/dev/null
  jq -e '.status == "success" and .teardown_complete == true' \
    "$SANDBOX/report/$STARTAP_BACKUP_TEST_RUN_ID.json" >/dev/null
}
test_journal_broken_link_is_unlinked_without_hiding_labelled_orphan() {
  setup_sandbox; seed_fake_reconcile_state
  outside="$SANDBOX/missing-journal-target"
  rm -f -- "$SANDBOX/drill-journal/docker-reconcile.json"
  ln -s "$outside" "$SANDBOX/drill-journal/docker-reconcile.json"
  expect_failure drill_orphans_without_journal "$SCRIPT_DIR/docker-reconcile.sh" reconcile
  [ ! -e "$SANDBOX/drill-journal/docker-reconcile.json" ] &&
    [ ! -L "$SANDBOX/drill-journal/docker-reconcile.json" ]
  [ ! -e "$outside" ] && [ ! -L "$outside" ]
  ! fake_resources_absent
}
test_dump_helper_consumes_hardlink_marker_without_mutating_peer() {
  setup_sandbox; printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$SANDBOX/outside-marker"
  ln "$SANDBOX/outside-marker" "$SANDBOX/run/request-run"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ ! -e "$SANDBOX/run/request-run" ] && [ -f "$SANDBOX/outside-marker" ]
  [ "$(file_links "$SANDBOX/outside-marker")" = 1 ]
}
assert_special_dump_marker_consumed_then_valid_cycle() {
  [ ! -e "$SANDBOX/run/request-run" ] && [ ! -L "$SANDBOX/run/request-run" ]
  ! find "$SANDBOX/dump-claims" -mindepth 1 -maxdepth 1 -name '.request.*.claim' -print | grep -q .
  "$SCRIPT_DIR/cycle.sh" >/dev/null
  [ -f "$(generation)/COMPLETE" ]
}
test_dump_helper_consumes_empty_directory_marker() {
  setup_sandbox; mkdir "$SANDBOX/run/request-run"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  assert_special_dump_marker_consumed_then_valid_cycle
}
test_dump_helper_consumes_nonempty_directory_marker() {
  setup_sandbox; mkdir -p "$SANDBOX/run/request-run/nested"
  printf 'do-not-follow\n' >"$SANDBOX/outside-directory-target"
  ln -s "$SANDBOX/outside-directory-target" "$SANDBOX/run/request-run/nested/link"
  printf 'untrusted\n' >"$SANDBOX/run/request-run/nested/value"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ "$(sed -n '1p' "$SANDBOX/outside-directory-target")" = do-not-follow ]
  assert_special_dump_marker_consumed_then_valid_cycle
}
test_dump_helper_consumes_fifo_marker_without_opening() {
  setup_sandbox; mkfifo "$SANDBOX/run/request-run"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  assert_special_dump_marker_consumed_then_valid_cycle
}
test_dump_helper_consumes_socket_marker_without_opening() {
  setup_sandbox
  python3 - "$SANDBOX/run/request-run" <<'PY'
import socket
import sys
s = socket.socket(socket.AF_UNIX)
s.bind(sys.argv[1])
s.close()
PY
  [ -S "$SANDBOX/run/request-run" ]
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  assert_special_dump_marker_consumed_then_valid_cycle
}
test_dump_helper_consumes_oversized_regular_marker() {
  setup_sandbox
  head -c 1024 /dev/zero | tr '\0' x >"$SANDBOX/run/request-run"
  chmod 0600 "$SANDBOX/run/request-run"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ ! -e "$SANDBOX/run/request-run" ]
  [ ! -e "$SANDBOX/dump-claims/active-run" ]
  assert_special_dump_marker_consumed_then_valid_cycle
}
test_dump_helper_bounded_recovery_consumes_more_than_128_entries() {
  setup_sandbox; mkdir "$SANDBOX/run/request-run"
  for index in $(seq 1 300); do printf 'invalid\n' >"$SANDBOX/run/request-run/entry-$index"; done
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ ! -e "$SANDBOX/run/request-run" ]
  find "$SANDBOX/dump-claims/quarantine" -mindepth 1 -maxdepth 1 -print | grep -q .
  assert_special_dump_marker_consumed_then_valid_cycle
  ! find "$SANDBOX/dump-claims/quarantine" -mindepth 1 -maxdepth 1 -print | grep -q .
}
test_dump_helper_nested_quarantine_never_follows_link() {
  setup_sandbox; marker="$SANDBOX/run/request-run"; mkdir "$marker"; nested="$marker"
  for _ in $(seq 1 100); do nested="$nested/d"; mkdir "$nested"; done
  printf 'outside-unchanged\n' >"$SANDBOX/outside-nested-target"
  ln -s "$SANDBOX/outside-nested-target" "$nested/link"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ "$(sed -n '1p' "$SANDBOX/outside-nested-target")" = outside-unchanged ]
  [ ! -e "$SANDBOX/run/request-run" ]
  ! find "$SANDBOX/dump-claims/quarantine" -mindepth 1 -maxdepth 1 -print | grep -q .
  assert_special_dump_marker_consumed_then_valid_cycle
}
test_producer_reconciler_drains_more_than_32_stale_claims() {
  setup_sandbox; mkdir "$SANDBOX/run/request-run"
  for index in $(seq 1 140); do
    printf 'oversized\n' >"$SANDBOX/run/request-run/entry-$index"
  done
  for index in $(seq 1 40); do
    printf 'stale\n' >"$SANDBOX/dump-claims/.request.stale-$index.claim"
  done
  "$SCRIPT_DIR/producer-reconcile-request.sh" async >/dev/null
  "$SCRIPT_DIR/producer-reconcile.sh" >"$SANDBOX/reconcile.log" 2>&1
  [ -f "$SANDBOX/bridge-ack/reconcile-complete" ]
  [ ! -e "$SANDBOX/run/request-run" ]
  ! find "$SANDBOX/dump-claims" -mindepth 1 -maxdepth 1 -name '.request.*.claim' -print | grep -q .
  ! find "$SANDBOX/dump-claims/quarantine" -mindepth 1 -maxdepth 1 -print | grep -q .
  "$SCRIPT_DIR/cycle.sh" >/dev/null
  [ -f "$(generation)/COMPLETE" ]
}
test_marker_quarantine_has_bounded_no_follow_contract() {
  grep -Fq 'backup_quarantine_recover 256' "$SCRIPT_DIR/dump-helper.sh"
  grep -Fq 'backup_quarantine_recover 512' "$SCRIPT_DIR/producer-reconcile.sh"
  grep -Fq 'd /run/startap-backup-dump-helper/quarantine  0700 root' \
    "$REPO_ROOT/infra/systemd/startap-backup.tmpfiles"
  ! rg -n 'find .*quarant.*-delete|find .*claim.*-delete' \
    "$SCRIPT_DIR/quarantine.sh" "$SCRIPT_DIR/dump-helper.sh" "$SCRIPT_DIR/producer-reconcile.sh"
  ! rg -n 'find .*-[LH]' "$SCRIPT_DIR/quarantine.sh"
}
test_dump_helper_race_is_serialized_after_atomic_claim() {
  setup_sandbox; printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$SANDBOX/run/request-run"; chmod 0600 "$SANDBOX/run/request-run"
  "$SCRIPT_DIR/dump-helper.sh" dump >"$SANDBOX/helper-one.log" 2>&1 & helper_pid=$!
  for _ in $(seq 1 200); do [ ! -e "$SANDBOX/run/request-run" ] && [ -p "$SANDBOX/run/dump/$STARTAP_BACKUP_TEST_RUN_ID/dump.fifo" ] && break; sleep 0.01; done
  [ ! -e "$SANDBOX/run/request-run" ]
  expect_failure dump_helper_concurrent "$SCRIPT_DIR/dump-helper.sh" dump
  cat "$SANDBOX/run/dump/$STARTAP_BACKUP_TEST_RUN_ID/dump.fifo" >/dev/null & reader_pid=$!
  wait "$helper_pid"; wait "$reader_pid"
  printf '%s\n' "$STARTAP_BACKUP_TEST_RUN_ID" >"$SANDBOX/run/cleanup-request"; chmod 0600 "$SANDBOX/run/cleanup-request"
  "$SCRIPT_DIR/dump-helper.sh" cleanup >/dev/null
  [ ! -e "$SANDBOX/dump-claims/active-run" ] && [ ! -e "$SANDBOX/run/dump" ]
}
test_dump_helper_recovers_stale_sigkill_lease() {
  setup_sandbox; mkdir "$SANDBOX/dump-claims/helper.lock"
  printf '99999999\n' >"$SANDBOX/dump-claims/helper.lock/pid"; chmod 0600 "$SANDBOX/dump-claims/helper.lock/pid"
  printf 'invalid\n' >"$SANDBOX/run/request-run"; chmod 0600 "$SANDBOX/run/request-run"
  expect_failure dump_request_quarantined "$SCRIPT_DIR/dump-helper.sh" dump
  [ ! -e "$SANDBOX/dump-claims/helper.lock" ] && [ ! -e "$SANDBOX/run/request-run" ]
}
test_dump_path_rate_limits_are_explicit() {
  for unit in startap-backup-dump.path startap-backup-dump-cleanup.path; do
    grep -Fq 'TriggerLimitIntervalSec=60' "$REPO_ROOT/infra/systemd/$unit"
    grep -Fq 'TriggerLimitBurst=3' "$REPO_ROOT/infra/systemd/$unit"
    grep -Fq 'StartLimitIntervalSec=60' "$REPO_ROOT/infra/systemd/$unit"
    grep -Fq 'StartLimitBurst=3' "$REPO_ROOT/infra/systemd/$unit"
  done
  grep -Fq '/run/startap-backup-dump-helper' "$REPO_ROOT/infra/systemd/startap-backup.tmpfiles"
}
test_legacy_dump_forced_command_streams_only_fixture() {
  setup_sandbox; export SSH_ORIGINAL_COMMAND=dump
  "$SCRIPT_DIR/legacy-dump-shell.sh" -c "$SCRIPT_DIR/legacy-dump-command.sh" >"$SANDBOX/legacy.sql"
  cmp -s "$SANDBOX/fixture.sql" "$SANDBOX/legacy.sql"
  export SSH_ORIGINAL_COMMAND='dump; id'
  expect_failure legacy_dump_command_refused "$SCRIPT_DIR/legacy-dump-shell.sh" -c "$SCRIPT_DIR/legacy-dump-command.sh"
  export SSH_ORIGINAL_COMMAND=dump
  expect_failure legacy_dump_shell_refused "$SCRIPT_DIR/legacy-dump-shell.sh" -c /bin/sh
}
test_workflows_have_no_root_key_and_require_main_environments() {
  legacy="$REPO_ROOT/.github/workflows/backup-postgres.yml"
  detector="$REPO_ROOT/.github/workflows/backup-resilience-detector.yml"
  retention="$REPO_ROOT/.github/workflows/backup-postgres-cleanup.yml"
  ! rg -n 'SSH_PRIVATE_KEY|root@187\.77\.242\.220|User root' "$legacy" "$detector" "$retention"
  grep -Fq 'environment: backup-legacy-main' "$legacy"
  grep -Fq "github.ref == 'refs/heads/main'" "$legacy" "$detector"
  grep -Fq 'environment: backup-status-main' "$detector"
  [ "$(grep -Fc 'environment: backup-recovery-main' "$detector")" -eq 2 ]
  grep -Fq 'environment: backup-status-main' "$retention"
  grep -Fq 'BACKUP_REPO_READONLY_SSH_KEY' "$retention"
  ! rg -n 'BACKUP_REPO_SSH_KEY|git rm|git push|DELETE_APPROVED|rm .*dumps' "$retention"
  grep -Fq 'preflight_github_environments' "$SCRIPT_DIR/install.sh"
  grep -Fq 'repository_level_backup_secrets_absent == true' "$SCRIPT_DIR/github-environment-verify.sh"
  jq -e '.environments | length == 3' "$SCRIPT_DIR/github-environment-proof.json.example" >/dev/null
  grep -Eq '^restrict,command="/usr/local/libexec/startap-backup/legacy-dump-command\.sh",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ssh-ed25519 ' \
    "$SCRIPT_DIR/legacy-dump-authorized_keys.example"
}
test_github_environment_proof_rejects_branch_expansion() {
  setup_sandbox
  jq '.captured_at="20260814T120000Z"' "$SCRIPT_DIR/github-environment-proof.json.example" \
    >"$SANDBOX/environment-proof.json"
  "$SCRIPT_DIR/github-environment-verify.sh" "$SANDBOX/environment-proof.json" >/dev/null
  jq '(.environments[] | select(.name == "backup-status-main") | .allowed_refs) += ["refs/heads/feature"]' \
    "$SANDBOX/environment-proof.json" >"$SANDBOX/environment-proof-expanded.json"
  expect_failure github_environment_proof_invalid "$SCRIPT_DIR/github-environment-verify.sh" \
    "$SANDBOX/environment-proof-expanded.json"
}
test_legacy_encryption_is_mandatory_and_pinned() {
  workflow="$REPO_ROOT/.github/workflows/backup-postgres.yml"
  grep -Fq "AGE_VERSION='1.3.1'" "$workflow"
  grep -Fq "AGE_ARCHIVE_SHA256='bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377'" "$workflow"
  grep -Fq 'test -n "$BACKUP_AGE_PUBKEY"' "$workflow"
  grep -Fq 'OUTFILE="${OUTDIR}/${TIMESTAMP}.sql.gz.age"' "$workflow"
  ! rg -n 'apt-get|backup NÃO cifrado|OUTFILE=.*\.sql\.gz"' "$workflow"
}
test_custody_and_cutover_guards_static() {
  grep -Fq 'readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin' "$SCRIPT_DIR/common.sh"
  grep -Fq 'verify_installer_binaries' "$SCRIPT_DIR/install.sh"
  grep -Fq '/usr/bin/ssh -G -F /dev/null' "$SCRIPT_DIR/install.sh"
  grep -Fq 'duplicate_recipient_refused' "$SCRIPT_DIR/common.sh"
  grep -Fq 'automation_count' "$SCRIPT_DIR/identity-preflight.sh"
  grep -Fq 'automation_recipient_count_invalid' "$SCRIPT_DIR/identity-preflight.sh"
  grep -Fq 'BRUNO_OFFLINE_PROOF.json' "$SCRIPT_DIR/install.sh"
  grep -Fq 'startap-backup-identity-preflight.service' "$SCRIPT_DIR/install.sh"
  grep -Fq 'LoadCredential=automation.agekey:' \
    "$REPO_ROOT/infra/systemd/startap-backup-identity-preflight.service"
  grep -Fq 'PrivateNetwork=yes' \
    "$REPO_ROOT/infra/systemd/startap-backup-identity-preflight.service"
  grep -Fq 'LEGACY_WRITER_DISABLED_PROOF.json' "$SCRIPT_DIR/install.sh"
  grep -Fq 'OFFSITE_WRITER_ENABLED' "$SCRIPT_DIR/uploader.sh" "$SCRIPT_DIR/install.sh"
  ! rg -n 'GIT_SSH_COMMAND|git clone' "$SCRIPT_DIR/install.sh"
  grep -Fq 'LoadCredential=offsite_deploy_key:' \
    "$REPO_ROOT/infra/systemd/startap-backup-offsite-prepare.service"
  grep -Fq 'User=startap-backup-upload' \
    "$REPO_ROOT/infra/systemd/startap-backup-offsite-prepare.service"
  grep -Fq '.artifact_suffix == ".sql.gz.age"' "$SCRIPT_DIR/rollback.sh"
  ! rg -n 'find .*backup.*-delete|rm -rf|git push .*--force' "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/rollback.sh" "$SCRIPT_DIR/uploader.sh"
}
test_systemd_separation_and_cleanup_contract() {
  producer="$REPO_ROOT/infra/systemd/startap-backup-producer.service"
  validator="$REPO_ROOT/infra/systemd/startap-backup-validate.service"
  uploader="$REPO_ROOT/infra/systemd/startap-backup-upload.service"
  cycle="$REPO_ROOT/infra/systemd/startap-backup-cycle.service"
  producer_reconcile="$REPO_ROOT/infra/systemd/startap-backup-producer-reconcile.service"
  drill="$REPO_ROOT/infra/systemd/startap-backup-drill.service"
  drill_reconcile="$REPO_ROOT/infra/systemd/startap-backup-drill-reconcile.service"
  grep -Fq 'User=startap-backup-producer' "$producer"
  ! rg -n 'LoadCredential|BindPaths=.*docker|ReadWritePaths=.*docker|EnvironmentFile=' "$producer"
  grep -Fq 'InaccessiblePaths=/var/run/docker.sock' "$producer"
  grep -Fxq 'CapabilityBoundingSet=' "$cycle"
  grep -Fq 'SupplementaryGroups=startap-backup-bridge' "$cycle"
  grep -Fq 'InaccessiblePaths=/run/startap-backup-producer' "$cycle"
  grep -Fq 'Conflicts=startap-backup-dump.service startap-backup-dump-cleanup.service' "$producer_reconcile"
  grep -Fq 'ReadWritePaths=/run/startap-backup-producer /run/startap-backup-bridge/producer /run/startap-backup-bridge/root /run/startap-backup-dump-helper' "$producer_reconcile"
  grep -Fq 'InaccessiblePaths=/var/lib/startap-backup' "$producer_reconcile"
  grep -Fq 'PrivateNetwork=yes' "$validator"; grep -Fq 'LoadCredential=automation.agekey:' "$validator"
  grep -Fq 'LoadCredential=offsite_deploy_key:' "$uploader"; grep -Fq 'ConditionPathExists=/etc/startap-backup/OFFSITE_WRITER_ENABLED' "$uploader"
  grep -Fq 'ExecStopPost=/usr/local/libexec/startap-backup/drill-cleanup.sh' "$REPO_ROOT/infra/systemd/startap-backup-drill-prepare.service"
  grep -Fq 'ExecStartPre=/usr/bin/systemctl start --wait startap-backup-drill-reconcile.service' "$drill"
  grep -Fq 'ExecStopPost=/usr/bin/systemctl stop startap-backup-drill-prepare.service' "$drill"
  grep -Fq 'ExecStopPost=/usr/bin/systemctl start --wait startap-backup-drill-reconcile.service' "$drill"
  grep -Fq 'ReadWritePaths=/run/startap-backup-drill /run/startap-backup-drill-query /var/lib/startap-backup/drill-journal' "$drill_reconcile"
  grep -Fq 'ReadOnlyPaths=/etc/startap-backup /run/startap-backup-drill' \
    "$REPO_ROOT/infra/systemd/startap-backup-drill-restore.service"
  grep -Fq 'ReadWritePaths=/run/startap-backup-drill-query /var/lib/startap-backup/drill-journal ' \
    "$REPO_ROOT/infra/systemd/startap-backup-drill-restore.service"
  grep -Fq 'InaccessiblePaths=/var/lib/startap-backup/incoming ' "$drill_reconcile"
  grep -Fq 'WantedBy=multi-user.target' "$drill_reconcile"
  grep -Fq 'MemorySwapMax=0' "$REPO_ROOT/infra/systemd/startap-backup-drill-restore.service"
  ! rg -n '^[[:space:]]*docker[[:space:]].*\|\| true|teardown_resources \|\| true' "$SCRIPT_DIR/docker-helper.sh"
  grep -Fq 'resource_label_state' "$SCRIPT_DIR/docker-reconcile.sh"
  grep -Fq 'drill_reconcile_name_tuple_invalid' "$SCRIPT_DIR/docker-reconcile.sh"
}
test_durable_docker_journal_boot_contract() {
  local helper="$SCRIPT_DIR/docker-helper.sh" journal="$SCRIPT_DIR/docker-journal.sh"
  local initial_line network_line
  grep -Fq 'd /var/lib/startap-backup/drill-journal       0700 root' \
    "$REPO_ROOT/infra/systemd/startap-backup.tmpfiles"
  grep -Fq 'JOURNAL_ROOT="$(backup_path STARTAP_BACKUP_DRILL_JOURNAL_ROOT /var/lib/startap-backup/drill-journal)"' \
    "$journal"
  grep -Fq 'chmod 0600 "$JOURNAL_TEMP"' "$journal"
  grep -Fq 'backup_journal_fsync_file_and_directory "$JOURNAL_STATE"' "$journal"
  grep -Fq 'backup_journal_fsync_directory' "$journal"
  grep -Fq 'os.fsync(file_descriptor)' "$SCRIPT_DIR/journal-fsync.py"
  grep -Fq 'os.fsync(directory_descriptor)' "$SCRIPT_DIR/journal-fsync.py"
  grep -Fq 'O_NOFOLLOW' "$SCRIPT_DIR/journal-fsync.py"
  initial_line="$(grep -n '^backup_journal_write armed ' "$helper" | cut -d: -f1)"
  network_line="$(grep -n '^docker network create ' "$helper" | cut -d: -f1)"
  [ -n "$initial_line" ] && [ -n "$network_line" ] && [ "$initial_line" -lt "$network_line" ]
  for phase in network-created volume-created container-created restore-complete \
    teardown-started container-absent volume-absent network-absent teardown-complete; do
    grep -Fq "$phase" "$helper" "$SCRIPT_DIR/docker-reconcile.sh" "$journal"
  done
  grep -Fq 'WantedBy=multi-user.target' \
    "$REPO_ROOT/infra/systemd/startap-backup-drill-reconcile.service"
  grep -Fq 'enable --now startap-backup-drill-reconcile.service' "$SCRIPT_DIR/install.sh"
  ! grep -Eq '^ReadWritePaths=.*drill-journal' \
    "$REPO_ROOT/infra/systemd/startap-backup-drill-prepare.service"
}
test_dac_fixture_traversal_and_denials_are_explicit() {
  local fixture="$TEST_DIR/integration-dac.sh"
  grep -Fq 'chmod 0711 "$root"' "$fixture"
  grep -Fq 'credentials/automation.agekey' "$fixture"
  grep -Fq 'cycle-bridge/reconcile-complete' "$fixture"
  grep -Fq 'producer-expected-ran' "$fixture"
  grep -Fq 'cycle-assertions-ran' "$fixture"
  grep -Fq 'producer-assertions-ran' "$fixture"
  grep -Fq 'test ! -r "$1/credentials/automation.agekey"' "$fixture"
  grep -Fq 'test ! -w "$1/cycle-bridge/reconcile-complete"' "$fixture"
}
test_sshd_gate_reconciles_orphans_before_running() {
  local gate="$TEST_DIR/integration-sshd.sh" drill="$TEST_DIR/integration-sshd-reconcile.sh"
  grep -Fq 'reconcile_orphans' "$gate"
  grep -Fq '/proc/$pid/cmdline' "$gate"
  grep -Fq "'sshd: /usr/sbin/sshd -D -e -f '" "$gate"
  grep -Fq '/tmp/startap-sshd-integration.*/sshd_config' "$gate"
  grep -Fq 'startap-sshd-it-[0-9]+' "$gate"
  ! rg -n 'pkill|killall' "$gate"
  [ -x "$drill" ]
  grep -Fq 'guard-rail never matches the real production sshd' "$drill"
  grep -Fq 'guard-rail never matches an sshd with a foreign -f path' "$drill"
  grep -Fq 'orphan reconciliation cleans previous SIGKILL and next run passes 4/4' "$drill"
}
test_workflow_anchor_permissions_and_pins() {
  workflow="$REPO_ROOT/.github/workflows/backup-resilience-detector.yml"
  grep -Fq 'contents: read' "$workflow"; grep -Fq 'actions: read' "$workflow"
  grep -Fq 'BACKUP_REPO_READONLY_SSH_KEY' "$workflow"
  grep -Fq 'anchor_history_rewrite_detected' "$SCRIPT_DIR/anchor-verify.sh"
  grep -Fq 'name: backup-anchor' "$workflow"
  grep -Fq 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' "$workflow"
  grep -Fq 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262' "$workflow"
  ! grep -Eq 'uses: [^#[:space:]]+@v[0-9]' "$workflow"
  grep -Fq 'timeout --signal=TERM --kill-after=10s 15m git clone' "$workflow"
}
test_logs_have_no_secret_or_pii() {
  ! grep -R -E 'AGE-SECRET-KEY|([0-9]{3}\.){2}[0-9]{3}-[0-9]{2}|\+55[0-9]{10,13}' "$LOG_ROOT"
}

printf 'TAP version 13\n'
run_test 'encrypted generation is sealed, validated, promoted, and plaintext-free' test_valid_chain
run_test 'producer is non-root and cannot invoke Docker or credentials' test_producer_has_no_docker_or_credentials
run_test 'dump helper failure cannot create PREPARED' test_dump_helper_failure_no_prepare
run_test 'partial dump helper failure cannot create PREPARED' test_dump_helper_partial_failure_no_prepare
run_test 'simulated full storage fails with no fallback or plaintext' test_storage_full_fails_closed
run_test 'interruption removes plaintext and leaves no COMPLETE' test_interruption_cleans_plaintext
run_test 'SIGKILL plaintext is reconciled and the next cycle succeeds' test_sigkill_plaintext_reconciler_allows_next_cycle
run_test 'capless cycle reads only the dedicated producer bridge' test_cycle_uses_group_bridge_without_plaintext_access
run_test 'concurrent producer is refused' test_concurrent_producer_refused
run_test 'duplicate timestamp and name are idempotent' test_duplicate_run_idempotent
run_test 'seal rejects symlink substitution' test_seal_rejects_symlink
run_test 'seal rejects hardlink substitution' test_seal_rejects_hardlink
run_test 'seal rejects unexpected entries' test_seal_rejects_extra_entry
run_test 'generation allowlist rejects a compound allowed-looking name' test_generation_allowlist_rejects_compound_name
run_test 'seal allowlist rejects a newline-combined allowed-looking name' test_seal_allowlist_rejects_newline_name
run_test 'promote allowlist rejects an allowed-looking name with spaces' test_promote_allowlist_rejects_space_name
run_test 'sealed artifact is not writable by its reader' test_sealed_mutation_denied
run_test 'checksum mismatch fails closed' test_checksum_mismatch_rejected
run_test 'missing completion marker fails closed' test_marker_missing_rejected
run_test 'truncated gzip fails after real age decrypt' test_truncated_gzip_rejected
run_test 'gzip-valid corrupt dump fails markers' test_corrupt_dump_rejected
run_test 'wrong age identity fails closed' test_wrong_identity_rejected
run_test 'age stderr is sanitized and plaintext cleaned' test_age_failure_sanitized_and_cleanup
run_test 'validator attestation stays external and is bound on promotion' test_attestation_external_then_bound
run_test 'tampered external attestation is rejected' test_attestation_tamper_rejected
run_test 'pre-COMPLETE kill remains hidden and resumes safely' test_precomplete_hidden_and_recoverable
run_test 'producer kill after incoming publish converges same ciphertext' test_recover_producer_after_incoming
run_test 'producer kill after ready temp converges same ciphertext' test_recover_producer_after_ready_temp
run_test 'producer kill after ready publish converges same ciphertext' test_recover_producer_after_ready_publish
run_test 'seal kill after incoming claim converges same ciphertext' test_recover_seal_after_claim
run_test 'seal kill after marker temp converges same ciphertext' test_recover_seal_after_marker_temp
run_test 'seal kill after staging completion converges same ciphertext' test_recover_seal_after_staging
run_test 'seal kill after sealed publish converges same ciphertext' test_recover_seal_after_publish
run_test 'seal kill after pending temp converges same ciphertext' test_recover_seal_after_pending_temp
run_test 'seal kill after pending publish converges same ciphertext' test_recover_seal_after_pending_publish
run_test 'promote kill after sealed claim converges same ciphertext' test_recover_promote_after_claim
run_test 'promote kill after validation binding converges same ciphertext' test_recover_promote_after_validated
run_test 'promote kill after COMPLETE temp converges same ciphertext' test_recover_promote_after_complete_temp
run_test 'promote kill after COMPLETE marker converges same ciphertext' test_recover_promote_after_complete_marker
run_test 'promote kill after final publish converges same ciphertext' test_recover_promote_after_final_publish
run_test 'promote kill after latest marker converges same ciphertext' test_recover_promote_after_latest
run_test 'successful local cycle records atomic timestamped attempt' test_local_attempt_success_is_atomic
run_test 'later local failure degrades health while preserving RPO' test_later_local_failure_degrades_without_erasing_rpo
run_test 'transient upload retries then succeeds' test_transient_retry_then_success
run_test 'four failed primary attempts preserve encrypted fallback' test_all_primary_fail_fallback_survives
run_test 'uploader interruption resumes without duplicate commit' test_uploader_interruption_recovers_without_duplicate
run_test 'invalid authentication is terminal without loop' test_auth_terminal_no_retry
run_test 'host key mismatch is terminal without loop' test_host_mismatch_terminal
run_test 'non-fast-forward is terminal without loop' test_non_fast_forward_terminal
run_test 'failed later upload preserves prior RPO and reports degraded' test_failed_attempt_preserves_rpo
run_test 'local healthy plus offsite invalid is degraded' test_health_truth_local_healthy_offsite_invalid
run_test 'automation identity heartbeat participates in health' test_identity_heartbeat_affects_health
run_test 'duplicate age recipients are refused' test_duplicate_recipients_rejected
run_test 'drill reads canonical generation and cleanup removes plaintext' test_drill_reads_generation_without_copy
run_test 'interruption between drill units still removes plaintext' test_drill_interruption_cleanup
run_test 'drill cleanup unlinks symlink injection without following its target' test_drill_cleanup_unlinks_symlink_without_following
run_test 'PG16 fixture drill publishes only after verified teardown' test_fake_pg16_drill_teardown_success
run_test 'empty orphan probe uses official type-specific Docker list formats' test_orphan_probe_empty_state_uses_type_specific_formats
run_test 'fake Docker rejects unknown query placeholders and options' test_fake_docker_rejects_unknown_query_placeholder_and_option
run_test 'mount inspect format delegates exactly one newline to Docker' test_mount_inspect_format_has_no_embedded_newline
run_test 'ambiguous multiline mount inspect response fails closed' test_mount_inspect_multiline_response_fails_closed
run_test 'labelled volume without journal is detected and preserved' test_labelled_volume_without_journal_is_detected_and_preserved
run_test 'volume-only durable tuple is reconciled exactly' test_volume_only_durable_tuple_is_reconciled
run_test 'Docker journal is durably published outside runtime with input read-only' test_docker_journal_uses_persistent_root_write_path_with_readonly_input
run_test 'Docker journal removes symlink no-follow and refuses hardlink conflict' test_docker_journal_removes_symlink_without_follow_and_refuses_hardlink
run_test 'teardown failure propagates and cannot publish success' test_teardown_failure_propagates_no_success
run_test 'SQL failure uses ON_ERROR_STOP and tears down resources' test_sql_failure_tears_down_no_success
run_test 'non-empty destination is refused and torn down' test_nonempty_destination_refused_and_torn_down
run_test 'wrong PostgreSQL version is refused and torn down' test_wrong_pg_refused_and_torn_down
run_test 'production-like database destination is refused before creation' test_prod_like_destination_refused
run_test 'SIGKILL drill reconciles exact labelled resources and permits the next drill' test_docker_sigkill_reconciles_exact_resources_and_next_drill
run_test 'power loss after durable armed journal recovers after runtime loss' test_power_loss_after_journal_armed_recovers_after_run_loss
run_test 'power loss after network create recovers after runtime loss' test_power_loss_after_network_create_recovers_after_run_loss
run_test 'power loss after volume create recovers after runtime loss' test_power_loss_after_volume_create_recovers_after_run_loss
run_test 'power loss after container create recovers after runtime loss' test_power_loss_after_container_create_recovers_after_run_loss
run_test 'power loss after restore removes the disposable volume plaintext' test_power_loss_after_restore_removes_volume_plaintext
run_test 'power loss during teardown resumes from the durable phase' test_power_loss_during_teardown_resumes_from_durable_phase
run_test 'power loss after network create but before phase update still recovers' test_power_loss_network_created_before_phase_update_recovers
run_test 'power loss after volume create but before phase update still recovers' test_power_loss_volume_created_before_phase_update_recovers
run_test 'power loss after container create but before phase update still recovers' test_power_loss_container_created_before_phase_update_recovers
run_test 'power loss after restore but before phase update still removes plaintext volume' test_power_loss_restore_completed_before_phase_update_recovers
run_test 'power loss after resource removal but before teardown phase update recovers' test_power_loss_resource_removed_before_teardown_phase_update_recovers
run_test 'labelled Docker orphans without journal fail closed without deletion' test_missing_journal_with_labelled_orphans_fails_closed_without_delete
run_test 'orphan inventory query error fails closed with sanitized diagnostics' test_missing_journal_orphan_probe_error_fails_closed_and_sanitizes
run_test 'Docker reconciler refuses a foreign-label name conflict' test_docker_reconciler_refuses_foreign_label_conflict
run_test 'Docker daemon query error retains resources and reconcile state' test_docker_inspect_daemon_error_keeps_reconcile_state
run_test 'Docker inspect timeout retains resources and reconcile state' test_docker_inspect_timeout_keeps_reconcile_state
run_test 'Docker socket permission error retains resources and reconcile state' test_docker_inspect_permission_error_keeps_reconcile_state
run_test 'exact Docker not-found is the only absent state and permits reconciliation' test_docker_inspect_exact_not_found_allows_reconcile
run_test 'actually present labelled Docker resources are removed then verified absent' test_docker_inspect_actual_present_is_removed_and_verified
run_test 'external anchor accepts only a descendant recovery tuple' test_anchor_descendant_valid
run_test 'missing previous anchor fails closed' test_anchor_missing_fails_closed
run_test 'previous anchor tuple mismatch fails closed' test_anchor_tuple_mismatch_fails_closed
run_test 'offsite history rewrite fails closed' test_anchor_rewrite_fails_closed
run_test 'anchor refuses missing artifact blob' test_anchor_artifact_blob_missing_fails_closed
run_test 'anchor refuses altered artifact blob' test_anchor_artifact_blob_altered_fails_closed
run_test 'anchor refuses current manifest symlink mode 120000' test_anchor_current_manifest_symlink_mode_refused
run_test 'anchor refuses current artifact executable mode 100755' test_anchor_current_artifact_executable_mode_refused
run_test 'anchor refuses previous artifact submodule mode 160000' test_anchor_previous_artifact_gitlink_mode_refused
run_test 'anchor refuses previous manifest executable mode' test_anchor_previous_manifest_executable_mode_refused
run_test 'anchor refuses weird newline path' test_anchor_weird_path_refused
run_test 'anchor refuses divergent local and offsite tuple' test_anchor_local_offsite_tuple_divergence_fails_closed
run_test 'default-port known_hosts and restricted SSH shell are fail-closed' test_known_hosts_and_restricted_shell
run_test 'invalid dump marker is claimed and consumed without retrigger' test_dump_helper_consumes_invalid_marker_without_retrigger
run_test 'symlink dump marker is consumed without following target' test_dump_helper_consumes_symlink_marker_without_following
run_test 'broken symlink dump marker is consumed and next cycle converges' test_dump_helper_consumes_broken_symlink_marker_and_next_cycle_converges
run_test 'broken active dump claim is consumed and next cycle converges' test_dump_helper_consumes_broken_active_claim_and_next_cycle_converges
run_test 'broken cleanup marker is consumed and next cycle converges' test_dump_helper_consumes_broken_cleanup_marker_and_next_cycle_converges
run_test 'producer reconcile request replaces broken link without following' test_producer_reconcile_request_replaces_broken_link_without_following
run_test 'producer reconciler claims broken link no-follow and next request converges' test_producer_reconciler_claims_broken_link_no_follow_then_next_request_converges
run_test 'broken drill pending marker is cleaned and next drill converges' test_drill_pending_broken_link_is_cleaned_then_next_drill_converges
run_test 'broken journal link cannot hide a labelled orphan' test_journal_broken_link_is_unlinked_without_hiding_labelled_orphan
run_test 'hardlink dump marker is consumed without mutating peer' test_dump_helper_consumes_hardlink_marker_without_mutating_peer
run_test 'empty directory dump marker is consumed and the next request succeeds' test_dump_helper_consumes_empty_directory_marker
run_test 'nonempty directory dump marker is consumed without following entries' test_dump_helper_consumes_nonempty_directory_marker
run_test 'FIFO dump marker is consumed without opening and the next request succeeds' test_dump_helper_consumes_fifo_marker_without_opening
run_test 'socket dump marker is consumed without opening and the next request succeeds' test_dump_helper_consumes_socket_marker_without_opening
run_test 'oversized regular dump marker is consumed before any read' test_dump_helper_consumes_oversized_regular_marker
run_test 'bounded quarantine drains more than 128 marker entries' test_dump_helper_bounded_recovery_consumes_more_than_128_entries
run_test 'nested marker quarantine never follows a link target' test_dump_helper_nested_quarantine_never_follows_link
run_test 'producer reconciler drains more than 32 stale marker claims' test_producer_reconciler_drains_more_than_32_stale_claims
run_test 'marker quarantine recovery is bounded and no-follow' test_marker_quarantine_has_bounded_no_follow_contract
run_test 'dump marker race is serialized after atomic claim' test_dump_helper_race_is_serialized_after_atomic_claim
run_test 'dump helper recovers stale lease left by SIGKILL' test_dump_helper_recovers_stale_sigkill_lease
run_test 'dump path and service rate limits are explicit' test_dump_path_rate_limits_are_explicit
run_test 'legacy forced command streams only fixed artificial dump' test_legacy_dump_forced_command_streams_only_fixture
run_test 'backup workflows have no root key and require main Environments' test_workflows_have_no_root_key_and_require_main_environments
run_test 'Environment proof rejects any branch expansion' test_github_environment_proof_rejects_branch_expansion
run_test 'legacy workflow requires pinned age and only commits age' test_legacy_encryption_is_mandatory_and_pinned
run_test 'custody, writer cutover, and rollback guards are explicit' test_custody_and_cutover_guards_static
run_test 'systemd privilege separation and independent cleanup are present' test_systemd_separation_and_cleanup_contract
run_test 'Docker recovery journal is durable, fsynced, root-only, and boot-consumed' test_durable_docker_journal_boot_contract
run_test 'DAC fixture parent is traversable while secret and cycle bridge writes stay denied' test_dac_fixture_traversal_and_denials_are_explicit
run_test 'SSHD gate reconciles orphans before running and ships a guard-railed SIGKILL proof' test_sshd_gate_reconciles_orphans_before_running
run_test 'detector uses read-only key, prior artifact anchor, pins, and minimum permissions' test_workflow_anchor_permissions_and_pins
run_test 'captured logs contain no fixture secret or PII pattern' test_logs_have_no_secret_or_pii

printf '1..%d\n' "$test_number"
printf '# focused summary: pass=%d fail=%d\n' "$pass" "$fail"
[ "$fail" = 0 ]
