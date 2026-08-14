# Runbook — backup PostgreSQL resiliente

> Status em 14/08/2026: implementação versionada, **não ativada**. O workflow
> legado continua sendo o produtor agendado até o rollout controlado provar o
> timer local. GO A (custódia age) e GO B (deploy key VPS-only) são obrigatórios.

## Resultado esperado

Uma execução saudável produz, nesta ordem:

1. dump PostgreSQL 16 em tmpfs `/run`, com `umask 077`, limite de tamanho e
   `LimitCORE=0`/`MemorySwapMax=0`;
2. gzip validado e cifrado obrigatoriamente com **dois** recipients age;
3. `manifest.json`, `SHA256SUMS`, `PREPARED` e decrypt real pela identidade de
   automação em unit sem rede;
4. geração root-owned promovida atomicamente em
   `/var/lib/startap-backup/generations/<run_id>/`, com `COMPLETE` por último;
5. uploader separado lê essa geração somente após `COMPLETE`, sem cópia/spool;
6. push offsite com host key pinada e até quatro tentativas totais;
7. estado sanitizado de freshness e evidência externa em GitHub Actions.

Não existe retenção nem exclusão automática nesta missão. O workflow de
retenção é somente auditoria read-only e publica apenas a quantidade proposta;
não possui write key, `git rm`, commit, push ou gate de ativação. Os dumps
históricos de `/opt/backups` e `/opt/automacoes/backups` ficam intocados.

## Failure domains

| Domínio | Proteção | Limite explícito |
|---|---|---|
| GitHub indisponível | fallback cifrado na VPS | não protege perda total da VPS |
| VPS indisponível | cópia offsite | depende do último upload concluído |
| chave de automação perdida | recipient offline do Bruno | prova assistida periódica ainda é necessária |
| deploy key comprometida | chave VPS-only/single-repo, sem force | checksum não é autenticidade; âncora externa detecta alteração |
| `ALERTAS` indisponível | systemd vermelho + detector GitHub | nenhum resultado depende de WhatsApp |

## Componentes e separação de poderes

| Componente | Pode acessar | Não recebe |
|---|---|---|
| producer não-root | recipients públicos, FIFO do helper, tmpfs, incoming | socket Docker, `.env`, identidade privada, deploy key |
| cycle capless | marker 0640 no bridge dedicado + status local | RuntimeDirectory/plaintext do producer, Docker, credenciais |
| dump helper root | comando/args fixos do container/DB e FIFO root:producer; marker reclamado antes da leitura | recipients, identities, deploy key, offsite |
| reconciler producer root | somente tmpfs do producer, bridge e claims, com limites | fallback/ciphertext, credentials, Docker |
| seal/promoter root | transição same-FS e revalidação da attestation | rede, DB, credenciais |
| validator | sealed read-only + identidade via `LoadCredential=`; attestation externa | rede, DB, deploy key, Docker |
| uploader | generation read-only + deploy key via `LoadCredential=` | DB, identity age, Docker |
| drill prepare | generation read-only + identidade | rede e Docker |
| restore helper | dump já decifrado em tmpfs + Docker | identidade, `.env` de produção, volume de produção |
| reconciler drill root | journal durável mínimo + Docker por nome/label exatos | generations, attestation, credentials, `.env` |
| detector GitHub | JSON sanitizado via usuário SSH forçado | root, dump, chaves de recuperação |

Producer/validator/uploader/drill não têm login e não pertencem ao grupo
`docker`. O usuário de status usa shell restrito compatível com `sshd -c`; seu
`authorized_keys` força um único wrapper. Helpers aceitam somente comandos
literais e usam container, banco e argumentos fixos. O producer não usa
`sudo`: markers 0600 sob `/run/startap-backup-producer` acionam units `.path`
separadas. O helper move atomicamente o marker para o diretório root-only
`/run/startap-backup-dump-helper` antes de stat/leitura; symlink, hardlink ou
conteúdo inválido é consumido/quarentenado e não retriggera. Diretórios vazios
ou aninhados, FIFO e socket também são reclamados sob nome único e removidos sem
abrir ou seguir seu conteúdo. Antes de ler um marker regular, o helper limita o
tamanho a 64 bytes. Entradas inválidas são renomeadas, sem cópia, para
`/run/startap-backup-dump-helper/quarantine` root:root 0700; a origem fica livre
imediatamente. A recuperação não usa delete recursivo: processa no máximo 256
operações por helper e 512 pelo reconciler, achata um nível por vez e continua
explicitamente na próxima ativação se restar fila. Assim, o cap limita trabalho
sem bloquear a request válida seguinte.
Paths/services têm limite 3/60 s. Somente a unit root do dump vê o socket Docker.

