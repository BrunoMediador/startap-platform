# Como contribuir

Este repositório é a **única fonte de verdade** para o código que roda em produção. Mudanças vão pra produção **só via Pull Request**.

## Fluxo padrão

```
1. Branch a partir de main
2. Implementar + commitar
3. Push da branch
4. Abrir PR
5. CI roda build/testes
6. Review + merge
7. Deploy no servidor
```

## Setup local

```bash
git clone https://github.com/BrunoMediador/startap-platform.git
cd startap-platform
npm install
npm run build --workspaces --if-present
```

## Criando uma mudança

```bash
git checkout main
git pull origin main
git checkout -b feat/minha-mudanca

# faça as edições...

# build local pra validar
npm run build --workspaces --if-present

git add <arquivos>
git commit -m "feat: descricao curta no imperativo"
git push -u origin feat/minha-mudanca
```

## Abrindo o PR

Pelo painel do GitHub OU via `gh`:

```bash
gh pr create --title "feat: descricao" --body "Resumo do que muda e por que."
```

Aguarde:
- ✅ CI (build + testes em Node 20)
- 👀 Review

## Após merge — Deploy

No servidor:

```bash
ssh root@187.77.242.220
cd /opt/automacoes/code
./scripts/deploy.sh
```

O script faz `git pull` + `docker compose build --no-cache` + `up -d` + health check.

> **Por que `--no-cache`?** Docker às vezes cacheia layers antigas do source quando você muda só conteúdo dentro de packages. `--no-cache` garante que o build sempre pega o código atual.

## Convenção de commits

Usamos prefixos no estilo Conventional Commits:

| Prefixo | Quando |
|---|---|
| `feat:` | Nova funcionalidade |
| `fix:` | Bug fix |
| `docs:` | Só documentação |
| `chore:` | Manutenção (deps, configs) |
| `refactor:` | Refactor sem mudança de comportamento |
| `test:` | Adicionar/ajustar testes |

Exemplos bons:
- `feat: adicionar handler de áudio no bot Ricardo`
- `fix: pausa.ts respeita coluna numero_cliente em bot_pausa`
- `chore: bump biome para 1.9`

## Regras de branch protection na main

- ✋ Push direto na `main` está bloqueado
- ✅ Só aceita merge via PR
- ✅ CI tem que passar
- 📝 Pelo menos 1 review aprovada (configurar se virar time)

## Hot fix de emergência

Se a prod estiver quebrada:

1. Branch `hotfix/<descricao>` a partir de `main`
2. Fix + commit + push
3. PR + merge rápido
4. Deploy via `./scripts/deploy.sh`

**Nunca edite arquivos direto em `/opt/automacoes/code/`** (a não ser que esteja debugando ao vivo). Edições locais fora do git são perdidas no próximo `git pull`.

## Rollback

```bash
# No servidor
cd /opt/automacoes/code
git log --oneline -10                          # acha o commit bom
git revert <commit-ruim>                       # cria commit de reversao
git push origin main                           # OU abre PR rapido
# depois roda ./scripts/deploy.sh
```

Como último recurso (perda de histórico):
```bash
git reset --hard <commit-bom>
git push --force origin main   # ⚠️ destrutivo
./scripts/deploy.sh
```
