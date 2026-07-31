# Runbook: Restore do Postgres (`startap-backups` → banco novo)

> Companion de `docs/runbooks/backup-postgres.md`. Escrito depois do primeiro
> teste de restore REAL (SCRUM-133, 25/07/2026) — antes disso, 38+ backups
> verdes nunca tinham sido provados restauráveis.

## Passo 0 — já foi aplicado / você já sabe disto?

- Se você está aqui em pânico às 3h, respire: o restore **funciona** e leva
  **poucos minutos** (dominado por logística humana, não pelo comando em si).
- **NUNCA restaure sobre `automacoes-postgres-1` (produção).** Sempre um
  container Postgres 16 **novo e descartável**. Se em dúvida sobre onde está
  restaurando, PARE.

## ⚠️ A ARMADILHA (motivo deste card)

Desde o SCRUM-45 a aplicação roda com o role `startap_app` (CRUD-only, sem
DDL). **O dump é gerado com `pg_dump -U startap_user --no-owner --no-acl`**
(ver `scripts/backup-postgres.sh`) — por isso o `.sql` **não contém nenhum
`OWNER TO` nem `GRANT`**. Isso significa que o restore não precisa
necessariamente do role `startap_user`, mas **precisa de um role com
privilégio de `CREATE` no database/schema** (na prática: o superuser do
container novo, ex. `postgres`).

**Provado em laboratório (25/07):** restaurar o mesmo dump com um role
CRUD-only (equivalente a `startap_app` em produção) falha com **98.277
erros**, começando por:
```
ERROR: permission denied to create extension "pgcrypto"
ERROR: permission denied for schema public
```
Resultado: **0 tabelas criadas**. Se alguém tentar restaurar usando as
credenciais de runtime da aplicação (as que estão no `.env` do app), o
restore falha silenciosamente feio — e a hora errada de descobrir isso é
no meio de um incidente real.

**Regra:** restore sempre com o superuser do Postgres do container de
destino (`postgres`, ou equivalente), nunca com `startap_app`.

## Pré-requisitos

- Docker no host onde for restaurar (não precisa ser o VPS de produção —
  pode ser qualquer máquina com Docker; o teste de referência rodou direto
  no VPS, num container isolado, rede própria, porta só em `127.0.0.1`).
- Chave privada age (`AGE-SECRET-KEY-...`) — está no cofre
  `~/Documents/STARTAP-CREDENCIAIS.md` (2ª cópia em `~/Documents/backup-key.txt`).
  Backups a partir de ~24/07 estão cifrados (`.sql.gz.age`); antes disso, só `.sql.gz`.
- Acesso de leitura ao repo `BrunoMediador/startap-backups` (auth via
  `git credential fill` — nunca varrer o Keychain).
- `age` instalado (`brew install age`).

## Passo a passo

### 1. Escolher o dump

```bash
git clone git@github.com:BrunoMediador/startap-backups.git
cd startap-backups
git log --oneline | grep "^[a-f0-9]* backup:" | head -20   # escolher o commit/data
```

### 2. Decifrar (se `.sql.gz.age`) e descomprimir

```bash
age -d -i /path/para/age-key.txt dumps/2026/07/<TIMESTAMP>.sql.gz.age > dump.sql.gz
gunzip -k dump.sql.gz     # gera dump.sql
```

Dumps antigos (pré cifra, `.sql.gz` sem `.age`) pulam o passo `age -d`.

### 3. Subir um Postgres 16 **efêmero e isolado**

```bash
docker network create restore-test-net
docker run -d --name pg-restore-test \
  --network restore-test-net \
  -e POSTGRES_PASSWORD=<qualquer-senha-de-teste> \
  -e POSTGRES_DB=restoretest \
  -p 127.0.0.1:55432:5432 \
  postgres:16
```

Confirme que é um container novo (`docker ps` mostra o nome distinto,
porta só em `127.0.0.1`, nunca a mesma rede/volume de `automacoes-postgres-1`).

### 4. Restaurar — com o role certo (`postgres`, superuser do container novo)

```bash
docker cp dump.sql pg-restore-test:/tmp/dump.sql
docker exec pg-restore-test psql -U postgres -d restoretest -f /tmp/dump.sql
```

Tempo esperado: **segundos** para um banco deste tamanho (~3-4 MB
comprimido / ~25 MB de SQL puro). Se demorar minutos, algo está errado
(disco lento, contenção) — investigar antes de confiar no restore.

**Confirme zero erros:**
```bash
docker exec pg-restore-test psql -U postgres -d restoretest -f /tmp/dump.sql 2>&1 | grep -ic error
# esperado: 0
```

### 5. Validar com contagens (nunca confiar só no "rodou sem erro")

```bash
docker exec pg-restore-test psql -U postgres -d restoretest -t -c "
SELECT 'flow_clones', count(*) FROM flow_clones
UNION ALL SELECT 'client_billing', count(*) FROM client_billing
UNION ALL SELECT 'atendimentos', count(*) FROM atendimentos
UNION ALL SELECT 'chat_histories', count(*) FROM chat_histories
UNION ALL SELECT 'alert_states', count(*) FROM alert_states
UNION ALL SELECT 'billing_charges', count(*) FROM billing_charges;
"
```

