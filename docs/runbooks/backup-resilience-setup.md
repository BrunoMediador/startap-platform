# Setup controlado — SCRUM-167

Este documento prepara a mudança; ele **não autoriza** criar chaves, secrets ou
ativar units. Em 14/08/2026, GO A e GO B continuam pendentes.

## GO A — custódia age

Decisão proposta pelo ADR 0038:

- manter a identidade offline do Bruno fora do GitHub e da VPS;
- criar identidade de automação dedicada, guardada somente na VPS como
  `LoadCredential=` do validator/drill-prepare;
- cifrar backups futuros para exatamente dois recipients públicos;
- usar `RECIPIENT_SET_ID` opaco + epoch + count no manifest, nunca fingerprint;
- executar decrypt automatizado real e prova assistida periódica do Bruno.

O time não gera nem transporta a identidade até o Bruno aprovar esse modelo.

## GO B — deploy key offsite

- criar chave nova na VPS, sem reutilizar a chave atual;
- cadastrar a pública como deploy key write somente de `startap-backups`;
- manter a privada root:root 0400 e entregá-la somente via `LoadCredential=`;
- registrar attestation sanitizada com key ID opaco, escopo single-repository,
  `vps_only=true`, `reused_existing_key=false` e aprovação;
- pin de `github.com` validado por canal fora da execução, root:root 0644;
- nunca usar `ssh-keyscan` em runtime.

## Layout esperado

```text
/etc/startap-backup/
├── policy.conf                    root:root 0644 (sem segredo)
├── recipients.txt                 root:root 0644 (exatamente 2 públicos)
├── github_known_hosts             root:root 0644 (pin conferido)
├── deploy-key-attestation.json    root:root 0600
├── recipient-custody-attestation.json root:root 0600
├── GITHUB_ENVIRONMENT_PROOF.json root:root 0600 (capturado da API; nunca autogerado)
├── credentials/                   root:root 0700
│   ├── automation.agekey          root:root 0400
│   └── offsite_deploy_key         root:root 0400
├── APPROVED_GO_A                  JSON ligado ao set/epoch, após GO
├── APPROVED_GO_B                  JSON ligado ao key ID/repo, após GO
└── OFFSITE_WRITER_ENABLED         ausente até o cutover writer-único
```

Não use `/opt/automacoes/.env` (legado), não copie `.env` completo e não grave
secret em policy, journal ou diff.

## Pins versionados

- age v1.3.1, origem `FiloSottile/age`;
- archive Linux amd64 SHA-256
  `bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377`;
- binary age SHA-256
  `2e305637f2a0555305e21c17fb74446acbb39b53135d43d4b744e50c287133a5`;
- binary age-keygen SHA-256
  `c56ef69834e18ca4d3b953117f4481522c35fb6862a5d2871685aa4685893664`;
- PostgreSQL 16 digest documentado no runbook de restore;
- `actions/upload-artifact` pinado por SHA completo no workflow.

Atualizar qualquer pin exige PR e nova revisão de supply chain.

## Sequência

1. security aprova ADR/diff e o Bruno responde GO A/GO B.
2. **Antes do merge que troca o workflow legado**, crie a conta/chave
   dump-only e os três GitHub Environments abaixo. Enquanto isso não estiver
   provado, não faça merge: o fail-closed vermelho não deve abrir um gap no
   único writer atual.
3. Instale arquivos inertes com `install.sh stage`.
4. Configure os arquivos acima por canal seguro, sem colar valores no Jira.
5. Prepare checkout offsite com `install.sh prepare-offsite`.
6. Rode `install.sh preflight`; symlink/hardlink, parent mutável,
   owner/mode/path/binário ou placeholder divergente falha.
7. Use `install.sh arm` para abrir a janela manual, sem habilitar timers.
8. Siga o rollout de [backup-postgres.md](backup-postgres.md).
9. Após o primeiro artefato real, valide decrypt de automação e drill PG16.
10. Faça prova assistida Bruno do mesmo SHA offsite.
11. Somente depois habilite detector/cutover/dispatch conforme o runbook.

## GitHub Environments e ausência de chave root

Nenhum workflow de backup recebe `SSH_PRIVATE_KEY` nem login `root`. Remova os
secrets de backup do nível do repositório somente depois de copiá-los para o
Environment correto e validar um dispatch controlado:

| Environment | refs permitidas | secrets exclusivos |
|---|---|---|
| `backup-legacy-main` | somente `refs/heads/main` | `BACKUP_LEGACY_DUMP_SSH_KEY`, `BACKUP_REPO_SSH_KEY`, `BACKUP_AGE_PUBKEY` |
| `backup-status-main` | somente `refs/heads/main` | `BACKUP_STATUS_SSH_KEY`, `BACKUP_REPO_READONLY_SSH_KEY` |
| `backup-recovery-main` | somente `refs/heads/main` | os dois secrets read-only de status/repo |

