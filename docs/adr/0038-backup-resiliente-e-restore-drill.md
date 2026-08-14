# ADR 0038 — Backup resiliente e restore drill

- Status: Proposto
- Card: SCRUM-167
- Escopo: geração, custódia, cópia offsite, freshness e restore drill

## Contexto

O backup do PostgreSQL depende hoje de uma execução iniciada pelo GitHub Actions, misturando plano de controle externo e geração da cópia primária.
No run `31466784443`, o runner foi adquirido, mas o `ssh-keyscan` da VPS não recebeu banner em cinco segundos: TCP/22 não chegou ao `sshd`, e o gap/RPO efetivo atingiu `47h56m48s`.

GitHub, Internet e alcance externo da porta 22 formam um único caminho crítico; quando ele falha, alertar não cria o backup ausente.
O desenho precisa separar geração local, validação, redundância offsite, fiscalização externa e prova de restauração.

Os objetivos são:

- gerar localmente sem depender de GitHub/TCP/22 e sem dar root ou Docker ao producer;
- nunca promover artefato incompleto, não cifrado, corrupto ou cuja validação possa sofrer TOCTOU;
- tentar redundância offsite sem torná-la pré-condição da recuperação local;
- provar restauração em PostgreSQL 16 sem tocar recursos produtivos;
- manter cutover e rollback reversíveis, com um único writer offsite por vez.

O código corretivo materializa os componentes desta decisão, mas isso não prova instalação, execução real, RPO, RTO ou operação em produção.
O escopo não inclui retenção, pruning, exclusão histórica nem remoção de backups; essas ações exigem decisão posterior.

## Decisão

### 1. Adotar o modelo C com fronteiras de privilégio explícitas

`startap-backup-producer.timer` iniciará o ciclo na VPS sem GitHub, Internet ou TCP/22.
O ciclo será não concorrente, fail-closed e observável; cada unit terá somente os paths, grupos e credenciais necessários.

As fronteiras materializadas são:

- `startap-backup-producer`, não-root e sem rede, recebe apenas recipients públicos e não acessa Docker, env produtivo, banco ou identities;
- `startap-backup-dump.path` aciona `startap-backup-dump.service` root, único autorizado a executar o comando Docker/`pg_dump` fixo;
- sealer e promoter root-owned alteram custódia e promovem artefatos, sem identity, deploy key ou acesso arbitrário ao Docker;
- validator não-root recebe somente `automation.agekey` por `LoadCredential=`, lê o sealed, grava attestation externa e não tem rede;
- uploader recebe somente a deploy key offsite por `LoadCredential=`, sem identity, banco, env produtivo ou Docker;
- orchestrators root apenas ordenam units/helpers fixos; não recebem secrets e não expõem shell ou Docker socket aos usuários de serviço.

Nenhum usuário será incluído no grupo `docker`; os usuários não-root serão contas de sistema sem login.
Nenhum processo combinará acesso ao dump/banco, identity privada e capacidade de upload.

### 2. Encadear dump, seal, attestation e promoção sem TOCTOU

O pipeline local seguirá esta ordem:

1. o producer cria uma requisição restrita; a `.path` ativa o dump-helper root sem argumentos livres;
2. o helper cria FIFO root-owned em `/run/startap-backup-producer`, executa o `pg_dump` fixo e grava `DUMP_OK` somente após sucesso integral;
3. o producer consome a FIFO com limite de tamanho, exige `DUMP_OK`, comprime, cifra para os recipients públicos e cria manifest/checksum;
4. o producer publica apenas o diretório completo em `/var/lib/startap-backup/incoming/<run>.incoming`;
5. após o producer terminar, o sealer rejeita links, entries, owners, modos ou filesystem inesperados e move o conjunto para `sealed`, root-owned e read-only;
6. após o sealer, o validator lê o sealed imutável, faz decrypt/gzip/marcadores e grava attestation em `/var/lib/startap-backup-attestations`, fora do objeto validado;
7. após o validator terminar, o promoter confere metadata, rehash do ciphertext/manifest e vínculo exato da attestation antes de mover a geração;
8. o promoter publica em `generations/<run>` e grava `COMPLETE` por último; uploader, health e drill ignoram toda geração sem marker válido.

