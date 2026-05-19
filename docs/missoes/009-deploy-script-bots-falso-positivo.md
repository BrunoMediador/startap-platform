# Missão 009 — Deploy script: falso positivo quando bots=0

**DRI:** infra
**Agentes envolvidos:** infra (fix), tester (smoke do próprio deploy)
**Apetite:** pequeno (≤ 1 hora)
**Status:** pendente
**Cliente (persona):** Bruno e o time de devs — todo deploy aparece como ❌ no GitHub Actions mesmo quando o painel sobe limpo, gera ruído e rerun desnecessário.
**Aberta em:** 2026-05-19
**PR-FAQ:** não precisa (bugfix trivial)

---

## Contexto

Bug pego durante a Missão 008. Os 3 deploys consecutivos (após PR #102, #103 e #104) terminaram com:

```
==> bots registrados:
  0 bots
2026/05/19 13:17:35 Process exited with status 1
##[error]Process completed with exit code 1.
```

A imagem buildou, o container subiu, healthchecks passaram (`✅ API healthy`, `✅ painel-admin healthy`) — mas o GitHub Actions marca o deploy como **failure** e Bruno achou que o código estava quebrado em prod 3 vezes seguidas.

## Causa raiz

`scripts/deploy.sh` linha ~1: `set -euo pipefail`.

`scripts/deploy.sh` linha final:
```bash
docker logs --since 30s startap-api 2>&1 | grep 'Bot registrado' | wc -l | xargs -I{} echo "  {} bots"
```

`grep` retorna **exit 1** quando não acha nenhuma linha. Combinado com `pipefail`, todo o pipeline falha. Combinado com `set -e`, o script aborta — mesmo após o painel ter subido com sucesso.

Em prod com banco vazio (sem clones cadastrados), `startap-api` não imprime "Bot registrado" → `grep` falha → deploy "failure". Vai continuar acontecendo até alguém criar um clone real OU consertarmos o script.

## Solução proposta

Substituir o pipeline frágil por `awk`, que **nunca falha em zero matches**:

```bash
echo "==> bots registrados:"
N=$(docker logs --since 30s startap-api 2>&1 | awk '/Bot registrado/ {n++} END {print n+0}')
echo "  $N bots"
```

`awk` imprime `0` quando não acha nada (sem `n` no END) e retorna exit 0. O `+0` força conversão numérica, evitando string vazia.

Alternativa equivalente: `grep -c 'Bot registrado' || true`. Mas `awk` é mais legível e evita o `|| true` que pode mascarar outros erros futuros.

## Definition of Done (DoD)

- [ ] `scripts/deploy.sh` final usa `awk` (ou solução equivalente) que não aborta com 0 matches.
- [ ] Próximo deploy após merge aparece ✅ no GitHub Actions (mesmo com 0 clones em prod).
- [ ] `gh run view <id>` do deploy mostra `Deploy completo. Logs: ...` no final, exit 0.
- [ ] Build local: `bash -n scripts/deploy.sh` (sintaxe válida).
- [ ] `shellcheck scripts/deploy.sh` sem warnings novos (warnings legados ignorados).
- [ ] Tester rodou checklist (✅).
- [ ] PR mergeada pelo Bruno.

## Fora de escopo

- Refatorar o resto do `deploy.sh` (apetite explicitamente pequeno).
- Mudar o que o "Bot registrado" significa ou onde é logado.
- Adicionar alerta/notificação quando bots=0 — pode ser estado válido (startup nova).

## Dependências

- Nenhuma. PR pode entrar a qualquer momento.

## Riscos

- **Mascarar erro real do `docker logs`:** improvável — `awk` ainda processa stdin, e qualquer erro de `docker logs` em si (ex: container não existe) já seria pego antes pelos healthchecks. Mitigação: ler o output do próximo deploy pra confirmar que o número de bots ainda é reportado.
- **Encadeamento com `set -e`:** o `N=$(...)` mantém o exit code 0 do `awk`, então `set -e` não dispara. Mitigação: confirmado lendo o man do bash.

## Atualizações (log)

- **2026-05-19:** Aberta após Bruno confirmar que os 3 deploys da Missão 008 falharam todos pelo mesmo motivo (falso positivo bots=0).