O `cycle` não recebe capability para atravessar o RuntimeDirectory 0700 do
producer: lê somente `ready-run` pelo grupo `startap-backup-bridge`. Um
reconciler root separado, com paths, inode cap do runtime e trabalho de
quarantine limitados, é acionado no
startup e `ExecStopPost`; ele para/conflita com o helper e limpa somente
plaintext/FIFO/claims em `/run`, sem acesso ao fallback cifrado.

O reconciler Docker usa journal dedicado em
`/var/lib/startap-backup/drill-journal` root:root 0700/0600. O tuple é
persistido e recebe `fsync` antes da primeira criação e depois de cada fase;
uma unit habilitada no boot o consome mesmo quando `/run` foi perdido. Somente
nome + label exata autorizam remoção. Label reservada sem journal causa falha
fechada após inventário read-only, sem scan/removal amplo. Markers e claims,
inclusive symlinks quebrados, são reclamados/removidos no-follow e não mantêm o
slot ocupado nem alteram o alvo externo.

## Estados de saúde

Os limiares versionados são 30 h para `healthy` e 36 h para `stale`:

| Estado | Significado |
|---|---|
| `healthy` | local e offsite válidos, dentro de 30 h e tuple run/SHA/manifest/tamanho coerente |
| `degraded` | cópia válida, mas entre 30–36 h ou somente um destino saudável |
| `stale` | backup válido mais recente acima de 36 h |
| `invalid` | marker/manifest/checksum/tamanho inconsistente |
| `none` | nenhum destino com geração reconhecida |

O JSON registra somente run ID opaco, timestamp UTC, idade, SHA-256, tamanho e
as tentativas local/offsite (`started_at`, `ended_at`, classe e sucesso). Falha
posterior degrada imediatamente o subsistema sem apagar o recovery point/RPO
anterior. Entrega de alerta nunca muda a validade do backup.

## Retry offsite

- máximo: quatro tentativas totais;
- connect timeout: 10 s;
- transfer timeout: 15 min;
- backoff: 5/10/20 s, teto 30 s, jitter 0–3 s;
- retry: timeout, DNS/rede transitória, reset, 429 e 5xx;
- terminal: autenticação, host key divergente, configuração, checksum, age,
  corrupção, destino inseguro e histórico Git divergente/non-fast-forward;
- nunca usa `--force` e nunca executa `ssh-keyscan` em runtime.

## Pré-requisitos de ativação

Não prossiga apenas porque os scripts estão no servidor. O preflight exige:

- `APPROVED_GO_A` e `APPROVED_GO_B`, criados manualmente após a decisão do Bruno;
- age v1.3.1 e age-keygen v1.3.1 nos hashes pinados;
- exatamente dois recipients públicos: Bruno offline + automação dedicada;
- identidade de automação root:root 0400, compatível com um dos recipients;
- deploy key **nova**, VPS-only e write somente em `startap-backups`;
- attestation da deploy key com `reused_existing_key=false`;
- `github_known_hosts` root:root 0644 obtido e conferido fora da execução;
- checkout offsite com remote exato, sem histórico divergente;
- security e QA verdes.
- conta SSH legado dump-only e GitHub Environments limitados à `main`, provados
  por `GITHUB_ENVIRONMENT_PROOF.json`; nenhuma chave root no GitHub.

Detalhes de custódia e arquivos: [backup-resilience-setup.md](backup-resilience-setup.md).

## Rollout sem gap

0. Antes do merge, prove conta/chave dump-only + Environments `*-main`; sem isso,
   mantenha o workflow atual e o card aberto para não criar gap.