Markers de request/cleanup são não confiáveis até o helper root reclamar atomicamente sua entry em diretório root-only, antes de ler ou fazer `stat`.
Marker malformado, symlink, hardlink, owner/mode/nlink inesperado será quarantined/consumido sem seguir o alvo nem rearmar a `.path`; `DUMP_OK` só será criado pelo helper root após sucesso.
As units `.path` e services terão `TriggerLimitIntervalSec`/`TriggerLimitBurst` e `StartLimit*` explícitos para limitar retrigger e DoS.
A máquina persistida é `incoming → sealing → sealed → validated → complete → final`.
Cada transição será idempotente e retomável em todo kill boundary, convergindo para o mesmo run/ciphertext ou quarantine segura, sem pular estado, sobrescrever `final` ou publicar `COMPLETE` prematuro.

O drill lê a geração canônica root-owned; nenhuma cópia mutável intermediária vira nova fonte de verdade.
Uma falha antes de `COMPLETE` deixa somente staging recuperável/diagnosticável e não substitui a última geração válida.

Plaintext trafega pela FIFO ou por tmpfs em `/run/startap-backup-*`, com diretório `0700`, arquivo `0600`, `umask 077` e capacidade explícita.
Units que tocam plaintext terão `MemorySwapMax=0`, `LimitCORE=0` e traps para `EXIT`, `INT` e `TERM`.
Plaintext e secrets nunca irão em env, argv, `set -x`, journal ou artefato; não há promessa de secure delete de RAM/tmpfs.

Cada unit limpa somente os temporários de que é owner; cleanup root separado remove bridges/FIFOs órfãos após a unit consumidora parar.
Falha de cleanup é reportada separadamente, não apaga geração válida e não transforma validação ou drill inválido em sucesso.
O fallback final mantém diretório root-owned `0700` e arquivos cifrados/markers `0600` ou mais restritos.

### 3. Limitar upload, retry e SSH

Após `COMPLETE`, o uploader enviará ao `startap-backups` somente ciphertext, manifest, checksums e markers não secretos.
A deploy key será nova, VPS-only, single-repo e entregue exclusivamente ao uploader via `LoadCredential=`.
Push forçado é proibido; non-fast-forward, rewrite, destino remoto ou ancestry inesperados falham fechado.

**GO B — offsite:** gerar/instalar a deploy key e habilitar escrita real exigem GO explícito de Bruno e review de security, separados do GO A.

Retry terá no máximo quatro tentativas totais, conexão de dez segundos e timeout de transferência de quinze minutos por tentativa.
O backoff será exponencial limitado, em 5, 10 e 20 segundos, com jitter aleatório de 0 a 3 segundos e teto de 30 segundos.
Só rede, timeout, HTTP 429 ou HTTP 5xx são transitórios.
Auth/autorização, host key mismatch, config, destino inseguro, `age`, checksum e corrupção terminam imediatamente, sem retry.

`known_hosts` será root-owned e pinado fora de banda.
SSH usará `BatchMode=yes`, `IdentitiesOnly=yes`, `StrictHostKeyChecking=yes` e `UserKnownHostsFile` explícito.
Nenhuma chave privada, conteúdo restaurado ou comando arbitrário irá para repositório, log ou runner.

### 4. Usar detector e âncora externos à credencial do writer

O workflow detector clonará `startap-backups` com credencial separada e read-only; nunca receberá deploy key de escrita nem identity `age`.
Ele recuperará `anchor.json` do artifact `backup-anchor` do run anterior no repositório `startap-platform`.
Ausência da âncora anterior, salvo bootstrap manual revisado, impedirá estado `healthy`.

Para cada recovery point, o detector verificará:

