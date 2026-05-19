# Runbook: Migração das tabelas legadas de pausa

**Criado:** 2026-05-19
**Autor:** dev-back
**Status:** PLANO (não executado)

---

## Tabelas legadas identificadas

| Tabela | Coluna-chave | Uso em código | Migrado para flow_pauses? |
|---|---|---|---|
| `pause_ricardo` | `numero` | `apps/api/src/bots/teste_vendas.ts` (PAUSE_TABLE), `registry.ts`, `server.ts` | Sim — migration 008 copiou dados ativos |
| `pause_startap` | `numero` | `apps/api/src/bots/startap.ts` (PAUSE_TABLE), `painel-admin/server.js:301,327,1917` | Sim — migration 008 copiou dados ativos |
| `pausa_cirilo` | `numero` | `apps/api/src/server.ts:33` (legacyPauseTable), `apps/api/src/bots/teste_barbearia.ts` (comentado: `pauseTable: null`) | Sim — migration 008 copiou dados ativos |
| `pausa_samuel` | `numero` | `packages/db/src/queries/pausa.ts` (whitelist) | Nao — bot samuel usa diretamente |
| `pausa_samuel_dev` | `numero` | `packages/db/src/queries/pausa.ts` (whitelist) | Nao — ambiente de dev |
| `pausa` (legacy) | `chat_id` | `packages/db/src/queries/pausa.ts` (whitelist) | Nao — sem referencia ativa encontrada |

---

## Sistema moderno: flow_pauses

`flow_pauses` (migration 008) é a tabela canônica:
- Campos: `flow_id`, `telefone`, `active`, `source`, `reason`, `updated_at`
- Usada pelo worker antibot, bots TS, e pelo painel (aba Pausa)
- `pausa_cirilo` e `pause_ricardo` já foram copiadas para flow_pauses via migration 008

---

## Leitores ativos por tabela (grep em 2026-05-19)

- `pause_startap`: lida ativamente por `startap.ts` (PAUSE_TABLE), `router.ts`, `painel-admin/server.js`
- `pause_ricardo`: lida ativamente por `teste_vendas.ts` (PAUSE_TABLE), `server.ts` (legacyPauseTable)
- `pausa_cirilo`: referenciada como `legacyPauseTable: 'pausa_cirilo'` em `server.ts:33` mas o bot definiu `pauseTable: null` indicando que o router TS ja nao usa mais
- `pausa_samuel` / `pausa_samuel_dev`: usadas diretamente pelo bot samuel (nao migrado para flow_pauses)

---

## Criterio para DROP

Uma tabela so pode ser removida quando:

1. Nenhum codigo em `apps/`, `packages/`, `painel-admin/` referencia o nome da tabela (grep limpo)
2. Dados copiados para `flow_pauses` ou arquivados em tabela `_archive` equivalente
3. Backup do banco em repo privado com dump incluindo a tabela antes do DROP
4. Monitoramento de 30 dias sem leitura/escrita confirmado (verificar via `pg_stat_user_tables.n_tup_ins + n_tup_upd + n_tup_del`)
5. Bruno aprova apos ver criterios 1-4 atendidos

---

## Plano de execucao (futuro, pos-aprovacao)

### Fase 1 — Remover referencias de codigo (PR separado)

Para `pausa_cirilo`:
- Remover `legacyPauseTable: 'pausa_cirilo'` de `apps/api/src/server.ts:33`
- Confirmar que `teste_barbearia.ts` ja tem `pauseTable: null`

Para `pause_ricardo`:
- Migrar `PAUSE_TABLE = 'pause_ricardo'` em `teste_vendas.ts` para usar `flow_pauses`
- Remover `legacyPauseTable: 'pause_ricardo'` de `server.ts`

Para `pause_startap`:
- Migrar `PAUSE_TABLE = 'pause_startap'` em `startap.ts` para usar `flow_pauses`
- Remover referencias em `painel-admin/server.js:301,327,1917`

### Fase 2 — Arquivamento (migration, nao DROP)

```sql
-- Executar APENAS apos Fase 1 mergeada e validada em producao
CREATE TABLE IF NOT EXISTS pause_ricardo_archive AS SELECT * FROM pause_ricardo;
CREATE TABLE IF NOT EXISTS pausa_cirilo_archive AS SELECT * FROM pausa_cirilo;
CREATE TABLE IF NOT EXISTS pause_startap_archive AS SELECT * FROM pause_startap;
```

### Fase 3 — DROP (somente com aprovacao explicita do Bruno)

```sql
-- NAO EXECUTAR sem aprovacao explicita do Bruno
-- Confirmar antes: SELECT * FROM pg_stat_user_tables WHERE relname IN ('pause_ricardo','pausa_cirilo','pause_startap');
DROP TABLE IF EXISTS pause_ricardo;
DROP TABLE IF EXISTS pausa_cirilo;
DROP TABLE IF EXISTS pause_startap;
```

---

## Nota sobre pausa_samuel / pausa_samuel_dev

Estas tabelas continuam em uso ativo pelo bot Samuel. Nao estao no escopo desta migracao.
A migracao futura do Samuel para `flow_pauses` e missao separada.
