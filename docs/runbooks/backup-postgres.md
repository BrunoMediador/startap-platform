# Runbook: Backup Postgres → startap-backups

## Visão geral

O backup diário do banco `startap_database` é feito via GitHub Actions:
1. `pg_dump` executa **dentro** do container `automacoes-postgres-1` no VPS
2. O dump é comprimido com `gzip` no runner do GitHub Actions (não consome disco do VPS)
3. O arquivo é commitado no repositório privado `BrunoMediador/startap-backups` com path `dumps/YYYY/MM/YYYY-MM-DD-HHMMSS.sql.gz`
4. Um cleanup semanal remove dumps diários > 30 dias, mantendo 1 por semana (cobertura de ~6 meses)

## Secrets GitHub necessárias

Configurar em **github.com/BrunoMediador/startap-platform → Settings → Secrets → Actions**:

| Secret | Valor | Observação |
|---|---|---|
| `SSH_PRIVATE_KEY` | Chave privada SSH (ed25519) do root@187.77.242.220 | Usada pelo `backup-postgres.yml` pra rodar o `pg_dump` no VPS (mesma família do deploy.yml) |
| `BACKUP_REPO_SSH_KEY` | Chave privada da **deploy key** com acesso de escrita ao repo `BrunoMediador/startap-backups` | Autentica clone/push via `git@github.com`. **Não é PAT.** Ambos os workflows (backup e cleanup) usam esta chave |

> **Histórico:** versões antigas usavam um PAT `BACKUP_REPO_TOKEN` com `actions/checkout`. O projeto migrou para **deploy key SSH** (`BACKUP_REPO_SSH_KEY`) e o secret do PAT foi removido. Se algum workflow ainda referenciar `BACKUP_REPO_TOKEN`, ele falhará com `Input required and not supplied: token` — corrija para o fluxo SSH.

### Como criar/rotacionar a BACKUP_REPO_SSH_KEY (deploy key)

A deploy key é um par de chaves SSH dedicado: a **pública** vai no repo `startap-backups`, a **privada** vira o secret no `startap-platform`.

1. Gere um par dedicado (sem passphrase, para uso não-interativo no CI):
   ```bash
   ssh-keygen -t ed25519 -C "startap-backups-deploy" -f ./startap_backups_deploy -N ""
   ```
