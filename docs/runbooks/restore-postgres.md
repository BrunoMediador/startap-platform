# Runbook — restore drill PostgreSQL 16 descartável

> Nunca use este fluxo sobre produção. O drill não aceita host, volume, banco,
> `.env` ou porta fornecidos pelo operador. A execução real permanece OFF até
> GO A, security, QA e um preflight verde.

## O que o drill prova

O drill periódico usa o artefato `.age` real mais recente e testa a cadeia:

`ciphertext → checksum/manifest → decrypt age real → gzip → SQL → PG16 → invariantes`

Um restore antes da criptografia não satisfaz este runbook. A identidade é
entregue somente ao processo `drill-prepare` via `LoadCredential=`; o processo
Docker não a recebe.

## Isolamento obrigatório

- imagem exata:
  `postgres:16@sha256:ce5c12ac6952df86affd04ade354cfcb9a0aa1171cd7912e6dbd81578a989a63`;
- nomes `startap-backup-drill-<8 hex>` derivados do run ID validado;
- container, volume e network têm label `tech.startap.backup-drill=<run_id>`;
- network `--internal`, sem porta publicada;
- um único volume novo e nomeado; nenhum bind mount;
- database obrigatório `startap_drill_<8 hex>` e role `postgres`;
- destino deve ter zero tabelas públicas antes do restore;
- nenhum `.env` de produção é carregado;
- SQL entra por `psql -v ON_ERROR_STOP=1 --no-psqlrc`;
- teardown verifica explicitamente ausência de container, volume e network e
  propaga qualquer falha; sucesso só é publicado depois dessa verificação;
- plaintext vive somente no RuntimeDirectory tmpfs e é truncado/removido por
  trap e `ExecStopPost`, inclusive na janela entre prepare e restore;
- um reconciler root independente roda antes/depois do orchestrator e no boot:
  lê o journal durável root:root 0600 em
  `/var/lib/startap-backup/drill-journal` (separado do input read-only), deriva
  nomes do run ID e remove somente recursos cujo nome
  **e** label exata coincidem; conflito alheio falha fechado e é preservado;
- o journal inicial é publicado e sincronizado antes do primeiro recurso; cada
  fronteira (`network`, `volume`, `container`, restore e teardown) é atualizada
  duravelmente. O temporário nasce root-only no mesmo diretório/device do
  destino, tem link count 1, é promovido por rename e recebe `fsync` de arquivo
  e diretório; o tuple anterior já basta para reconciliar uma queda entre a
  operação Docker e essa atualização. Symlink, hardlink ou conflito
  final/temporário aborta;
- inspect é trivalente: `present`, `absent` ou `query-error`. Somente um
  not-found textual exato por tipo comprova ausência; timeout, daemon/socket,
  permissão ou autenticação mantêm o state e impedem teardown/sucesso. O stderr
  capturado não vai ao journal;
- após `SIGKILL`, o reconciler confirma ausência de container, volume e network,
  remove o input plaintext e permite o próximo drill; nenhum sucesso/RTO é
  publicado antes de `teardown_complete=true`;
- após reboot, a perda esperada de `/run` não afeta o journal em `/var/lib`; se
  ele estiver ausente e houver recurso com a label reservada, o inventário
  read-only deixa a unit vermelha e não executa remoção sem tuple confiável;
- symlink, inclusive quebrado, em `pending-run`, run dir ou journal é removido
  no-follow; os diretórios de run permitidos são limpos com allowlist e caps,
  sem tocar o alvo externo ou manter o slot bloqueado.

Qualquer divergência de nome, label, digest, versão, mount, porta, banco ou
identidade aborta antes do restore.

## Execução automatizada

Após ativação aprovada:

```bash
sudo systemctl start --wait startap-backup-drill.service
sudo systemctl status startap-backup-drill.service --no-pager
sudo jq '{status,postgres_major,table_count,migration_count,rto_seconds,production_target,teardown_complete}' \
  /var/lib/startap-backup-status/drill.json
```

O dispatch GitHub usa o mesmo serviço local por usuário SSH com comando forçado,
environment `backup-recovery-main`, limitado externamente à `main`, e secrets
exclusivos de status. A chave age nunca
vai ao GitHub.

## Validações executadas

