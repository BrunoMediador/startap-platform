# Missão 032 — backup resiliente e restore drill automatizado

- **Card:** SCRUM-167
- **DRI:** devops-sre
- **Reviews obrigatórios:** security e qa-tester
- **ADR:** 0038
- **Branch:** `infra/scrum-167-backup-restore-drill`
- **Apetite:** missão grande, até 5 dias úteis, rollout progressivo e reversível
- **Status em 14/08/2026:** correções dos findings de QA materializadas;
  focused integral 135/135 verde; SSH 4/4 verde;
  DAC 3 skips (macOS) e PG16 9 skips sem Docker; produção OFF;
  novo review e QA pendentes

## Problema

O backup legado dependia de um runner GitHub atravessar SSH até a VPS, capturava
host keys dinamicamente e só preservava o dump depois do push. O run
`31466784443` recebeu runner e falhou em
`ssh-keyscan -p 22 187.77.242.220 >> ~/.ssh/known_hosts` (exit 1). Nenhum dump
foi iniciado. O intervalo entre backups offsite válidos chegou a 47 h 56 min 48 s.

O alerta WAHA não é evidência suficiente: no job `93701256412` a API aceitou duas
chamadas, mas entrega não é demonstrável; atualmente `ALERTAS` está desconectada.

## Decisão

Adotar o modelo C do ADR 0038: produção local via systemd, fallback cifrado antes
do offsite, uploader separado, freshness local + detector GitHub e drill local
PG16 por digest. O workflow legado continua agendado até prova do timer novo.

## Guardrails

- nenhum dado, sessão ou serviço de cliente é alterado;
- nenhum contato ou WhatsApp é usado;
- nenhuma chave é gerada/configurada sem GO;
- identidade offline do Bruno nunca vai à VPS/GitHub;
- nenhum plaintext sai de tmpfs;
- nenhum restore aponta para produção;
- nenhuma retenção ou exclusão de backup real;
- rollback preserva todos os artefatos e o caminho legado;
- workflow, units e scripts permanecem fail-closed sem markers/configuração.
- nenhum workflow recebe chave root; secrets de backup pertencem somente a
  Environments externamente limitados à `main`;
- merge fica bloqueado até conta/chave dump-only e Environments estarem provados,
  evitando gap no writer legado.

## Entregáveis

- producer não-root, helper de dump fixo, seal root, decrypt validator,
  promoter, uploader, health e detector externo;
- restore drill PG16 isolado e helper Docker de comando fixo;
- users/tmpfiles/sudoers e units/timers hardened;
- installer/preflight/rollback sem ativação implícita;
- workflow GitHub de status/dispatch restrito e legado por forced-command
  dump-only sem shell/root;
- suíte adversarial shell + integração Docker reproduzível;
- runbooks de backup, restore e setup.

## Definition of Done

- [x] causa raiz do run `31466784443` documentada sem hipótese de runner;
- [x] fallback cifrado, manifest/checksum e promoção atômica implementados;
- [x] retry/classificação/timeout/concurrency implementados e testados por fixture;
- [x] host pin, least privilege e ausência de `ssh-keyscan` nos workflows de backup;
- [x] freshness `healthy/degraded/stale/invalid/none` e GHA independente;
- [x] drill PG16, destino vazio, `ON_ERROR_STOP=1`, invariantes e teardown codificados;
- [x] testes negativos automatizados e sanitization gate;
- [ ] integração Docker/PG16 executada em runner compatível;
- [ ] GO A e GO B do Bruno;
- [ ] decrypt do artefato real pela identidade de automação;
- [ ] prova assistida do recipient offline do Bruno;
- [ ] security verde;
- [ ] QA verde;
- [ ] suíte completa/CI/PR/main verdes;
- [ ] rollout, dispatch controlado e evidência pós-merge;
- [ ] RPO/RTO pós-rollout registrados;
- [ ] Jira encerrado com evidências.

