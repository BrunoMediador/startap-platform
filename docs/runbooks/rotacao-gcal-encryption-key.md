# Runbook — Rotação da GCAL_ENCRYPTION_KEY

> **Gate de segurança AC5 do ADR 0024.** Esta chave protege as credenciais
> Google (Service Account JSON) dos clientes PAGANTES — hoje **Cirilo** e
> **Samuel**. Errar aqui = bot perde acesso à agenda e para de agendar.
>
> **Execução é GATED pelo Bruno.** O mecanismo (código + script) já está no
> repo; este runbook é o procedimento manual que SÓ o Bruno dispara, validando
> cada passo. NÃO rode `--apply` sem ter feito o `--dry-run` e confirmado a
> contagem.

## Quando rotacionar

- Suspeita ou confirmação de vazamento da chave atual (incidente de segurança).
- Rotação preventiva periódica (boa prática).
- Antes de provisionar o 1º estabelecimento novo, se o security exigir (AC5).

## Conceito

O segredo armazenado tem prefixo de versão:

| Prefixo | Cifrado com | Decifrado com |
|---|---|---|
| `enc:v2:` | `GCAL_ENCRYPTION_KEY` (atual) | `GCAL_ENCRYPTION_KEY` |
| `enc:v1:` | chave legada | `GCAL_ENCRYPTION_KEY_OLD` se definida, senão `GCAL_ENCRYPTION_KEY` |
| (sem `enc:`) | — (texto claro legado) | devolvido como está |

> **Estado de HOJE:** tudo é `enc:v1`, cifrado com `GCAL_ENCRYPTION_KEY`, e
> `GCAL_ENCRYPTION_KEY_OLD` NÃO existe. Nesse estado, `enc:v1` decifra com
> `GCAL_ENCRYPTION_KEY` — comportamento idêntico ao anterior. Nada quebra só
> por colocar este código em produção.

A rotação real funciona com uma **janela de coexistência**: a chave nova vira
`GCAL_ENCRYPTION_KEY`, a antiga vira `GCAL_ENCRYPTION_KEY_OLD`, e o script
re-cifra `enc:v1` → `enc:v2`. No fim, remove-se a `OLD`.

---

## Procedimento

### Passo 0 — Pré-checagem

```sql
-- Quantas credenciais existem e em que versão estão:
SELECT 'flow_clones' AS t,
       COUNT(*) FILTER (WHERE gcal_credentials_json LIKE 'enc:v1:%') AS v1,
       COUNT(*) FILTER (WHERE gcal_credentials_json LIKE 'enc:v2:%') AS v2,
       COUNT(*) FILTER (WHERE gcal_credentials_json IS NOT NULL
                          AND gcal_credentials_json NOT LIKE 'enc:%') AS claro
  FROM flow_clones
UNION ALL
SELECT 'bot_config',
       COUNT(*) FILTER (WHERE gcal_credentials_json LIKE 'enc:v1:%'),
       COUNT(*) FILTER (WHERE gcal_credentials_json LIKE 'enc:v2:%'),
       COUNT(*) FILTER (WHERE gcal_credentials_json IS NOT NULL
                          AND gcal_credentials_json NOT LIKE 'enc:%')
  FROM bot_config;
```

Anote os números (antes). Se houver linhas em texto claro (`claro > 0`), rode
antes `scripts/encrypt-existing-gcal.ts` (cifra plaintext → `enc:v2`). A
rotação só lida com `enc:v1`.

### Passo 1 — Gerar a chave nova

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Guarde como `K_new`. A chave atual em produção é `K_old`.

### Passo 2 — Provisionar AS DUAS chaves ANTES do deploy

> ⚠️ **Lição do incidente #247** (env obrigatória ausente = crash loop):
> as variáveis precisam estar em prod **antes** do deploy do código que as usa.

No `.env` de **api**, **worker** e **painel-admin** (todos os serviços que
cifram/decifram gcal):

```
GCAL_ENCRYPTION_KEY=<K_new>
GCAL_ENCRYPTION_KEY_OLD=<K_old>
```

Confirme que `K_new` e `K_old` têm 64 chars hex cada. (O boot valida 32 bytes;
chave errada = serviço não sobe.)

### Passo 3 — Deploy do código com as chaves já no ambiente

Deploy normal (merge → CI → deploy). Após subir:

- A partir daqui, qualquer credencial SALVA de novo nasce `enc:v2` (`K_new`).
- Credenciais antigas seguem `enc:v1` e são decifradas com `K_old` (a `OLD`).
- Bots continuam funcionando — janela de coexistência ativa.

Smoke rápido: bots WORKING, sem erro `falha na descriptografia` nos logs.

### Passo 4 — Dry-run (NÃO escreve)

```bash
# dentro do container da api (ou onde @startap/db resolve as envs de prod)
npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/rotate-gcal-key.ts
```