Compare com produção (`docker exec automacoes-postgres-1 psql -U startap_user
-d startap_database -c "SELECT count(*) FROM <tabela>;"`). Diferença pequena
(poucas linhas) em tabelas de atividade contínua (`chat_histories`,
`alert_states`) é esperada — reflete o intervalo entre o dump e agora.
Diferença grande é achado e trava o restore até investigar.

### 6. Destruir o ambiente de teste (sempre)

```bash
docker rm -f pg-restore-test
docker network rm restore-test-net
rm -f dump.sql dump.sql.gz
# se copiou algo pro host (scp/cat), apagar também o arquivo intermediário e a chave age local
```

## Resultado do teste de referência (SCRUM-133, 25/07/2026)

- **Restore funcionou: SIM**, com role `postgres` (superuser do container
  novo) — 0 erros, 0 divergência relevante de contagem.
- **Restore com role CRUD-only: FALHOU** (98.277 erros, 0 tabelas criadas) —
  prova da armadilha acima.
- **Tempo do `psql -f` isolado**: ~2s (dump de ~26 MB de SQL puro, 60 tabelas).
  Decifrar (`age -d`) e `gunzip`: também subsegundo cada, no dump testado
  (~3,2 MB comprimido). RTO ponta a ponta dominado por logística humana
  (achar o commit, montar o ambiente), não pelo processamento.
- **Dump testado**: commit `b63244c7` do `startap-backups`
  (`2026-07-25-195852.sql.gz.age`, 3.2 MB).
- **Contagens batido 1:1** contra produção nas 6 tabelas-chave
  (`flow_clones`, `client_billing`, `atendimentos`, `billing_charges` exatos;
  `chat_histories` e `alert_states` com diferença de 1-2 linhas, esperado
  por atividade contínua entre o dump e a comparação).

## RPO real (não o nominal)

O cron do `backup-postgres.yml` é `0 6 * * *` **UTC** = **03:00 BRT**
(não "06:00 BRT" — checar sempre o fuso do cron do GitHub Actions, que é
sempre UTC). Analisando os últimos ~60 runs (`git log` do `startap-backups`):

- Concentração real de execução: **07h-11h UTC** (grande maioria 08h-10h UTC),
  isto é, **4 a 8 horas de atraso** sobre o horário agendado — atribuído a
  fila/scheduling do GitHub Actions (cron do GH não é preciso, principalmente
  em runners hospedados).
- Outliers observados: runs isolados às 13h58 UTC e 19h59 UTC (24-25/07) —
  provavelmente disparos manuais/reruns durante o incidente do SCRUM-146.
- **RPO real na prática: até ~24-30h** no pior caso (se o run de um dia
  atrasar ou falhar e o próximo só rodar no dia seguinte pela manhã) — não
  os "24h" nominais do cron diário, e certamente não a janela estreita
  "08:04-08:45" citada informalmente; a variância real é maior
  (07h-11h UTC, com outliers fora dessa faixa).

## Armadilhas encontradas neste exercício (valor do card)

1. **Role do dump ≠ role do restore, e ninguém tinha testado isso.** O dump
   sai limpo de owner/ACL (`--no-owner --no-acl`), então o restore não
   *precisa* do `startap_user` — mas precisa de um role com `CREATE`.
   Tentar restaurar com o role de runtime da app (`startap_app`) falha 100%,
   silenciosamente feio (mensagens de erro por linha, sem abortar o script
   se não houver `set -e`/`ON_ERROR_STOP`). **Ação futura**: rodar o
   restore sempre com `psql -v ON_ERROR_STOP=1` para abortar no primeiro
   erro em vez de despejar milhares de erros.
2. **Card citava "06:00 BRT" para o cron** — na verdade é `0 6 * * *` UTC
   (03:00 BRT). Fácil de confundir; sempre conferir o YAML do workflow, não
   assumir fuso.
3. **Sem Docker local disponível** neste exercício — o teste de restore
   precisou rodar no próprio VPS (isolado: rede/nome/porta distintos do
   Postgres de produção). Puder rodar em qualquer máquina com Docker é
   melhor (zero risco de vizinhança com produção); documentar isso como
   preferência para a próxima vez que alguém repetir este teste.
4. **`\restrict` no topo do dump**: `pg_dump` do PG 16.13 recente emite uma
   diretiva `\restrict <token>` (feature nova de `psql`/`pg_dump` contra
   execução parcial acidental) — não é erro, é esperado; scripts antigos de
   restore que não reconheçam `\restrict`/`\unrestrict` podem se confundir.
5. **Nenhum teste de restore automatizado existe ainda.** Este runbook é
   manual. Uma extensão natural (não feita agora — decisão de escopo/custo
   do PM) seria um job periódico que roda exatamente estes passos e falha o
   CI se o restore ou as contagens divergirem.
