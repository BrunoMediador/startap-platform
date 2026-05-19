# Missão 017 — Onda 3: Débitos operacionais (C4-C8, C10)

**DRI:** infra (C4, C5, C7) + dev-back (C6, C8, C10)
**Agentes envolvidos:** infra, dev-back, tester, gerente-pr
**Apetite:** grande (até 5 dias úteis, ~1 semana)
**Status:** pendente
**Cliente (persona):** time técnico — débitos que não causam bugs hoje mas aumentam risco de incidente futuro (deploy sem rollback, healthcheck ausente, cache inexistente)
**Aberta em:** 2026-05-19
**PR-FAQ:** N/A (débitos técnicos, não features)

---

## Contexto

A auditoria de 2026-05-19 identificou 6 débitos operacionais que não exigem ADR mas também não são bugs críticos imediatos. São melhorias de robustez: healthcheck declarativo no Docker (C4), rollback automático no script de deploy (C5), cache de `flow_clones` e `flow_controls` no router (C6), investigação do gap na sequência de migrations (C7), limpeza de `KNOWN_CHAT_TABLES` com typos (C8), e atualização do status do ADR 0007 + resolução de numeração duplicada em ADRs (C10). Esses itens são independentes e podem ser desenvolvidos em paralelo pelas duas trilhas.

## Restrições críticas

- C5 (rollback) não pode desativar a lógica de deploy existente — deve ser adicionado como camada de segurança
- C7 é investigação: se encontrar migration faltante, criar migration de correção idempotente (sem DROP/DELETE)
- C10 é só documentação — nenhum código de aplicação é alterado

## Sub-missões / PRs

### PR-C4 — Healthcheck Docker declarativo (infra)
**Achado:** Dockerfile e compose sem `HEALTHCHECK` declarativo; Docker não sabe se o container está saudável.
**Escopo:** adicionar `HEALTHCHECK` no `Dockerfile` do painel-admin e da API (`curl -f http://localhost:PORT/health || exit 1`); adicionar `healthcheck` em `docker-compose.yml` para cada serviço; confirmar que `docker ps` mostra `(healthy)` após deploy.
**Restrição:** endpoint `/health` deve já existir ou ser criado na mesma PR (verificar com dev-back se API tem `/health`).

### PR-C5 — Rollback automático no `deploy.sh` (infra)
**Achado:** `scripts/deploy.sh` não tem mecanismo de rollback se a imagem nova falhar no healthcheck.
**Escopo:** adicionar lógica de rollback: se `docker ps` mostrar container `unhealthy` ou `exited` após X segundos do deploy, restaurar a imagem anterior (tag `previous`) e notificar via log. Não deve alterar o fluxo de deploy em caso de sucesso.
**Restrição:** smoke test antes e depois do rollback no script; sem modificar GitHub Action — rollback é dentro do script.

### PR-C6 — Cache em `router.ts` para `flow_clones` e `flow_controls` (dev-back)
**Achado:** `apps/api/src/router.ts` consulta `flow_clones` e `flow_controls` no banco a cada mensagem recebida (hot path).
**Escopo:** implementar cache em memória com TTL de 30s (ou configurável via env) usando `Map` simples (sem nova dependência); invalidar cache em mutations (POST/PATCH/DELETE de clones e controles); medir e documentar redução de queries no log.
**Restrição:** cache deve ser por instância (sem Redis compartilhado entre instâncias por ora — decisão de BullMQ ainda pendente); TTL configurável via `ROUTER_CACHE_TTL_MS` env.

### PR-C7 — Investigar gap na sequência de migrations (infra + dev-back)
**Achado:** auditoria indicou possível gap na numeração de migrations (migration 016 possivelmente ausente).
**Escopo:** listar todas as migrations em `packages/db/migrations/`; comparar com o registro de migrations aplicadas no banco (`SELECT * FROM schema_migrations` ou equivalente); documentar o que foi encontrado. Se gap real: criar migration 016 idempotente que registra o gap sem alterar dados. Se não há gap: documentar no ADR de forma breve.
**Restrição:** não reordenar migrations existentes; não executar `DROP` de nada.

### PR-C8 — Limpar `KNOWN_CHAT_TABLES` (dev-back)
**Achado:** array `KNOWN_CHAT_TABLES` (ou equivalente) contém entradas com typo (ex: `STARTTAP_AI` com duplo T, confirmado nos logs da auditoria).
**Escopo:** corrigir typos nas constantes; adicionar comentário explicando o propósito da lista; confirmar que o cleanup-chat worker continua funcionando após a correção.
**Restrição:** grep em todos os lugares que usam essa constante antes de alterar; confirmar que nenhum bot usa o nome errado como referência.

### PR-C10 — Atualizar ADR 0007 e resolver numeração duplicada (dev-back)
**Achado:** `docs/adr/0007-isolamento-memoria-por-clone.md` tem status desatualizado; há ADRs com numeração duplicada `0001-*`.
**Escopo:** atualizar status do ADR 0007 para refletir o estado atual (implementado? em revisão?); renumerar ADRs duplicados em sequência lógica (0001, 0002, 0003...); atualizar referências internas se houver.
**Restrição:** mudança apenas em arquivos `docs/adr/`; não alterar código de aplicação.

## Definition of Done (DoD)

- [ ] C4: `docker ps` mostra `(healthy)` para API e painel após deploy em prod
- [ ] C5: deploy de imagem propositalmente quebrada aciona rollback automático (teste em staging)
- [ ] C6: log de startup da API mostra "cache de router ativado (TTL: Xms)"; queries no DB reduzidas em hot path
- [ ] C7: resultado da investigação documentado em `docs/auditorias/2026-05-19-migration-gap.md`; banco sem gap não-registrado
- [ ] C8: `KNOWN_CHAT_TABLES` sem typos; cleanup-chat worker continua rodando após deploy
- [ ] C10: `docs/adr/` sem numeração duplicada; ADR 0007 com status atualizado
- [ ] Build local passa (`npm run build --workspaces`) após cada PR
- [ ] Tester validou cada PR antes de abrir para review
- [ ] Cada PR mergeada individualmente pelo Bruno
- [ ] Deploy validado em produção após cada merge

## Fora de escopo

- Refactor do deploy.sh completo (só adicionar rollback)
- Mover para Redis distribuído (depende de ADR — Missão 015)
- Correção de timezone no Postgres (scope da Missão 013)
- Criação de novos ADRs (Missões 014/015/016 cuidam disso)

## Dependências

- **C4/C5:** Missão 011 concluída (disco liberado antes de adicionar camadas de healthcheck que baixam imagens novas)
- **C6:** Missão 012 PR-A1 mergeada (branch desbloqueada)
- **C7:** acesso ao banco de produção para `SELECT` na tabela de migrations (infra + dev-back coordenam)
- **C8:** C7 concluído (para garantir que o typo em `KNOWN_CHAT_TABLES` não está relacionado ao gap de migration)
- **C10:** pode começar imediatamente (só documentação)

## Riscos

- **C5 — rollback aciona em falso positivo:** mitigação: timeout generoso (60s) antes de considerar unhealthy; condição de rollback explícita no script
- **C6 — cache com TTL muito longo atrasa propagação de mudanças:** mitigação: TTL default de 30s; mutations invalidam o cache imediatamente
- **C7 — gap real encontrado com dados em estado inconsistente:** mitigação: migration de correção revisada pelo Bruno antes de executar em prod

## Atualizações (log)

- **2026-05-19:** Aberta pelo product-owner após auditoria de 2026-05-19 identificar débitos operacionais C4-C8, C10