O card não pode ser concluído enquanto qualquer item aberto permanecer.

## Test plan

### Focado, sem produção

`scripts/backup-resilience/tests/run.sh` passou **135/135 integral** em
14/08/2026:
helper/FIFO e claim
root-only, marker inválido/symlink/hardlink/diretório vazio ou aninhado/FIFO/
socket/arquivo oversized/race com segunda request válida, quarantine root-only
com trabalho limitado e recuperação de >128 entries e >32 claims, plaintext
cleanup e reconciliação após
`SIGKILL`, bridge DAC com identidades distintas,
seal/attestation, retomada em cada fronteira producer→seal→promote até
`COMPLETE`, age real/chave errada, retry/exaustão/falhas terminais, attempts
local/offsite e RPO preservado, truth table de freshness, cleanup entre units,
teardown injetado e reconciliação Docker pós-`SIGKILL`, publicação same-dir do
journal durável, `fsync` file+dir, recovery após perda simulada de `/run` em
cada fronteira (journal/network/volume/container/restore/teardown), órfão com
label sem journal fail-closed, inclusive nos intervalos create/remove → update
do journal, formatos oficiais por tipo (`volume ls` usa `.Name`, container e
network usam `.ID`), fixture que recusa template/opção desconhecido, e symlinks
quebrados no-follow, inspect trivalente
(presente/ausente/erro), destino/PG inseguros,
allowlists exatas, blob/tuple/ancestry e modos Git 100644 da âncora, SSH,
cutover, Environments e logs.

`integration-sshd.sh` passou 4/4 com um `sshd` loopback descartável: status e
dump legado chegaram somente aos wrappers exatos, e tentativas arbitrárias
foram recusadas sem imprimir UID/GID. Nenhuma porta pública ou conta de produção
foi usada.

Na correção de QA, o contrato de inspect dos mounts removeu o newline embutido
do template (o CLI Docker é o único emissor da terminação) e recusa resposta
extra/ambígua. A fixture DAC tornou somente o pai root-owned traverse-only 0711,
preservou secrets/bridges restritos e só reporta cada um dos três casos verde
depois de gravar/verificar seu marker de execução em Linux root com `setpriv`.
`bash -n` validou 39
scripts, o helper Python passou AST parse, os 6 workflows passaram parse YAML, e
`git diff --check` + scans de whitespace, segredo, CPF/telefone e chave root
ficaram limpos. `shellcheck`, `actionlint` e `systemd-analyze` não existem no
host macOS local e permanecem gates obrigatórios da CI Linux.

### Docker/PG16 descartável

`integration-pg16.sh`/`integration-pg16-runner.sh` cobrem nove casos: restore
válido, SQL inválido, destino não vazio, nome produtivo, versão/digest errada e
teardown após falha, mais `SIGKILL` depois do restore seguido de reconciler e
novo drill verde, inventário real vazio e volume real etiquetado preservado sem
tuple antes de ser reconciliado exatamente. Sem Docker local, ficam skip
explícito; CI descartável deve
executar com `SCRUM167_RUN_DOCKER_INTEGRATION=1`.

`integration-dac.sh` usa UID/GID numéricos distintos e `setpriv` sem
capabilities em Linux root: o cycle lê somente o marker 0640 via grupo bridge e
não atravessa o RuntimeDirectory 0700 do producer. Os 3 casos ficaram em skip
explícito no macOS e devem rodar em CI Linux root.

### Antes de merge/rollout