- que o commit anterior ainda existe e é ancestral do commit atual;
- que o blob `.age` real indicado pelo manifest existe naquele commit e seu SHA-256 e tamanho coincidem;
- que run, commit, path, manifest SHA, blob SHA/tamanho e timestamps formam a mesma tuple no status local, recovery point offsite e clone read-only;
- que o run não regrediu e que a mesma geração não mudou de tuple;
- que o artifact seguinte ancora o commit e manifest atuais para a próxima comparação.

Essa cadeia é independente da credencial VPS-only do writer e detecta rewrite entre observações sem serviço pago ou comunicação outward.
Ela ainda compartilha GitHub como provedor e não impede um writer autorizado de criar, em fast-forward, novo SQL malicioso cifrado para recipients públicos.
Checksum prova integridade acidental, não autenticidade; isolamento do restore, comparação do recovery point e review de autoria permanecem necessários.

### 5. Separar detector externo e scheduler local do drill

`startap-backup-drill.timer` é o scheduler primário do restore drill; indisponibilidade do GitHub não cancela a agenda local.
GitHub atua como detector externo e oferece `workflow_dispatch` opcional, nunca como scheduler único.
O dispatch usa uma shell de forced-command allowlisted, limitada a `status` e `drill`, sem shell interativo ou parâmetros arbitrários.
O runner recebe somente JSON sanitizado; não recebe identity `age`, plaintext, dump ou acesso Docker.
GitHub nunca receberá chave SSH de `root`; legado, status e drill usarão identities distintas, não-root e limitadas ao forced-command mínimo.

`GITHUB_TOKEN` terá permissões mínimas por job; Actions serão pinadas por SHA completo.
Secrets de status e clone read-only existirão somente em GitHub Environments externos ao YAML, com deployment branch policy restrita à `main`.
Como YAML não prova essa policy, security deverá verificá-la pela API/UI do GitHub e anexar evidência antes de habilitar workflow real.
Versão, origem e checksum de `age`, e `postgres:16` por digest, serão pinados; toda atualização exige review.
Observabilidade e alertas ficam em GitHub/journal e canais aprovados, nunca WhatsApp.

### 6. Classificar saúde por recovery point, não por tentativa

Freshness parte do término do último recovery point válido, promovido e verificável, com RPO e tolerância versionados.
`local.last_attempt` registra run, `started_at`, `finished_at`, estado e erro da tentativa local mais recente, separado de `local.recovery_point`; o offsite mantém separação equivalente.
Nenhum `last_attempt` substitui, apaga ou refresca o recovery point.
Uma tentativa falha não apaga a última geração válida; deixa o sistema no mínimo `degraded` até novo sucesso e o age continua aumentando.

| Local | Offsite | Estado global | Significado |
|---|---|---|---|
| fresco e válido | fresco e válido | `healthy` | duas cópias atuais e verificadas, sem tentativa posterior falha |
| fresco e válido | stale, invalid ou none | `degraded` | recuperação local possível, redundância comprometida |
| stale, invalid ou none | fresco e válido | `degraded` | offsite recuperável, operação local comprometida |
| válido vencido | válido vencido ou none | `stale` | há cópia restaurável, mas RPO foi excedido |
| invalid | invalid ou none | `invalid` | existe artefato, mas nenhuma cópia utilizável foi provada |
| none | none | `none` | nenhuma cópia foi encontrada |

Com uma fonte fresca e outra inválida, prevalece `degraded`; uma fonte válida vencida prevalece sobre `invalid`/`none`.
O fallback local não cobre perda total, corrupção física ou comprometimento integral da VPS; `healthy` exige offsite fresco e âncora válida.
Perda da identity de automação força `degraded`, embora a chave offline de Bruno ainda permita recuperação assistida.

### 7. Executar restore drill PG16 com decrypt e Docker separados

O decrypt roda como `startap-backup-validator`, sem rede/Docker, lendo `generations/<run>/COMPLETE` e a geração root-owned em modo read-only.
Ele entrega plaintext apenas no bridge tmpfs `/run/startap-backup-drill`, com cap, marker e ownership definidos.
Depois que a unit de decrypt para, o restore-helper root recebe somente esse input; não vê identity, env/banco produtivo, attestation ou geração cifrada.