1. checksum/tamanho/marker e freshness até 36 h;
2. decrypt real com a identidade de automação;
3. gzip íntegro e markers de `pg_dump`;
4. PostgreSQL major 16 por digest pinado;
5. banco correto, role `postgres` e destino vazio;
6. 50–120 tabelas públicas e ao menos 79 migrations;
7. tabelas `schema_migrations`, `flow_clones`, `bot_config`, `client_billing` e
   `atendimentos`;
8. PKs das quatro tabelas de domínio;
9. FKs `client_billing→flow_clones` e `atendimentos→flow_clones`;
10. índices `idx_flow_clones_status`, `idx_client_billing_next_due` e
    `ix_atend_slot_tenant_data`;
11. extensão `pgcrypto`;
12. inexistência de órfãos nas duas FKs, retornada apenas como booleano;
13. RTO end-to-end desde aquisição/decrypt até teardown confirmado.

Não são impressos contagens de clientes, telefones, CPF, mensagens, prompts ou
SQL. `table_count` e `migration_count` são metadados de schema, não dados de
cliente.

## Prova assistida do recipient offline

A automação prova diariamente o recipient dedicado. Separadamente, o Bruno deve
participar de uma prova periódica em host descartável/controlado, usando sua
identidade offline sem copiá-la para VPS, GitHub ou repositório. Registre somente:

- run ID e SHA-256 do artefato;
- sucesso/falha do decrypt;
- PG major, RTO e invariantes sanitizados;
- operador/data e confirmação de teardown.

Nunca registre a identity, recipient completo, conteúdo decifrado ou comando de
cofre. A primeira prova assistida é condição para encerrar SCRUM-167.

## Teste manual somente em laboratório descartável

Este exemplo usa nomes fixos de laboratório, network interna e nenhum mount de
produção. Ajustes para apontar a um host/banco existente são proibidos.

```bash
docker network create --internal scrum167-lab-net
docker volume create scrum167-lab-data
docker run -d --name scrum167-lab-pg16 \
  --network scrum167-lab-net \
  --mount type=volume,src=scrum167-lab-data,dst=/var/lib/postgresql/data \
  --tmpfs /run/postgresql:rw,noexec,nosuid,nodev,size=16m \
  --security-opt no-new-privileges \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  postgres:16@sha256:ce5c12ac6952df86affd04ade354cfcb9a0aa1171cd7912e6dbd81578a989a63
docker exec scrum167-lab-pg16 createdb -U postgres scrum167_lab
gzip -dc /run/scrum167-lab/dump.sql.gz | \
  docker exec -i scrum167-lab-pg16 \
    psql -U postgres -d scrum167_lab -v ON_ERROR_STOP=1 --no-psqlrc
```

Antes desse bloco, o dump deve ter sido decifrado em tmpfs a partir de uma
fixture ou artefato autorizado. Nunca use `/opt/automacoes/code/.env`,
`automacoes-postgres-1`, `startap`, `startap_database` ou qualquer volume
existente como destino.

Teardown do laboratório (somente após conferir os três nomes exatos):

```bash
docker rm -f scrum167-lab-pg16
docker volume rm scrum167-lab-data
docker network rm scrum167-lab-net
```

## Falhas esperadas e resposta

| Falha | Resultado obrigatório |
|---|---|
| identity errada | `drill_decrypt_failed`, nenhum container criado |
| `.age`/checksum corrompido | aborta antes do decrypt/restore |
| gzip truncado | aborta antes do Docker |
| SQL inválido | `ON_ERROR_STOP=1`, job vermelho e teardown |
| banco não vazio | recusa antes do restore |
| nome parecido com produção | recusa antes do Docker |
| PG diferente de 16/digest divergente | recusa antes do restore |
| falha após criar recurso | remove somente recursos com label/run ID exatos |
| `SIGKILL` após restaurar SQL | reconciler independente remove tuple exata + volume e o próximo drill pode iniciar |
| reboot após qualquer criação/restore/teardown | journal `/var/lib` sobrevive à perda de `/run`; reconciler de boot converge |
| label reservada sem journal | falha fechado após inventário read-only; não remove nem faz scan destrutivo |
| marker/journal é symlink quebrado | unlink no-follow, alvo externo intacto e slot recuperável |
| nome igual com label alheio | recusa e preserva o recurso, sem `docker rm` |

Uma falha do drill não toca aplicação nem PostgreSQL de produção. Não reinicie
serviços para “tentar de novo”; preserve o relatório sanitizado e investigue.
