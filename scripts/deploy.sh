#!/usr/bin/env bash
#
# Deploy script — roda no servidor após merge na main.
#
# Uso: ./scripts/deploy.sh
#
# O que faz:
#   1. checkout do sha do CI (DEPLOY_SHA, se vier) ou pull de main (fallback manual)
#   2. docker compose build  (rebuild images com novo código)
#   3. apply migrations (migrate.sh)
#   4. docker compose up -d  (substitui containers api/worker)
#   5. Rebuilda painel-admin na stack pai (/opt/automacoes/docker-compose.yml), quando ela existir
#   6. Verifica health da API e do painel-admin
#
# Pré-requisito: rodar em /opt/automacoes/code com .env configurado.

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)"
DEPLOY_ROOT="${STARTAP_DEPLOY_ROOT:-$REPO_ROOT}"
DEPLOY_COMPOSE_FILE="${STARTAP_DEPLOY_COMPOSE_FILE:-$DEPLOY_ROOT/docker-compose.yml}"
DOCKER_BIN="${STARTAP_DEPLOY_TEST_DOCKER_BIN:-docker}"

cd "$DEPLOY_ROOT"

DEPLOY_COMPOSE_SERVICES=()
ROLLBACK_API=""
ROLLBACK_WORKER=""

deploy_compose_project_name() {
  if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s\n' "$COMPOSE_PROJECT_NAME"
  else
    basename "$DEPLOY_ROOT"
  fi
}

deploy_load_compose_services() {
  local service
  DEPLOY_COMPOSE_SERVICES=()
  while IFS= read -r service; do
    [ -n "$service" ] || continue
    DEPLOY_COMPOSE_SERVICES+=("$service")
  done < <("$DOCKER_BIN" compose config --services)
  [ "${#DEPLOY_COMPOSE_SERVICES[@]}" -gt 0 ]
}

deploy_service_known() {
  local expected="$1" service
  for service in "${DEPLOY_COMPOSE_SERVICES[@]}"; do
    if [ "$service" = "$expected" ]; then
      return 0
    fi
  done
  return 1
}

deploy_docker_inspect_name() {
  local raw_name
  raw_name="$("$DOCKER_BIN" inspect --format '{{.Name}}' "$1")" || return 1
  printf '%s\n' "${raw_name#/}"
}

deploy_docker_inspect_label() {
  local raw_value
  raw_value="$("$DOCKER_BIN" inspect --format "{{ index .Config.Labels \"$2\" }}" "$1")" || return 1
  case "$raw_value" in
    '<no value>'|'')
      printf '\n'
      ;;
    *)
      printf '%s\n' "$raw_value"
      ;;
  esac
}

deploy_compose_file_matches() {
  local config_files="$1" candidate
  IFS=',' read -r -a candidates <<<"$config_files"
  for candidate in "${candidates[@]}"; do
    if [ "$candidate" = "$DEPLOY_COMPOSE_FILE" ] || [ "$candidate" = 'docker-compose.yml' ]; then
      return 0
    fi
  done
  return 1
}

deploy_abort_created_container() {
  local id="$1" name="$2" project_label="$3" service_label="$4" working_dir_label="$5" config_files_label="$6" reason="$7"
  echo "❌ preflight detectou container created ambiguo para o projeto Compose; abortando para evitar remocao insegura." >&2
  echo "   container_id=$id name=$name reason=$reason" >&2
  echo "   labels: project=${project_label:-<vazio>} service=${service_label:-<vazio>} working_dir=${working_dir_label:-<vazio>} config_files=${config_files_label:-<vazio>}" >&2
  return 1
}

deploy_warn_rollback_created_container() {
  local id="$1" name="$2" project_label="$3" service_label="$4" working_dir_label="$5" config_files_label="$6" reason="$7"
  echo "⚠️ rollback encontrou container created ambiguo; nao sera removido automaticamente." >&2
  echo "   container_id=$id name=$name reason=$reason" >&2
  echo "   labels: project=${project_label:-<vazio>} service=${service_label:-<vazio>} working_dir=${working_dir_label:-<vazio>} config_files=${config_files_label:-<vazio>}" >&2
  echo "   seguindo com docker compose up -d para priorizar a recuperacao das imagens boas." >&2
}