O helper aceita comandos fixos e `postgres:16@sha256:<digest-aprovado>`.
Container, volume e rede terão nomes únicos por run e labels de ownership; nenhum volume, env, porta, path ou destino produtivo será reutilizado.
O destino é construído internamente e validado por allowlist/nome/labels; ambiguidade falha fechado.

O banco será novo e vazio; todo `psql` usará `-v ON_ERROR_STOP=1`.
O drill instalará extensões reais e verificará `schema_migrations`, schemas, tabelas críticas, PKs, FKs, índices e invariantes sanitizados.
Nenhum dado, métrica ou amostra com PII será publicado.

RTO end-to-end começa antes da seleção/decrypt da geração e termina somente após validações e teardown verificado.
O resultado separa restore, validações e cleanup; teardown incompleto faz o drill falhar.
Traps para `EXIT`, `INT` e `TERM` removem apenas recursos efêmeros cujo nome e labels provem ownership, preservando a origem.

### 8. Manter custódia `age` por epochs

Bruno permanece recipient offline e custodiante final; a automação terá identity dedicada como segundo recipient.
O caminho materializado será `/etc/startap-backup/credentials/automation.agekey`, em diretório root-owned `0700` e arquivo `0400`.
A mudança frente ao path antes proposto em `/etc/startap-backup/identities/` exige aceite explícito de security ou migração antes do GO A.
Somente preflight, validator e drill-prepare recebem a identity via `LoadCredential=`; ela nunca entra em GitHub, uploader, Docker, env, argv, log ou artefato.

O manifest contém `recipient_set_id` opaco, epoch e `recipient_count=2`; esses campos e stanzas não provam recipients.
Decrypt com a identity de automação prova um recipient; exercício assistido de Bruno, fora da VPS/GitHub, prova o recipient offline.
Nenhuma fingerprint de recipient será registrada no journal.

Comprometimento persistente de root pode exfiltrar a identity e os backups acessíveis daquela epoch.
Perda da identity deixa o sistema `degraded`; a chave offline de Bruno permite recovery e inicia rotação.
Mudança de recipients abre nova epoch; backups antigos não mudam retroativamente e dependem das identities anteriores.

**GO A — custódia/decrypt:** nenhum keygen, secret, segundo recipient ou full decrypt real será habilitado sem GO explícito de Bruno e review de security.
Até o GO A, testes usam fixtures e identities descartáveis; full decrypt real permanece desabilitado e fail-closed.

### 9. Rollout, cutover e rollback

1. manter units, helpers e workflow desabilitados para dados reais e exercitar fixtures;
2. instalar sem habilitar timers, conferir owners, modos, pins e separação de credenciais;
3. manter o workflow legado como único writer offsite durante shadow; o uploader novo fica OFF;
4. obter GO A e provar decrypt/restore real controlado sem habilitar agenda;
5. obter GO B e preparar deploy key/repositório sem iniciar segundo writer;
6. no cutover, desabilitar primeiro a agenda/writer legado e só depois habilitar o uploader novo;
7. executar geração/drill controlados, registrar RPO/RTO/teardown e observar duas janelas antes de concluir.

O workflow legado permanece disponível, mas desabilitado, como rollback; nunca haverá dois writers offsite concorrentes.
Rollback desabilita primeiro o uploader novo e só então reabilita o writer legado ou dispatch manual.
Geração local pode continuar; backups, manifests, markers, anchors, keys e evidências serão preservados.
Nenhuma identity será removida sem inventário por epoch; nenhum artifact legado será migrado ou excluído neste card.

## Consequências

### Positivas

- geração e drill locais saem do failure domain GitHub → Internet → TCP/22;
- menor privilégio separa dump, cifra, validação, promoção, upload e Docker;
- seal root-owned, attestation externa, rehash e `COMPLETE` final reduzem TOCTOU;
- recovery point externo e drill PG16 tornam RPO, rewrite e RTO verificáveis.

### Negativas e riscos aceitos