Rodar `bash -n`, shellcheck, actionlint, validação das units, integração PG16,
build completo, painel legado, Vitest integral, E2E relevante e secret scan.
Depois dos reviews, atualizar com `origin/main`, repetir tudo e aguardar CI.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| ativação sem custódia decidida | markers GO + config/credential preflight |
| falsa confiança em envelope age | decrypt real automatizado + prova Bruno |
| deploy key altera histórico | single-repo, no force, ancestry/FF e âncora GHA |
| perda total da VPS | offsite; fallback local não é vendido como proteção |
| GitHub fora | fallback local continua válido; uploader fica degraded/vermelho |
| drill toca produção | nomes/digest/mounts/network/db fixos e fail-closed |
| plaintext em disco/swap/core | tmpfs, cap, trap + `ExecStopPost`, swap/core off |
| TOCTOU entre processos | incoming owner-only → seal root → attestation externa → promoção com revalidação |
| branch altera o próprio YAML | secrets só em Environments `*-main`; prova externa via API antes do merge/ativação |
| kill entre markers | pending/ready e staging oculto retomáveis; `COMPLETE` é publicado por último |
| producer recebe `SIGKILL` com plaintext | reconciler root independente, cap de runtime + trabalho de quarantine limitado, startup + `ExecStopPost`; não acessa ciphertext |
| drill/reboot ocorre após qualquer fase | journal root-only em `/var/lib` é gravado antes do create e fsynced a cada fase; reconciler de boot remove só tuple nome+label exata e valida ausência |
| labels persistem sem journal | inventário read-only falha fechado; nenhum scan destrutivo nem remoção por inferência |
| marker/claim é symlink quebrado | existência considera `-e || -L`; claim/unlink no-follow libera o slot e mantém alvo externo intocado |
| erro no Docker é confundido com ausência | estado trivalente; somente mensagem exata de not-found é ausência, qualquer erro retém state e impede sucesso |
| marker malformado/especial causa loop | claim atômico para queue root-only, size check antes da leitura, consumo no-follow em lotes 256/512 e rate limit 3/60 s |
| entrada parecida passa allowlist | comparação por elemento exato; nomes com espaço/newline/compound são adversariais |
| blob Git muda tipo/modo | path literal exato e modo 100644 para manifest e `.age`, atual e anterior |
| rollback apaga evidência | script só desabilita timers/markers |
| pin envelhece | atualização somente por PR/review |

## Rollout

0. criar/provar conta dump-only e Environments `*-main`; sem isso, não mergear;
1. merge com timers locais OFF; workflow legado restrito permanece o único writer;
2. GO A/B, stage, configuração segura, checkout offsite e preflight;
3. `arm`; executar manualmente duas cadeias locais e drills, sem uploader;
4. `activate`; observar timers locais em shadow, legado ainda único writer;
5. desabilitar schedule legado pela repository variable e registrar a prova;
6. imediatamente executar `activate-uploader`, upload e freshness;
7. bootstrap revisado da âncora, depois detector periódico e dispatch controlado;
8. monitorar ao menos 48 h. Nunca manter os dois uploaders ativos juntos.

## Rollback

- desligar somente timers e detector/cutover variables novos;
- manter execução em andamento terminar quando seguro;
- preservar generations locais, reports, credenciais e backups offsite;
- reativar o schedule legado, provar um dispatch `.age` e só então desligar os
  timers locais;
- não remover qualquer cópia real sem autorização expressa.

## Evidências a anexar no Jira

- run/job da causa raiz e runs vizinhos;
- SHA base, commits, PR e merge SHA;
- totais pass/fail/skip por suíte;
- IDs da CI/main/workflow_dispatch;
- health JSON e drill JSON sanitizados;
- SHA/tamanho/timestamp do artefato, RPO/RTO;
- confirmação de teardown e disponibilidade da produção;
- sign-offs security/QA;
- GOs do Bruno e prova assistida, sem fingerprint/segredo.

## Decisões pendentes do Bruno

1. **GO A:** identidade de automação dedicada como segundo recipient e custódia
   via `LoadCredential`, mantendo identity offline fora da VPS/GitHub.
2. **GO B:** deploy key nova VPS-only, write apenas em `startap-backups`.

Até as respostas, manter SCRUM-167 “Em andamento” e a implementação OFF.