Confira no log a contagem "re-cifraria N linha(s)" por tabela. Deve bater com
os `v1` do Passo 0. Nada foi escrito.

### Passo 5 — Apply (re-cifra de fato)

```bash
npx tsx --tsconfig scripts/tsconfig.scripts.json scripts/rotate-gcal-key.ts --apply
```

O script é idempotente: pula o que já é `enc:v2`, só toca `enc:v1`, e ao fim
verifica que sobraram 0 `enc:v1` (aborta com erro se sobrar). Sem downtime —
são `UPDATE`s parametrizados por linha.

### Passo 6 — Validar

```sql
-- Deve dar 0 nas duas:
SELECT COUNT(*) FROM flow_clones WHERE gcal_credentials_json LIKE 'enc:v1:%';
SELECT COUNT(*) FROM bot_config  WHERE gcal_credentials_json LIKE 'enc:v1:%';
```

Validação funcional (obrigatória antes de remover a OLD):

- Bots **WORKING** (Cirilo e Samuel).
- **Agendamento real** funcionando: criar/consultar um evento de teste pela
  agenda do Cirilo e do Samuel (ou confirmar último evento recente no GCal).
- Sem erro `falha na descriptografia` nos logs de api/worker/painel.

### Passo 7 — Remover a chave antiga (só após validar)

Remova `GCAL_ENCRYPTION_KEY_OLD` do `.env` dos três serviços e re-deploy
(ou restart). Como não há mais `enc:v1`, a `OLD` não é mais usada. Mantê-la
não causa erro, mas mantê-la viva amplia a superfície de exposição da chave
antiga — remover é o correto.

---

## Rollback

A rotação é re-cifragem em cima das MESMAS linhas; o rollback depende de onde
parou:

- **Antes do Passo 5 (--apply):** nada foi escrito. Reverter = remover as envs
  novas e voltar o deploy anterior. Zero impacto.
- **Durante/depois do --apply, com a janela ainda aberta** (`K_old` ainda em
  `GCAL_ENCRYPTION_KEY_OLD`): linhas já em `enc:v2` decifram com `K_new`; as
  ainda em `enc:v1` decifram com `K_old`. O sistema funciona em estado misto —
  re-rodar `--apply` é seguro (idempotente) e termina a transição. Não é
  necessário "desfazer".
- **Se precisar voltar tudo para a chave antiga:** mantenha `K_old` definida,
  rode o caminho inverso manualmente (não há `--rollback` automático — peça ao
  backend-senior um script espelho se o cenário aparecer). Como a `K_old` ainda
  decifra os `enc:v2`? Não decifra: `enc:v2` só abre com `K_new`. Por isso
  **NÃO remova `K_new` enquanto existir qualquer `enc:v2`**. A regra de ouro do
  rollback: enquanto houver `enc:v2`, `GCAL_ENCRYPTION_KEY=K_new` deve
  permanecer.

> **Backup antes do --apply:** ter um `pg_dump` recente (ou snapshot das colunas
> `flow_clones.gcal_credentials_json` e `bot_config.gcal_credentials_json`) é a
> rede de segurança real. Tirar o snapshot é parte do Passo 4.

---

## Nota LGPD / ANPD

- A `GCAL_ENCRYPTION_KEY` protege credencial de acesso a dados pessoais (agenda
  dos clientes finais via Service Account). Tratá-la como segredo crítico.
- **Rotação preventiva NÃO é incidente** — não dispara notificação.
- **Em vazamento REAL da chave** (ou suspeita fundada):
  1. Rotacionar a chave (este runbook) **não basta** — quem teve a chave antiga
     pode ter decifrado a credencial Google. É preciso **revogar e reemitir a
     Service Account no Google Cloud** (gerar nova chave da SA, atualizar o JSON
     do clone, invalidar a antiga). Chave nova de cifragem não revoga acesso já
     vazado.
  2. Avaliar **gatilho de notificação à ANPD e aos titulares** (Lei 13.709,
     art. 48): se o vazamento puder gerar risco/dano relevante aos titulares,
     notificar em prazo razoável. Acionar o `juridico-lgpd` (via PM) para a
     decisão e o texto da comunicação.
  3. Registrar o incidente (postmortem) com escopo, dados potencialmente
     expostos, e ações tomadas.

---

## Referências

- Mecanismo: `packages/core/src/crypto.ts` (versionamento de chave por prefixo)
- Espelho do painel: `painel-admin/server.js` (bloco "Criptografia AES-256-GCM")
- Script: `scripts/rotate-gcal-key.ts` (dry-run/apply, idempotente)
- Migração de texto claro: `scripts/encrypt-existing-gcal.ts`
- ADR 0024 (estabelecimento / gate de segurança, AC5)
