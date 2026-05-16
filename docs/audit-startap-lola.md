# Auditoria: duplicata `startap` vs `startap-ai-lola` em prod

**Data:** 2026-05-16
**Origem:** PR-V1 da MISSAO_VIAGEM (FASE 1)
**Status:** investigação concluída — recomendação para Bruno aprovar migration 015

## Achado

Produção (`gestao.startap.tech`) tem **8 rows em `bot_config`**, das quais **4 são legadas e nunca chamadas** nos últimos 30 dias:

| slot | display_name | provider | calls/30d | status |
|---|---|---|---:|---|
| `barbearia-cirilo` | Cirilo (Barbearia) | openai | **0** | legado |
| `elenildo-ricardo` | Ricardo (Curso Barbeiro) | openai | **0** | legado |
| `startap-ai-lola` | Lola (Prospecção Startap) | deepseek | **0** | legado |
| `startap-ai-samuel` | Samuel Admin (pausa) | openai | **0** | legado |
| `teste_barbearia` | Teste — Barbearia | openai | 7 | **ativo** |
| `teste_vendas` | Teste — Vendas (curso) | openai | 1 | **ativo** |
| `teste_vendas_barbearia` | Teste — Vendas + Barbearia | openai | 47 | **ativo** |
| `startap` | Startap — Prospecção (Lola) | deepseek | 3 | **ativo** |

Confirmado via `GET /api/bots` e `GET /api/usage/summary?days=30` na prod.

## Resposta direta

Os 8 itens do print não são 8 bots reais. São **4 bots ativos + 4 linhas órfãs** que ficaram para trás depois que a migration 003 renomeou/consolidou os slots em maio. As órfãs nunca foram apagadas porque a migration 002 acabou re-inserindo o seed legado em algum momento posterior (provavelmente execução manual após o runner já ter aplicado 003).

A duplicata específica perguntada — `startap` vs `startap-ai-lola` — é exatamente isso:
- `startap-ai-lola` é o **slot original** (migration 002).
- `startap` é o **slot consolidado** (migration 003, com identidade Lola/Prospecção mantida).
- Ambos coexistem em prod, mas só `startap` recebe tráfego.

## Por que isso aconteceu (hipótese)

1. Migração 002 rodou (manual, antes do runner): inseriu 4 slots legados.
2. Migração 003 rodou: renomeou e consolidou para os slots novos. Apagou Samuel.
3. Algum re-run manual de 002 (psql -f por dev, ou schema_migrations vazia em algum momento) **re-inseriu os 4 slots legados** porque o `ON CONFLICT (slot) DO NOTHING` não dispara para slots ausentes.
4. Re-run de 003 não corrige porque o `UPDATE WHERE slot = legado` falharia por conflito de PK contra a row nova já existente — e como o runner abre transaction única com `ON_ERROR_STOP=1`, a migration roda como no-op se já estiver em `schema_migrations`.

## Impacto atual

- **Funcional:** zero. Roteamento e bots vivos usam apenas os slots novos.
- **Painel:** mostra 8 cards na aba Bots, dos quais 4 estão sempre zerados — confunde operador.
- **Usage:** queries `SUM(total_tokens)` por slot ficam corretas porque slots legados não recebem tráfego.
- **Risco futuro:** se algum dev re-registrar bot velho ou se algum código consultar `bot-config` por slot legado, pega dados zerados em vez de "não existe".

## Recomendação

Criar **migration 015 — `consolidate_legacy_bot_config_slots`** que, com transação:

```sql
BEGIN;

-- Move usage history dos legados para o novo (idempotente — vira no-op se nao houver historico)
UPDATE model_usage SET slot = 'teste_barbearia' WHERE slot = 'barbearia-cirilo';
UPDATE model_usage SET slot = 'teste_vendas'    WHERE slot = 'elenildo-ricardo';
UPDATE model_usage SET slot = 'startap'         WHERE slot = 'startap-ai-lola';
DELETE FROM model_usage                          WHERE slot = 'startap-ai-samuel';

-- Apaga as 4 rows orfas
DELETE FROM bot_config WHERE slot IN (
  'barbearia-cirilo',
  'elenildo-ricardo',
  'startap-ai-lola',
  'startap-ai-samuel'
);

COMMIT;
```

**Por que migration nova em vez de re-rodar 003:**
- 003 está em `schema_migrations` (caso contrário, slots novos não existiriam).
- Forçar re-run de 003 manualmente seria perigoso (rename pode dar conflito de PK).
- Nova migration é idempotente, registrada normalmente pelo runner, fácil de auditar.

**Limpeza adicional opcional (mesma migration ou separada):**
- Remover as entradas `'startap-ai-lola'` e `'startap-ai-samuel'` de `BOT_MODEL_CONTEXT` em `painel-admin/server.js` — depois que a migration apaga as rows do banco, esses dois objects viram código morto.

## Por que esta PR é só docs

A MISSAO_VIAGEM define: "Time PARA se: detectou que precisa mudar schema (migration)". A migration 015 é mudança de schema (DELETE em bot_config), então:

- ✅ Esta PR (PR-V1) só documenta a investigação — `auto-merge-safe`.
- 🛑 Migration 015 fica como recomendação. Bruno aprova quando voltar (ou via comentário "ok pode aplicar 015").

## Como verificar quando voltar

```bash
# Via API (leitura, sem SSH):
curl -s -u admin:startap2026 https://gestao.startap.tech/api/bots | jq 'length'
# Hoje: 8. Pós-migration 015: deve ser 4.

curl -s -u admin:startap2026 "https://gestao.startap.tech/api/usage/summary?days=30" | jq '[.rows[].slot] | unique'
# Hoje: ["startap","teste_barbearia","teste_vendas","teste_vendas_barbearia"] — confirmação de que so os novos vivem.
```