1. `install.sh stage` instala somente arquivos/users/units e mantém tudo OFF.
2. Após os GOs, configure credenciais e rode `install.sh preflight`.
3. `install.sh arm` cria somente o marker para execuções manuais, sem timer e
   mantém `OFFSITE_WRITER_ENABLED` ausente.
4. Rode manualmente duas cadeias `startap-backup-cycle.service` e os drills; o
   legado continua o único writer offsite.
5. Confirme generations `COMPLETE`, decrypt real, heartbeat, freshness e
   teardown; grave provas sanitizadas.
6. `install.sh activate` valida as provas e habilita producer/freshness/drill em
   shadow; uploader continua OFF e o legado continua único writer.
7. Para o cutover, habilite `BACKUP_RESILIENCE_PRODUCER_ENABLED=true` para o
   schedule legado pular, mantendo `workflow_dispatch` disponível; grave
   `LEGACY_WRITER_DISABLED_PROOF.json`.
8. Imediatamente rode `install.sh activate-uploader`, dispare um upload e valide
   `recovery-point.json` + `last-attempt.json`. Dois writers nunca coexistem.
9. Execute uma única vez `anchor-bootstrap` no environment protegido; depois
   habilite `BACKUP_RESILIENCE_DETECTOR_ENABLED=true` e valide ancestry/tuple.
10. O dispatch remoto do drill exige, adicionalmente, prova real registrada,
   marker local e environment GitHub `backup-recovery-main` protegido.

Nenhum passo reconecta `ALERTAS`, reinicia aplicação, ou toca dados/sessões de
clientes.

## Checagem operacional sanitizada

```bash
sudo systemctl status startap-backup-producer.timer --no-pager
sudo systemctl status startap-backup-upload.timer --no-pager
sudo systemctl status startap-backup-freshness.timer --no-pager
sudo systemctl status startap-backup-drill.timer --no-pager
sudo journalctl -u startap-backup-producer.service --since '-2 days' --no-pager
sudo jq '{state,local,offsite,alert_delivery_affects_validity}' \
  /var/lib/startap-backup-status/health.json
```

Não use `cat` em dump, identity, deploy key, recipients ou stderr privado do
uploader. Não publique paths de credential nem conteúdo SQL.

## Incidente

1. Preserve o workflow/run vermelho e o journal sanitizado.
2. Leia `health.json`: valide idade do **último backup válido**, não apenas o
   status da automação.
3. Se offsite falhou e local está `healthy`, declare `degraded`; não invalide o
   fallback.
4. Se local está `invalid`, não promova/copie manualmente a geração incompleta.
5. Autenticação ou host mismatch são terminais: não repita cegamente.
6. Não apague incoming, sealed, generations ou backup histórico na investigação.
7. Para provar recuperabilidade, siga o drill descartável do runbook de restore.

## Rollback

`rollback.sh begin` desliga primeiro uploader/marker e mantém generation local.
Então volte `BACKUP_RESILIENCE_PRODUCER_ENABLED=false`, prove um dispatch legado
que gerou `.sql.gz.age` e grave `LEGACY_MANUAL_ROLLBACK_PROOF.json`.
`rollback.sh complete` só então desliga producer/freshness/drill. Nenhuma etapa
remove scripts, credenciais, generations, relatórios ou backups offsite. Desligue
o detector novo com `BACKUP_RESILIENCE_DETECTOR_ENABLED=false`.

## Evidência histórica do incidente SCRUM-167

- run: `31466784443`, job `93701222801`, 11/08/2026;
- comando exato: `ssh-keyscan -p 22 187.77.242.220 >> ~/.ssh/known_hosts`;
- resultado: exit 1, sem banner após ~5 s; runner havia sido adquirido;
- dump/artefato: passo não iniciou, portanto nenhum plaintext ou parcial;
- alerta: job `93701256412` conectou por SSH e a API WAHA aceitou duas chamadas;
  entrega final não é demonstrável;
- próximo backup: `2026-08-12-071337.sql.gz.age`;
- RPO observado: **47 h 56 min 48 s** entre os backups offsite válidos de 10/08
  e 12/08.