A condição `github.ref` no YAML é só defesa em profundidade: uma branch pode
alterar seu próprio YAML. O controle real é a deployment branch policy do
Environment. Capture via API somente nomes de secrets/policies (nunca valores),
preencha `github-environment-proof.json.example` e instale como
`GITHUB_ENVIRONMENT_PROOF.json` root:root 0600. `install.sh` rejeita Environment
extra, ref diferente de `main`, segredo no nível do repositório ou chave root
remanescente. A prova deve ser refeita após qualquer mudança de policy.

## Usuário SSH legado dump-only

O workflow de transição usa `startap-backup-legacy-dump`, nunca root. A conta
tem shell `legacy-dump-shell.sh`; o `authorized_keys` usa exatamente
`legacy-dump-authorized_keys.example`. `SSH_ORIGINAL_COMMAND` deve ser apenas
`dump`. O wrapper chama via sudo somente
`legacy-dump-helper.sh` sem argumentos; container `automacoes-postgres-1`, banco
`startap_database`, role `startap_user`, PG16 e argumentos de `pg_dump` são
constantes root-owned. A conta não pertence a `docker`, não lê `.env`, não tem
PTY/forwarding e não executa comando arbitrário.

## Usuário SSH de status

Use uma chave exclusiva read/dispatch, sem shell geral. O `authorized_keys` deve forçar
`external-command.sh`, negar port/agent/X11 forwarding e PTY. O comando aceita
apenas `status` ou `drill`; `drill` ainda exige marker, sudoers exato e environment
GitHub protegido. Não reutilize SSH root/deploy.

A conta usa `/usr/local/libexec/startap-backup/ssh-shell.sh`, não `nologin`, para
ser compatível com a invocação `sshd -c`. Use exatamente o prefixo de
`status-authorized_keys.example`; owner `startap-backup-status`, diretório 0700 e
arquivo 0600. O integrador `tests/integration-sshd.sh` prova que comando arbitrário
não vira shell.

## Âncora externa

O detector usa chave **read-only** exclusiva para clonar `startap-backups`, baixa
o `anchor.json` do artifact anterior de `startap-platform`, exige que o commit
anterior seja ancestral do HEAD e confere a tuple
`commit_sha + manifest_sha/path + artifact_sha/path/size + run_id`, exige que o
manifest e o blob `.age` existam como paths literais exatos e modo Git `100644`
nos commits atual **e** anterior (symlink `120000`, executable `100755`, gitlink
`160000` e path estranho falham), e calcula SHA/tamanho a partir do próprio Git
object. Só depois publica o próximo
`backup-anchor` por 90 dias. Bootstrap é único, manual e protegido; ausência,
rewrite ou mismatch falham fechado. Não é assinatura/WORM: comprometimento
simultâneo da VPS e GitHub continua risco residual.

## Bridges e reconcilers de runtime

`startap-backup-cycle.service` permanece root sem capabilities e não atravessa
`/run/startap-backup-producer` 0700. O sysusers cria apenas o grupo
`startap-backup-bridge`; o producer publica `ready-run` 0640 em um subdiretório
producer:bridge 0750. O reconciler de plaintext é outra unit root, com
`CAP_DAC_OVERRIDE`/`CAP_FOWNER`, write paths restritos ao tmpfs/bridge/claims,
inode cap no runtime e recuperação da quarantine limitada a 512 operações por
ativação, sem acesso a generations, credentials ou Docker. A queue root:root
0700 é alimentada por rename atômico, nunca por cópia; o helper trabalha até
256 entradas sem recursão/seguir links e deixa residual explícito para a
ativação seguinte. Ele roda por
`.path` no startup e via `ExecStopPost`, inclusive após `SIGKILL`.

O reconciler Docker é também uma unit separada e habilitada no boot somente
depois de `install.sh arm`. Seu journal mínimo root:root 0600 fica no diretório
dedicado root:root 0700 `/var/lib/startap-backup/drill-journal`; não divide
permissões com fallback, generations nem o usuário do drill. O tuple é gravado
e sincronizado em disco **antes** do primeiro `docker ... create`; cada fase de
criação, restore e teardown substitui o journal por rename same-FS seguido de
`fsync` do arquivo e diretório. Assim, perda de `/run` durante reboot não apaga
a informação necessária para remover recursos persistentes do Docker. O input
decifrado e os arquivos de captura de `inspect` continuam separados em tmpfs.

Antes de remover, o reconciler exige nome e label
`tech.startap.backup-drill=<run_id>` exatos para container, volume e network;
qualquer conflito alheio é preservado e deixa o serviço vermelho. Apenas
not-found exato é tratado como ausência; erro/timeout de inspect retém o
journal, não publica sucesso e mantém stderr fora do systemd journal. Se o
journal persistente estiver ausente mas o inventário read-only encontrar algum
recurso com a label reservada, a unit falha fechado e **não remove nada**: não
há scan destrutivo amplo nem tentativa de adivinhar o tuple. Symlinks quebrados
nos markers/journal são destacados sem seguir o alvo; a limpeza limitada dos
runtime dirs libera o slot e preserva qualquer alvo externo.
