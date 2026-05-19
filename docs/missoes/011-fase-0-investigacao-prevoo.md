# Missão 011 — Fase 0: Investigação pré-voo (VPS + disco + DB)

**DRI:** infra
**Agentes envolvidos:** infra (principal), dev-back (valida tamanho do banco e tabelas), arquiteto (decide estratégia de backup)
**Apetite:** pequeno (1 dia)
**Status:** pendente
**Cliente (persona):** time técnico inteiro — nenhuma missão das ondas 1-4 pode começar com segurança sem este diagnóstico
**Aberta em:** 2026-05-19
**PR-FAQ:** N/A (investigação, não feature)

---

## Contexto

Auditoria de 2026-05-19 revelou que o VPS está com 72/100 GB ocupados e que **não existe backup do Postgres**. Antes de qualquer missão de correção, é preciso saber exatamente o que ocupa disco, qual o tamanho real do banco, se há objetos para limpar, e definir a estratégia de backup (repo Git privado separado, conforme memória `project_backup_via_git`). Sem esse levantamento, uma migration que falhe pode deixar o banco sem rollback possível.

## Solução proposta

- SSH no VPS e executar diagnóstico de disco completo (`du -sh`, `docker system df`, `docker logs --tail 1000`)
- Medir tamanho de cada tabela Postgres por slot e identificar candidatas a `VACUUM` / arquivamento
- Listar imagens Docker não usadas, logs de container e arquivos de mídia duplicados como candidatos a limpeza
- Definir estratégia de backup: pg_dump diário → repo Git privado (ou Git LFS se >100 MB), frequência, retenção
- Criar runbook em `docs/runbooks/backup-postgres.md` com o procedimento estabelecido
- Gerar lista anotada do que pode ser deletado e tamanho estimado recuperado

## Definition of Done (DoD)

- [ ] Relatório de disco documentado em `docs/auditorias/2026-05-19-disco-vps.md` com breakdown por diretório/container
- [ ] Tamanho de cada tabela Postgres listado (ao menos para as 10 maiores)
- [ ] Decisão sobre backup (estratégia, destino, frequência) registrada no relatório
- [ ] Runbook `docs/runbooks/backup-postgres.md` criado com passo a passo reproduzível
- [ ] Lista de candidatos a limpeza imediata (com tamanho) entregue ao Bruno para aprovação antes de qualquer `rm`
- [ ] PR mergeada pelo Bruno
- [ ] Tester confirmou que todos os containers ainda respondem após inspeção (sem colateral)

## Fora de escopo

- Executar a limpeza de disco (isso fica para a Missão 012-A8)
- Configurar o cron de backup automático (missão separada pós-aprovação do runbook)
- Migração de dados entre tabelas
- Qualquer mudança em código de aplicação

## Dependências

- Acesso SSH ao VPS (chave `hostinger_codex_ed25519`) — Bruno precisa autorizar sessão SSH explicitamente
- Repo Git privado para backup ainda não criado — infra identifica necessidade nesta missão; Bruno cria o repo antes de configurar

## Riscos

- **Diagnóstico consome I/O em prod:** mitigação: usar `ionice -c3` nos comandos `du`; executar em horário de baixo tráfego
- **Bruno precisa autorizar SSH:** sem autorização específica (alvo + operações), classifier bloqueia; pedir ao Bruno texto explícito antes de iniciar
- **Tabela de backup muito grande para Git sem LFS:** mitigação: medir primeiro; decidir Git LFS ou dump comprimido antes de commitar

## Plano de quebra

Esta missão é pequena e cabe em 1 PR:

1. **011-A:** Diagnóstico + runbook de backup — infra (1 PR)

## Atualizações (log)

- **2026-05-19:** Aberta pelo product-owner após auditoria completa de 2026-05-19 identificar VPS 72/100 GB e ausência de backup
