# Runbook — Deploy

O deploy é acionado automaticamente pelo GitHub Actions (`.github/workflows/deploy.yml`) após CI verde na `main`. O workflow abre uma conexão SSH com o servidor `187.77.242.220` e executa `scripts/deploy.sh`, que faz `git pull`, `docker compose build --no-cache`, `up -d` e health check. Nenhuma ação manual é necessária no caminho feliz.

---

## Acompanhar um deploy

```bash
# Ver os 5 runs mais recentes
gh run list --limit 5

# Inspecionar run específico
gh run view <id>

# Ver logs do step que falhou
gh run view <id> --log-failed
```

---

## Verificar prod apos o deploy

```bash
curl -u admin:startap2026 https://gestao.startap.tech/api/usage/summary
# Espera HTTP 200
```

Confirmar containers rodando (opcional):

```bash
ssh -i C:\Users\BrunoSilvaCorrea\.ssh\hostinger_codex_ed25519 root@187.77.242.220 -p 22 \
  "docker ps --format 'table {{.Names}}\t{{.Status}}'"
```

---

## Falhas conhecidas

### SSH `dial tcp ***:22: i/o timeout` no step `Deploy to server`

**Sintoma:** workflow trava ~30 s e encerra antes de rodar `deploy.sh`. Nenhum container e afetado.

**Causa provavel:** instabilidade de rede transitoria ou sobreposicao de carga com um deploy anterior ainda em curso (VPS pequena, build pesado — containers do run anterior podem subir com atraso de ~3 min).

**Primeira acao:**

```bash
gh run rerun <id>
```

Quase sempre resolve na primeira tentativa.

**Escalar se:**

- 2 falhas consecutivas no mesmo SHA
- Containers em prod aparecem como `Restarting` ou `Exited`
- `curl` em `/api/usage/summary` retorna 5xx ou timeout

Nesses casos: SSH manual no servidor, checar `docker ps` e `docker logs startap-api --tail 30`.

**Historico de ocorrencias:**

| Data | Run ID | SHA | Resolucao |
|---|---|---|---|
| 2026-05-17 ~23:18 UTC | `26005627158` | `d2d722f` | `gh run rerun` — passou de primeira, prod verde |
