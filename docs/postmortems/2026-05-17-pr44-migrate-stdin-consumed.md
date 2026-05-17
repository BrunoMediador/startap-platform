# Postmortem: docker exec -i drenava stdin do loop de migrations

> **Quem escreve:** `infra`
> **Onde fica:** `docs/postmortems/2026-05-17-pr44-migrate-stdin-consumed.md`
> **Referencia:** PR #44 (fix), PR #40 (audit que detectou), PR #45 (gate preventivo)

---

## Resumo executivo

**Data:** 2026-05-17
**Duracao do impacto:** varios dias (entrou silenciosamente; detectado em 2026-05-17)
**Severidade:** P1 — feature critica de clones completamente inoperante em prod
**Quem detectou:** auditoria manual de infra (PR #40 — `docs/audit-clones.md`)
**Quem mitigou:** Bruno via SSH manual + PR #44
**Quem escreveu este postmortem:** `infra`

### O que aconteceu (1 paragrafo)

O script `scripts/migrate.sh` usa um loop `while read -d ''` alimentado por `find ... -print0 | sort -z` via redirecionamento de processo (`< <(...)`). Dentro do loop, a funcao `psql_exec` invocava `docker exec -i`, que mantem o stdin do processo filho aberto e conectado ao mesmo descritor de arquivo que alimenta o `read`. Com isso, o `docker exec` drenava a pipe do `find` ao terminar sua execucao, fazendo o proximo `read` receber EOF imediatamente. O resultado pratico: o loop processava apenas o primeiro arquivo de migration (002) e encerrava, reportando "0 aplicadas, 1 puladas" para todos os outros 12 arquivos. As migrations 003 a 014 nunca foram aplicadas em producao, deixando a tabela `flow_clones` inexistente e a coluna `leads.slot` ausente — o que derrubou silenciosamente toda a feature de clones de bots.

---

## Linha do tempo (timeline)

Datas aproximadas em BRT baseadas nos commits e PRs do repositorio.

- **[data desconhecida — ~inicio de maio/2026]** — migrations 003+ foram adicionadas ao repo via PRs (#30, #31, #32, #33 e outros). Em cada deploy subsequente, o bug silenciosamente pulava todas elas.
- **[varios deploys]** — `migrate.sh` terminava com `exit 0` e reportava "Migrations: 0 aplicadas, 1 puladas". Deploy continuava normalmente. Sem alerta.
- **2026-05-17 ~17:30 BRT** — auditoria manual (PR #40) cruza `git ls-files packages/db/migrations/` (13 arquivos) com logs do GitHub Actions (deploy 25974376832) e constata divergencia: prod so tem migration 002 registrada.
- **2026-05-17 ~17:30 BRT** — PR #40 mergeado documentando o achado. Recomendacoes de SSH e re-run manual encaminhadas para Bruno.
- **2026-05-17 ~21:00 BRT** — PR #44 criado com o fix de `psql_exec_in` vs `psql_exec`. Migrations 003-014 aplicadas manualmente em prod via SSH antes do merge, validando o fix.
- **2026-05-17 ~21:22 BRT** — PR #44 mergeado (commit `82cd345`).
- **2026-05-17 ~21:24 BRT** — PR #45 mergeado com gate defensivo em `deploy.sh` que aborta se `schema_migrations < arquivos no repo`.
- **2026-05-17 ~21:XX BRT** — validacao final: `/api/clones` retorna `[]` (antes: erro 500), `leads[0].slot` populado (antes: null). Incidente encerrado.

---

## Impacto

- **Usuarios afetados:** Bruno, Icaro e qualquer cliente em fase de teste que tentasse usar clones de bot
- **Funcionalidades afetadas:**
  - Feature de clones inteira (`/api/clones`, `/api/sessions/*`, wizard no painel)
  - Isolamento de leads por slot (`leads.slot`)
  - Qualquer funcionalidade que dependesse das migrations 003-014
- **Dados perdidos:** nenhum dado existente foi corrompido. Dados que deveriam ter sido salvos em `flow_clones` ou `leads.slot` durante o periodo podem nao ter sido registrados (nao mensurado).
- **Receita afetada:** nao mensurado — nenhum cliente pago dependia da feature de clones neste momento
- **Reputacao:** nenhum cliente reportou falha diretamente; impacto ficou restrito ao ambiente interno de testes

---

## Causa raiz (5 Whys)

**Por que a feature de clones nao funcionava em prod?**
- A tabela `flow_clones` e a coluna `leads.slot` nao existiam no banco de producao.

**Por que essas estruturas nao existiam se as migrations estavam no repo?**
- O script `migrate.sh` processava apenas o primeiro arquivo de migration em cada execucao e pulava os demais silenciosamente.

**Por que o loop processava so o primeiro arquivo?**
- A funcao `psql_exec` usava `docker exec -i`, que mantem stdin aberto mesmo sem necessidade. O stdin compartilhado com o loop `while read -d ''` era drenado pelo `docker exec`, causando EOF prematuro no segundo `read`.

**Por que esse comportamento passou pelo CI e pelos deploys sem ser detectado?**
- O script retornava `exit 0` mesmo processando apenas 1 arquivo. Nao havia validacao de que o numero de migrations aplicadas correspondia ao numero de arquivos no repositorio. O CI so verificava se o script terminava sem erro, nao se o resultado era correto.

**Por que o sistema foi desenhado sem essa validacao?**
- O script de migrations foi escrito sem um contrato explicito de pos-condicao ("ao terminar, `schema_migrations` deve ter N entradas"). A semantica de `-i` no `docker exec` e sua interacao com redirecionamentos de stdin e uma sutileza do shell pouco documentada, e nao havia testes automatizados para o proprio runner de migrations.

---

## Como foi mitigado (curto prazo)

Bruno aplicou manualmente as migrations pendentes via SSH antes do merge do PR #44:

```bash
# Confirmou arquivos faltantes em prod
ssh root@187.77.242.220 "ls -la /opt/automacoes/code/packages/db/migrations/*.sql | wc -l"

# Re-rodou migrate.sh com o fix aplicado localmente
# Migrations 003-012 marcadas como "ja rodadas" (schema ja existia via DDL anterior)
# Migrations 013-014 aplicadas de verdade

# Validou resultado
curl -s -u admin:*** https://gestao.startap.tech/api/clones
curl -s -u admin:*** https://gestao.startap.tech/api/leads | head -1
```

O fix tecnico (PR #44) separa `psql_exec` em duas funcoes:
- `psql_exec_in` — usa `docker exec -i`, reservado para quando o SQL e passado via stdin redirect (`< arquivo.sql`, `<<SQL`)
- `psql_exec` — usa `docker exec` sem `-i`, para queries inline (`-c`, `-tAc`)

---

## Acoes pra evitar que volte (longo prazo)

- [ ] **Adicionar teste de integracao para `migrate.sh`** — DRI: `dev-back` — Prazo: 2026-05-31 — Status: pendente
  - Rodar o script contra um Postgres efemero em Docker e verificar que todos os N arquivos ficam registrados em `schema_migrations`
  - Missao: `docs/missoes/NNN-teste-migrate-sh.md`

- [ ] **Adicionar health-check de migrations no endpoint `/api/admin/health`** — DRI: `dev-back` — Prazo: 2026-05-31 — Status: pendente
  - Retornar `{ migrations: { expected: N, applied: M, ok: true/false } }` para inspecao sem SSH
  - Missao: `docs/missoes/NNN-health-migrations.md`

- [ ] **Documentar a armadilha `docker exec -i` + loop while no runbook** — DRI: `infra` — Prazo: 2026-05-20 — Status: pendente
  - Adicionar secao em `docs/runbooks/migrations.md` explicando o padrao correto
  - Evita regressao em futuras edicoes do script

- [ ] **Gate de migrations ja esta em prod (PR #45)** — DRI: `infra` — Prazo: concluido — Status: feito
  - `deploy.sh` aborta se `COUNT(schema_migrations) < N_arquivos`. Ja mergeado e ativo.

---

## O que funcionou bem

- **Auditoria proativa**: a equipe cruzou logs do GitHub Actions com `git ls-files` e detectou a divergencia sem precisar de alerta externo ou reclamacao de cliente.
- **Fix atomico e bem documentado**: PR #44 veio com mensagem de commit detalhada explicando a causa raiz, o sintoma e o fix — facilitando revisao e entendimento futuro.
- **Gate preventivo imediato**: PR #45 foi criado e mergeado na mesma sessao, fechando o gap estrutural sem esperar uma proxima ocorrencia.
- **Validacao manual antes do merge**: as migrations foram aplicadas e validadas via API antes do PR #44 ser mergeado, garantindo que o fix era correto antes de chegar em CI.
- **Sem impacto em dados existentes**: a natureza idempotente das migrations (`ON CONFLICT DO NOTHING`, `CREATE TABLE IF NOT EXISTS`) evitou qualquer corrupcao.

---

## O que poderia ter sido melhor

- **O runner de migrations nao tinha pos-condicao verificavel**: o script terminava com `exit 0` independente de ter processado 1 ou 13 arquivos. Um contrato de saida ("processo X arquivos, aplica Y, pula Z; X = Y + Z = total") teria detectado o bug no primeiro deploy.
- **Nenhum teste cobrindo o proprio script de migrations**: o CI valida sintaxe bash (`bash -n`) mas nao comportamento. Um teste de integracao minimo com Postgres efemero teria capturado o bug antes de chegar em prod.
- **Tempo ate deteccao foi longo**: o bug provavelmente existia desde o PR #30 (~inicio de maio). Sem monitoramento de estado do banco apos deploy, ficou invisivel por dias ate a auditoria manual.
- **A causa raiz e uma sutileza de shell pouco documentada**: `docker exec -i` consumindo stdin de um loop pai nao e obvio. Adicionar comentario no script (feito no PR #44) e no runbook teria evitado que o padrao fosse repetido por outro desenvolvedor.

---

## Licoes aprendidas

1. **Scripts de infraestrutura precisam de pos-condicoes verificaveis.** "Terminou sem erro" nao e o mesmo que "fez o que devia". Adicionar assercoes explicitas (contagens, checksums) ao fim de scripts criticos.
2. **`docker exec -i` consome stdin do processo pai quando usado dentro de loops com redirecionamento.** Usar `-i` apenas quando o stdin do proprio comando precisa ser alimentado; omitir em chamadas que nao leem stdin.
3. **Infra critica precisa de testes de comportamento, nao so de sintaxe.** `bash -n` valida parsing; nao valida logica. Investir em testes de integracao para scripts de migration e deploy.
4. **Gates de implantacao devem verificar estado, nao so execucao.** O deploy deve confirmar que o banco esta no estado esperado antes de subir a aplicacao, nao confiar cegamente no `exit 0` de um subcomando.
5. **Detectar divergencia entre repo e estado de prod requer instrumentacao ativa.** Uma verificacao automatica pos-deploy (endpoint `/health` com contagem de migrations) teria reduzido o tempo de deteccao de dias para minutos.

---

## Anexos

- PR que originou a investigacao: [PR #40](https://github.com/BrunoMediador/startap-platform/pull/40) — audit-clones.md
- PR do fix: [PR #44](https://github.com/BrunoMediador/startap-platform/pull/44) — fix(migrate): docker exec -i consumia stdin do loop while
- Commit do fix: `82cd345`
- PR do gate preventivo: [PR #45](https://github.com/BrunoMediador/startap-platform/pull/45) — gate defensivo de migrations sincronizadas
- Log de deploy com sintoma: GitHub Actions run `25974376832` (linha: `Migrations: 0 aplicadas, 1 puladas`)
- Audit detalhado: `docs/audit-clones.md`