deploy_preflight_remove_created_orphans() {
  local compose_project id name project_label service_label working_dir_label config_files_label oneoff_label
  local removed=0
  local -a created_ids=()
  compose_project="$(deploy_compose_project_name)"
  deploy_load_compose_services || {
    echo "❌ preflight nao conseguiu listar os services do docker compose; abortando deploy." >&2
    return 1
  }

  while IFS= read -r id; do
    [ -n "$id" ] || continue
    created_ids+=("$id")
  done < <("$DOCKER_BIN" ps -a --filter status=created --format '{{.ID}}')

  if [ "${#created_ids[@]}" -eq 0 ]; then
    echo "==> preflight: nenhum container em estado created"
    return 0
  fi

  echo "==> preflight: avaliando ${#created_ids[@]} container(s) em estado created"
  for id in "${created_ids[@]}"; do
    name="$(deploy_docker_inspect_name "$id")" || {
      echo "❌ preflight nao conseguiu inspecionar o nome do container created $id; abortando." >&2
      return 1
    }
    project_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.project')"
    service_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.service')"
    working_dir_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.project.working_dir')"
    config_files_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.project.config_files')"
    oneoff_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.oneoff')"

    if [ -z "$project_label" ] && [ -z "$service_label" ] && [ -z "$working_dir_label" ] && [ -z "$config_files_label" ] && [ -z "$oneoff_label" ]; then
      continue
    fi

    if [ "$project_label" != "$compose_project" ]; then
      if [ "$working_dir_label" = "$DEPLOY_ROOT" ] || deploy_compose_file_matches "${config_files_label:-}"; then
        deploy_abort_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
          "labels parciais conflitantes com o projeto atual"
        return 1
      fi
      continue
    fi

    if ! deploy_service_known "$service_label"; then
      deploy_abort_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
        "service label ausente ou fora da compose atual"
      return 1
    fi
    if [ "$working_dir_label" != "$DEPLOY_ROOT" ]; then
      deploy_abort_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
        "working_dir label nao bate com o checkout do deploy"
      return 1
    fi
    if ! deploy_compose_file_matches "${config_files_label:-}"; then
      deploy_abort_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
        "config_files label nao prova vinculacao com docker-compose.yml atual"
      return 1
    fi
    case "$oneoff_label" in
      True|true|1)
        deploy_abort_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
          "container one-off nao pode ser removido automaticamente"
        return 1
        ;;
    esac

    echo "==> preflight: removendo orphan created do compose atual: $name ($id), service=$service_label"
    "$DOCKER_BIN" rm "$id" >/dev/null
    removed=$((removed + 1))
  done

  echo "==> preflight: removidos $removed container(s) created do compose atual"
}

deploy_rollback_remove_created_orphans_best_effort() {
  local compose_project id name project_label service_label working_dir_label config_files_label oneoff_label
  local removed=0 warned=0
  local -a created_ids=()
  compose_project="$(deploy_compose_project_name)"
  if ! deploy_load_compose_services; then
    echo "⚠️ rollback nao conseguiu listar os services do docker compose; seguindo sem cleanup de created." >&2
    return 0
  fi

  while IFS= read -r id; do
    [ -n "$id" ] || continue
    created_ids+=("$id")
  done < <("$DOCKER_BIN" ps -a --filter status=created --format '{{.ID}}')

  if [ "${#created_ids[@]}" -eq 0 ]; then
    echo "==> rollback cleanup: nenhum container em estado created"
    return 0
  fi

  echo "==> rollback cleanup: avaliando ${#created_ids[@]} container(s) em estado created"
  for id in "${created_ids[@]}"; do
    name="$(deploy_docker_inspect_name "$id")" || {
      echo "⚠️ rollback nao conseguiu inspecionar o nome do container created $id; seguindo sem remove-lo." >&2
      warned=$((warned + 1))
      continue
    }
    project_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.project')"
    service_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.service')"
    working_dir_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.project.working_dir')"
    config_files_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.project.config_files')"
    oneoff_label="$(deploy_docker_inspect_label "$id" 'com.docker.compose.oneoff')"

    if [ -z "$project_label" ] && [ -z "$service_label" ] && [ -z "$working_dir_label" ] && [ -z "$config_files_label" ] && [ -z "$oneoff_label" ]; then
      continue
    fi

    if [ "$project_label" != "$compose_project" ]; then
      if [ "$working_dir_label" = "$DEPLOY_ROOT" ] || deploy_compose_file_matches "${config_files_label:-}"; then
        deploy_warn_rollback_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
          "labels parciais conflitantes com o projeto atual"
        warned=$((warned + 1))
      fi
      continue
    fi

    if ! deploy_service_known "$service_label"; then
      deploy_warn_rollback_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
        "service label ausente ou fora da compose atual"
      warned=$((warned + 1))
      continue
    fi
    if [ "$working_dir_label" != "$DEPLOY_ROOT" ]; then
      deploy_warn_rollback_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
        "working_dir label nao bate com o checkout do deploy"
      warned=$((warned + 1))
      continue
    fi
    if ! deploy_compose_file_matches "${config_files_label:-}"; then
      deploy_warn_rollback_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
        "config_files label nao prova vinculacao com docker-compose.yml atual"
      warned=$((warned + 1))
      continue
    fi
    case "$oneoff_label" in
      True|true|1)
        deploy_warn_rollback_created_container "$id" "$name" "$project_label" "$service_label" "$working_dir_label" "$config_files_label" \
          "container one-off nao pode ser removido automaticamente"
        warned=$((warned + 1))
        continue
        ;;
    esac

    echo "==> rollback cleanup: removendo orphan created do compose atual: $name ($id), service=$service_label"
    "$DOCKER_BIN" rm "$id" >/dev/null
    removed=$((removed + 1))
  done

  echo "==> rollback cleanup: removidos $removed container(s) created do compose atual; ambiguos preservados=$warned"
}

