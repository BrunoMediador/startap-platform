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
| `SSH_PRIVATE_KEY` | Chave privada SSH (ed25519) do root@187.77.242.220 | Provavelmente ja existe (usada pelo deploy.yml — confirmar em Settings → Secrets) |
| `BACKUP_REPO_TOKEN` | Personal Access Token com escopo `repo` no repositório `BrunoMediador/startap-backups` | Bruno precisa criar em github.com/settings/tokens |

### Como criar o BACKUP_REPO_TOKEN

1. Acesse: https://github.com/settings/tokens/new (ou Fine-grained tokens)
2. Nome: `startap-backups-writer`
3. Escopo mínimo: `repo` (acesso completo ao repositório privado)
4. Copie o token gerado
5. Adicione em: github.com/BrunoMediador/startap-platform → Settings → Secrets → Actions → New repository secret
   - Name: `BACKUP_REPO_TOKEN`
   - Value: token copiado

## Schedules

| Workflow | Cron | BRT equivalente | Ação |
|---|---|---|---|
| `backup-postgres.yml` | `0 6 * * *` | 03:00 todo dia | Dump + commit |
| `backup-postgres-cleanup.yml` | `0 7 * * 0` | 04:00 domingos | Remove diários > 30 dias |

## Como disparar manualmente

Via GitHub UI:
1. github.com/BrunoMediador/startap-platform → Actions → "Backup Postgres → startap-backups"
2. "Run workflow" → "Run workflow" (branch main)

Via CLI:
```bash
gh workflow run backup-postgres.yml --repo BrunoMediador/startap-platform
```

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

- **Diários**: mantidos por 30 dias corridos
- **Semanais**: o primeiro backup de cada semana ISO é mantido indefinidamente pelo cleanup
- **Cleanup**: roda toda domingo 07:00 UTC via `backup-postgres-cleanup.yml`

## Tamanho esperado

- DB em produção: ~18 MB (dump comprimido: ~3-8 MB por arquivo)
- 30 diários + 26 semanais ≈ ~180-460 MB no repo de backups
- Git puro (sem LFS) — adequado para este volume

## Alertas de falha

O workflow falha visivelmente se:
- SSH no VPS falhar (timeout, chave inválida)
- `pg_dump` retornar erro
- Arquivo gerado for menor que 1 KB (suspeita de dump vazio)
- Push no repo `startap-backups` falhar (token inválido ou expirado)

GitHub Actions notifica o dono do repo por e-mail em caso de falha no schedule.