- timer, banco e fallback local ainda compartilham a VPS; perda total exige offsite;
- identity de automação amplia impacto de root comprometido e requer rotação por epoch;
- âncora não autentica novo commit malicioso em fast-forward e depende do GitHub como provedor;
- operação passa a manter várias units, service users, artifacts e pins;
- drill consome CPU/disco e precisa de limites para não prejudicar produção;
- sem retention, armazenamento continuará crescendo até decisão posterior.

### Observabilidade

Journal e status expõem run id, timestamps, tamanho, etapa, erro e manifest digest, sem PII ou fingerprints.
Painéis/checks distinguem `last_attempt`, recovery point, local/offsite, identity, anchor, RPO, RTO e teardown.
Falha de alerta não altera validade do backup; nenhuma notificação usa WhatsApp.

## Alternativas consideradas

### Modelo A — runner gera

Rejeitado: mantém GitHub crítico, expõe banco/dados ao executor externo e amplia o domínio de secrets.

### Modelo B — runner ordena remoto

Rejeitado: conserva exatamente o gatilho GitHub → TCP/22 que falhou; retry não cria disparo local.

### Modelo C — `systemd` local

Escolhido: gera, valida e agenda drill localmente, tenta offsite e permite fiscalização externa e rollback simples.

### Modelo D — self-hosted runner

Rejeitado agora: acopla supply chain ao GitHub, equivale a ampliar privilégio na VPS ou exige outro host.

## Critérios de aceitação

- **S1:** provar producer não-root sem DB/Docker/identity/rede; dump-helper root fixo via `.path`; validator, uploader e Docker-helper com credenciais mutuamente exclusivas e sem grupo `docker`;
- **S2:** provar FIFO/tmpfs com cap, `0700/0600`, no swap/core/env/argv/xtrace/journal e traps inter-unit, sem promessa de secure delete;
- **S3:** matar/reiniciar em cada boundary `incoming/sealing/sealed/validated/complete/final` e provar retomada idempotente, attestation externa, rehash, `COMPLETE` final e rejeição de incompletos/mutação;
- **S4:** provar deploy key VPS-only/single-repo via `LoadCredential`, `known_hosts` pinado, SSH estrito, sem force e com non-fast-forward/rewrite fail-closed, após GO B;
- **S5:** provar timer local e GitHub só detector/dispatch forced-command, sem key root/identity no runner; auditar Environments, Secrets e branch policy `main` fora do YAML;
- **S6:** provar âncora anterior, ancestry, manifest e blob `.age` real com SHA/tamanho e tuple local/offsite/clone, documentando checksum sem autenticidade e risco residual;
- **S7:** provar pins de origem/versão/checksum do `age`, digest PG16 e SHA de Actions, com processo de update revisado;
- **S8:** provar `recipient_set_id` opaco/count 2, decrypt de automação, exercício assistido de Bruno, ausência de fingerprints, epochs, custódia `0700/0400` e aceite/migração do path da identity;
- markers são reclamados por root antes da leitura; malformed/link/owner/mode/nlink inválido entra em quarantine sem retrigger, e `.path`/service respeitam rate limits;
- interrupção em FIFO, dump, seal, validator, promoter ou cleanup não perde o último recovery point e retoma sem colisão;
- matriz cobre `healthy/degraded/stale/invalid/none`; `local.last_attempt` traz timestamps e nunca altera recovery point/freshness;
- drill demonstra destino fail-closed, banco vazio, PG16 real, `ON_ERROR_STOP`, extensões, migrations, tabelas, PK/FK/índices e invariantes sanitizados;
- RTO cobre seleção, decrypt, restore, validações e teardown; cleanup incompleto impede sucesso e preserva origins;
- shadow/cutover/rollback comprovam writer único e preservação de legacy, backups, keys, anchors e evidências;
- GO A e GO B ficam registrados separadamente antes de secrets, full decrypt ou escrita real; até lá, somente fixtures são autorizadas;
- security e QA executam/revisam as evidências; materialização de arquivos, sozinha, não satisfaz estes critérios nem encerra o card.

## Status

**Proposto.**

O modelo C e a implementação corretiva estão documentados, mas os GOs A/B e as provas reais de aceitação permanecem pendentes.