2. Registre a **pública** como deploy key COM escrita:
   - github.com/BrunoMediador/**startap-backups** → Settings → Deploy keys → Add deploy key
   - Title: `startap-platform CI (backup+cleanup)`
   - Key: conteúdo de `startap_backups_deploy.pub`
   - **Marcar "Allow write access"** (push do backup e do cleanup depende disso)
3. Registre a **privada** como secret no repo de workflows:
   - github.com/BrunoMediador/**startap-platform** → Settings → Secrets → Actions → New repository secret
   - Name: `BACKUP_REPO_SSH_KEY`
   - Value: conteúdo completo de `startap_backups_deploy` (incluindo as linhas `BEGIN/END`)
4. Apague o par local após colar nos dois lugares:
   ```bash
   shred -u startap_backups_deploy startap_backups_deploy.pub  # ou rm -f
   ```

### Como o SSH é montado nos workflows

Ambos os workflows fazem o mesmo setup antes de clonar/push:
```bash
mkdir -p ~/.ssh
echo "${{ secrets.BACKUP_REPO_SSH_KEY }}" > ~/.ssh/backup_deploy
chmod 600 ~/.ssh/backup_deploy
ssh-keyscan github.com >> ~/.ssh/known_hosts
cat >> ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/backup_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
# ...
git clone git@github.com:BrunoMediador/startap-backups.git startap-backups
# (commit/push usam git puro, autenticado pela deploy key acima)
```
A chave é apagada no fim com um passo `if: always()` (`rm -f ~/.ssh/backup_deploy ~/.ssh/config`).

## Schedules

| Workflow | Cron | BRT equivalente | Ação |
|---|---|---|---|
| `backup-postgres.yml` | `0 6 * * *` | 03:00 todo dia | Dump + commit |
| `backup-postgres-cleanup.yml` | `0 7 * * 0` | 04:00 domingos | Remove diários > 30 dias |

## Como disparar manualmente

### Backup

Via GitHub UI:
1. github.com/BrunoMediador/startap-platform → Actions → "Backup Postgres → startap-backups"
2. "Run workflow" → "Run workflow" (branch main)

Via CLI:
```bash
gh workflow run backup-postgres.yml --repo BrunoMediador/startap-platform
```

### Cleanup (com dry-run)

O cleanup manual tem um input `dry_run` (**default `true`** = seguro). Em dry-run ele só
**lista** o que seria removido (`WOULD-REMOVE ...`) sem rodar `git rm` nem `git push`.

Via GitHub UI:
1. Actions → "Cleanup Backups Antigos" → "Run workflow"
2. Deixe `dry_run` marcado (true) para inspecionar; veja os logs (`KEEP` / `WOULD-REMOVE`)
3. Só depois de revisar, rode de novo com `dry_run` desmarcado (false) para aplicar

Via CLI:
```bash
# Dry-run (só lista)
gh workflow run backup-postgres-cleanup.yml --repo BrunoMediador/startap-platform -f dry_run=true

# Aplicar de verdade (remove + push)
gh workflow run backup-postgres-cleanup.yml --repo BrunoMediador/startap-platform -f dry_run=false
```

> O schedule de domingo (07:00 UTC) sempre roda em **modo real** — o dry-run só existe no disparo manual, para revisão da primeira execução confiável.

## Como rodar localmente (teste)

Requer: clone local de `startap-backups` e SSH key configurada.

```bash
# Dry-run (não faz SSH nem dump)
bash scripts/backup-postgres.sh --dry-run

# Execução real (requer SSH key em ~/.ssh/hostinger_codex_ed25519)
BACKUP_REPO_PATH=../startap-backups bash scripts/backup-postgres.sh
```

## Como restaurar um backup

1. Clone ou atualize o repo `startap-backups`:
   ```bash
   git clone git@github.com:BrunoMediador/startap-backups.git
   ```

2. Localize o arquivo desejado:
   ```bash
   ls startap-backups/dumps/2026/05/
   # 2026-05-19-060001.sql.gz
   ```

3. Restaure no banco (ajuste credenciais conforme necessário):
   ```bash
   # Restaurar em ambiente local
   gunzip -c startap-backups/dumps/2026/05/2026-05-19-060001.sql.gz \
     | psql -U startap_user -d startap_database

   # Restaurar direto no VPS (via SSH)
   gunzip -c startap-backups/dumps/2026/05/2026-05-19-060001.sql.gz \
     | ssh -i ~/.ssh/hostinger_codex_ed25519 root@187.77.242.220 \
       "docker exec -i automacoes-postgres-1 psql -U startap_user -d startap_database"
   ```

   Flags `--no-owner --no-acl` no dump garantem que o restore funcione sem precisar recriar roles.

## Restore drill (validação SEGURA — prova que o dump restaura)

> **Objetivo:** provar que o dump mais recente restaura de verdade, sem nunca tocar produção.
> Hoje o backup é "de Schrödinger" — nunca foi restaurado. Este drill fecha esse gap.
>
> **REGRAS DE SEGURANÇA INEGOCIÁVEIS:**
> - **NUNCA** toca o container de produção `automacoes-postgres-1`.
> - **NUNCA** toca o banco de produção `startap_database`.
> - Sobe um Postgres **efêmero e descartável** (`docker run --rm postgres:16`) numa porta
>   que não conflita (`55432`), restaura ali, valida e se autodestrói.
> - É **idempotente**: remove qualquer container de drill anterior antes de começar.
> - **NÃO** usa `docker pull devlikeapro/waha-plus` nem `docker system prune` (imagem WAHA é
>   congelada). `postgres:16` já está presente no host (é a imagem do PG de prod); o `docker run`
>   reusa a imagem local, sem pull.
>
> Este drill é **mudança de estado no servidor** → roda só com aprovação do Bruno.
> O DevOps/SRE entrega os comandos; **quem executa é o Bruno**.

### Comandos do drill (rodar no VPS, com OK do Bruno)

```bash
set -euo pipefail

# --- Config do drill (tudo descartável, isolado de prod) ---
DRILL_CONTAINER="startap_restore_drill"
DRILL_DB="startap_restore_drill"
DRILL_PORT="55432"          # porta no host, fora do 5432 de prod
DRILL_PW="drill_$(date +%s)"  # senha throwaway, só vive no container efêmero
BACKUPS_DIR="/root/startap-backups"   # ajustar se o clone estiver em outro path
# Chave PRIVADA age pra decifrar os dumps novos (.sql.gz.age). Guardada offline pelo
# Bruno (~/Documents/backup-key.txt + vault). SÓ é necessária se o dump mais recente
# estiver cifrado; dumps antigos em claro (.sql.gz) não usam esta variável.
AGE_KEY_FILE="${AGE_KEY_FILE:-/root/backup-key.txt}"

# --- Passo 0: idempotência — derruba drill anterior se existir ---
docker rm -f "${DRILL_CONTAINER}" 2>/dev/null || true

# --- Passo 1: localiza o dump mais recente (off-site, repo já clonado no host) ---
# Se o repo de backups não estiver no host, clonar antes (read-only basta):
#   git clone git@github.com:BrunoMediador/startap-backups.git "${BACKUPS_DIR}"
# ou atualizar:  git -C "${BACKUPS_DIR}" pull --ff-only
# Desde SCRUM-20 (24/07) o backup grava CIFRADO com age (.sql.gz.age); dumps
# antigos ficaram em claro (.sql.gz). Considera os DOIS e pega o mais recente por
# nome (timestamp no filename ordena cronologicamente).
LATEST_DUMP=$(find "${BACKUPS_DIR}/dumps" \( -name '*.sql.gz' -o -name '*.sql.gz.age' \) | sort | tail -n1)
echo ">> Dump mais recente: ${LATEST_DUMP}"
test -s "${LATEST_DUMP}"   # falha se vazio/inexistente

# --- Passo 2: sobe Postgres EFÊMERO (--rm = some ao parar) ---
# postgres:16 = mesma major do prod; imagem já existe no host (sem pull).
docker run -d --rm \
  --name "${DRILL_CONTAINER}" \
  -e POSTGRES_PASSWORD="${DRILL_PW}" \
  -e POSTGRES_DB="${DRILL_DB}" \
  -p 127.0.0.1:${DRILL_PORT}:5432 \
  postgres:16

# --- Passo 3: espera o PG efêmero ficar pronto (timeout ~30s) ---
for i in $(seq 1 30); do
  if docker exec "${DRILL_CONTAINER}" pg_isready -U postgres -d "${DRILL_DB}" >/dev/null 2>&1; then
    echo ">> PG efêmero pronto."
    break
  fi
  sleep 1
  [ "$i" = "30" ] && { echo "ERRO: PG efêmero não subiu"; docker rm -f "${DRILL_CONTAINER}"; exit 1; }
done

# --- Passo 4: restaura o dump no DB efêmero (NUNCA no prod) ---
# O dump foi feito com --no-owner --no-acl → restaura como 'postgres' sem recriar roles.
# Se o dump está cifrado (.sql.gz.age), decifra com a chave PRIVADA age ANTES do gunzip.
# 'age -d -i <chave>' desfaz o 'age -r <pubkey>' do backup-postgres.yml (l.108-109);
# só então o stream volta a ser gzip válido pro gunzip.
if [ "${LATEST_DUMP%.age}" != "${LATEST_DUMP}" ]; then
  echo ">> Dump CIFRADO — decifrando com age (${AGE_KEY_FILE})."
  command -v age >/dev/null 2>&1 || { echo "ERRO: 'age' não instalado (apt-get install -y age)"; docker rm -f "${DRILL_CONTAINER}"; exit 1; }
  test -s "${AGE_KEY_FILE}" || { echo "ERRO: chave privada age ausente/vazia em ${AGE_KEY_FILE} — não dá pra decifrar"; docker rm -f "${DRILL_CONTAINER}"; exit 1; }
  DECRYPT_CMD=(age -d -i "${AGE_KEY_FILE}" "${LATEST_DUMP}")
else
  echo ">> Dump em CLARO (legado) — sem etapa de decifração."
  DECRYPT_CMD=(cat "${LATEST_DUMP}")
fi
"${DECRYPT_CMD[@]}" | gunzip -c \
  | docker exec -i "${DRILL_CONTAINER}" psql -v ON_ERROR_STOP=1 -U postgres -d "${DRILL_DB}"

# --- Passo 5: sanity checks (schema presente + contagem de linhas em tabelas-chave) ---
echo ">> Tabelas restauradas:"
docker exec "${DRILL_CONTAINER}" psql -U postgres -d "${DRILL_DB}" -c \
  "SELECT count(*) AS n_tabelas FROM information_schema.tables WHERE table_schema='public';"

echo ">> Contagem em tabelas-chave (ajuste a lista conforme o schema real):"
docker exec "${DRILL_CONTAINER}" psql -U postgres -d "${DRILL_DB}" -c \
  "SELECT 'bot_config' AS tabela, count(*) FROM bot_config
   UNION ALL SELECT 'schema_migrations', count(*) FROM schema_migrations;"

# Falha o drill se o schema veio vazio (restore silenciosamente falho)
N_TABELAS=$(docker exec "${DRILL_CONTAINER}" psql -tAU postgres -d "${DRILL_DB}" -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
if [ "${N_TABELAS}" -lt 1 ]; then
  echo "ERRO: nenhuma tabela no schema public — restore FALHOU"
  docker rm -f "${DRILL_CONTAINER}"
  exit 1
fi
echo ">> OK: ${N_TABELAS} tabela(s) no schema public."

# --- Passo 6: autodestruição (--rm já remove ao parar) ---
docker rm -f "${DRILL_CONTAINER}"
echo ">> Drill concluído. Container efêmero removido. Prod intocado."
```

### O que o drill prova (e o que NÃO prova)

- **Prova:** o dump mais recente é um SQL válido que recria o schema e popula tabelas-chave
  num Postgres 16 limpo. Se passar, o backup é restaurável.
- **NÃO prova:** integridade lógica de cada linha, nem que a app sobe contra esse restore.
  Para isso seria preciso um ambiente de staging completo (fora do escopo deste drill).
- **Tabelas-chave:** ajustar a lista do Passo 5 ao schema real (ex.: incluir tabelas de
  clientes/sessões). `schema_migrations` é um bom canário — se ela veio, o migrate histórico
  está no dump.

## Estrutura do repositório de backups

```
startap-backups/
  dumps/
    2026/
      05/
        2026-05-19-060001.sql.gz   ← backup diário
        2026-05-20-060001.sql.gz
        ...
      06/
        ...
```

## Politica de retenção

Implementada em `backup-postgres-cleanup.yml`. Lógica exata (descrita por inspeção):

1. Lista todos os `dumps/**/*.sql.gz` ordenados por nome (ISO8601 = ordem cronológica).
2. Calcula `CUTOFF = hoje - 30 dias`.
3. **Dumps com data >= cutoff** (dentro da janela de 30 dias): mantidos TODOS, intocados.
4. **Dumps com data < cutoff** (mais antigos que 30 dias): agrupados por **semana ISO**
   (`%G-W%V`). O **primeiro** dump de cada semana (cronologicamente) é mantido como o
   "semanal" daquela semana; os demais dumps da mesma semana são removidos com `git rm`.
5. Se algo foi removido (e não é dry-run), commita e dá push no repo de backups.

Resultado prático:
- **Diários**: cobertura completa nos últimos 30 dias.
- **Semanais**: além de 30 dias, o histórico colapsa para 1 dump por semana ISO, mantido
  indefinidamente (não há expiração de semanais hoje).
- **Cleanup**: roda todo domingo 07:00 UTC via `backup-postgres-cleanup.yml`.

> Nota sobre a comparação de datas: o cleanup compara `FILE_DATE` com `CUTOFF` como **strings**
> (`[[ "$FILE_DATE" > "$CUTOFF" ]]`). Isso é correto **porque** o formato `YYYY-MM-DD` ordena
> lexicograficamente na mesma ordem cronológica. Não trocar o formato de nome dos dumps sem
> revisar essa comparação.

## Tamanho esperado

- DB em produção: ~18 MB (dump comprimido: ~3-8 MB por arquivo)
- 30 diários + 26 semanais ≈ ~180-460 MB no repo de backups
- Git puro (sem LFS) — adequado para este volume

## Alertas de falha

O backup falha visivelmente se:
- SSH no VPS falhar (timeout, chave inválida)
- `pg_dump` retornar erro
- Arquivo gerado for menor que 1 KB (suspeita de dump vazio)
- Push no repo `startap-backups` falhar (deploy key sem escrita, chave inválida ou known_hosts ausente)

O cleanup falha visivelmente se:
- A deploy key `BACKUP_REPO_SSH_KEY` estiver ausente/inválida (clone via SSH falha)
- `git rm`/`git push` falhar (deploy key sem "Allow write access")

> **Falha histórica resolvida:** o cleanup falhava em todo run com
> `##[error]Input required and not supplied: token` porque usava `actions/checkout` com
> `token: secrets.BACKUP_REPO_TOKEN`, secret que não existe mais. Corrigido para o mesmo
> fluxo deploy-key SSH do backup (clone `git@github.com`). Se reaparecer, confirme que o
> workflow NÃO referencia `BACKUP_REPO_TOKEN`.

GitHub Actions notifica o dono do repo por e-mail em caso de falha no schedule.