deploy_run_rollback() {
  echo "==> ROLLBACK: restaurando imagens anteriores" >&2
  if [ -n "$ROLLBACK_API" ]; then
    "$DOCKER_BIN" tag "$ROLLBACK_API" startap-api:latest
  fi
  if [ -n "$ROLLBACK_WORKER" ]; then
    "$DOCKER_BIN" tag "$ROLLBACK_WORKER" startap-worker:latest
  fi
  deploy_rollback_remove_created_orphans_best_effort
  "$DOCKER_BIN" compose up -d
  echo "==> ROLLBACK concluido. Verifique: docker logs startap-api --tail 30" >&2
}

deploy_main() {
echo "==> git fetch origin main"
git fetch origin main

# SCRUM-109: sobe EXATAMENTE o commit que passou no CI, nao o HEAD de main NA HORA.
# O deploy.yml (workflow_run) exporta DEPLOY_SHA=workflow_run.head_sha. Sem esse pin,
# um 2o merge proximo entrava em prod sem CI verde (corrida provada por carimbo de
# tempo: deploy fez "Updating ..X" 1s ANTES do CI de X terminar).
DEPLOY_SHA="${DEPLOY_SHA:-}"
if [ -n "$DEPLOY_SHA" ]; then
  echo "==> git checkout ${DEPLOY_SHA} (sha do CI que passou, detached) [SCRUM-109]"
  # best-effort: garante o objeto mesmo em corrida rara (o fetch de main ja o traz,
  # pois head_sha e alcancavel a partir de origin/main). Se o sha nao existir, o
  # checkout abaixo falha ALTO e o deploy aborta (fail-safe) — nunca sobe errado.
  git fetch origin "$DEPLOY_SHA" 2>/dev/null || true
  git checkout --detach "$DEPLOY_SHA"
else
  # Fallback: deploy manual na VPS / workflow_dispatch sem sha — comportamento antigo.
  # (o proximo deploy volta pra main normal via este mesmo caminho ou re-pina o sha).
  echo "==> sem DEPLOY_SHA — checkout main + pull --rebase (fallback manual)"
  git checkout main
  git pull --rebase origin main
fi

echo "==> preflight: limpando leftovers seguros em estado created"
deploy_preflight_remove_created_orphans

echo "==> docker compose build (sem cache pra evitar staleness)"
"$DOCKER_BIN" compose build --no-cache

echo "==> apply migrations"
bash "$SCRIPT_DIR/migrate.sh"

# Gate defensivo: garante que TODAS as migrations do repo estao registradas em
# schema_migrations. Protege contra bugs silenciosos no runner (ja aconteceu
# uma vez — psql_exec consumia stdin do loop e abortava apos 1 iteracao,
# deixando flow_clones/leads.slot fora de prod). Se este gate falhar, NAO
# subir nova versao da aplicacao com banco fora-de-sync.
expected_migrations=$(find packages/db/migrations -maxdepth 1 -name '*.sql' -type f | wc -l)
applied_migrations=$("$DOCKER_BIN" exec automacoes-postgres-1 psql -U "${PG_USER:-startap_user}" -d "${PG_DB:-startap_database}" -tAc "SELECT COUNT(*) FROM schema_migrations;" </dev/null | tr -d ' ')
if [ "$applied_migrations" -lt "$expected_migrations" ]; then
  echo "❌ schema_migrations tem $applied_migrations entradas, esperado $expected_migrations. Abortando deploy pra evitar app rodar com banco fora-de-sync." >&2
  echo "   Investigue rodando: bash scripts/migrate.sh manualmente e leia o output completo." >&2
  exit 1
fi
echo "✅ schema_migrations sincronizado ($applied_migrations/$expected_migrations)"

# --- Rollback: salva imagens atuais antes de subir nova versao ---
# Se o health check falhar apos o up, restaura as imagens anteriores.
if "$DOCKER_BIN" image inspect startap-api:latest &>/dev/null; then
  "$DOCKER_BIN" tag startap-api:latest startap-api:pre-deploy
  ROLLBACK_API="startap-api:pre-deploy"
fi
if "$DOCKER_BIN" image inspect startap-worker:latest &>/dev/null; then
  "$DOCKER_BIN" tag startap-worker:latest startap-worker:pre-deploy
  ROLLBACK_WORKER="startap-worker:pre-deploy"
fi

echo "==> preflight: revalidando leftovers seguros antes do up"
deploy_preflight_remove_created_orphans

echo "==> docker compose up -d"
"$DOCKER_BIN" compose up -d

# Painel-admin vive na stack pai (/opt/automacoes/docker-compose.yml).
# Usamos path absoluto para evitar falha silenciosa quando o working dir
# do caller (ex: GitHub Actions) difere do esperado pelo script.
STACK_PAI_COMPOSE="/opt/automacoes/docker-compose.yml"
if [ -f "$STACK_PAI_COMPOSE" ]; then
  PAINEL_IN_STACK=$("$DOCKER_BIN" compose -f "$STACK_PAI_COMPOSE" config --services 2>/dev/null | grep -cx 'painel-admin' || true)
  echo "==> painel-admin na stack pai: ${PAINEL_IN_STACK} ocorrencia(s)"
  if [ "$PAINEL_IN_STACK" -gt 0 ]; then
    echo "==> docker compose build painel-admin (stack pai)"
    "$DOCKER_BIN" compose -f "$STACK_PAI_COMPOSE" build --no-cache painel-admin

    echo "==> docker compose up -d painel-admin (stack pai)"
    "$DOCKER_BIN" compose -f "$STACK_PAI_COMPOSE" up -d painel-admin
  else
    echo "WARN: painel-admin nao encontrado em $STACK_PAI_COMPOSE — pulando rebuild"
  fi
else
  echo "WARN: $STACK_PAI_COMPOSE nao existe — pulando rebuild do painel-admin"
fi

echo "==> waiting 6s for startup"
sleep 6

echo "==> API health check"
if docker exec automacoes-waha-1 curl -fsS http://startap-api:3040/health > /dev/null; then
  echo "✅ API healthy"
else
  echo "❌ API health check failed — iniciando rollback" >&2
  deploy_run_rollback
  exit 1
fi

if docker ps --format '{{.Names}}' | grep -qx 'automacoes-painel-admin-1'; then
  echo "==> painel-admin health check"
  PANEL_STATUS=$(docker exec automacoes-waha-1 curl -sS -o /dev/null -w '%{http_code}' http://automacoes-painel-admin-1:3030)
  if [ "$PANEL_STATUS" = "200" ] || [ "$PANEL_STATUS" = "401" ]; then
    echo "✅ painel-admin healthy"
  else
    echo "❌ painel-admin health check failed (HTTP $PANEL_STATUS) — verifique 'docker logs automacoes-painel-admin-1'" >&2
    exit 1
  fi
fi

# --- Limpeza de cache de build (so apos deploy OK) ---
# O build acima roda com --no-cache, entao o cache de build NUNCA e reusado —
# ele so acumula a cada deploy (chegou a ~44GB e encheu o disco). Como os
# health checks acima ja passaram, e seguro limpar TUDO aqui.
#
# ⚠️ JAMAIS trocar por `docker system prune -a` ou `docker image prune -a`:
# isso removeria imagens paradas porem taggeadas, incluindo a
# devlikeapro/waha-plus (imagem doada/congelada, NAO re-baixavel via pull)
# e derrubaria os bots.
#   - `builder prune -af` → so cache de build (nao toca em imagem nenhuma)
#   - `image prune -f`    → so imagens dangling (<none>) de rebuilds; imagens
#                           taggeadas (waha-plus, startap-*:pre-deploy) intactas
# Best-effort: falha na limpeza nao pode falhar o deploy (|| true).
echo "==> prune de build cache + imagens dangling (best-effort)"
docker builder prune -af || true
docker image prune -f || true

echo "==> bots registrados:"
# awk em vez de `grep | wc -l` porque grep retorna exit 1 quando ha 0 matches —
# combinado com `set -euo pipefail` no topo, isso aborta o deploy mesmo quando
# o painel subiu limpo. Em prod com banco vazio (sem clones), 0 matches e estado
# valido. awk imprime 0 nesses casos e sempre retorna exit 0.
N=$(docker logs --since 30s startap-api 2>&1 | awk '/Bot registrado/ {n++} END {print n+0}')
echo "  $N bots"

echo ""
echo "Deploy completo. Logs: docker logs startap-api -f"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  deploy_main "$@"
fi
