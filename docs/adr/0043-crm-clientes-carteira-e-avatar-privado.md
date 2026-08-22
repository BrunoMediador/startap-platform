# ADR 0043 — CRM Clientes: carteira filtrável e avatar privado

**Status:** Proposto  
**Data:** 2026-08-21  
**Missão:** [037 — CRM Clientes: evolução de carteira](../missoes/037-crm-clientes-evolucao.md)  
**Relacionado:** ADR 0040, ADR 0041, ADR 0042

## Decisão

Evoluir a API CRM existente de forma incremental, preservando `GET /portal/clientes?q=...` e as
rotas já publicadas. A lista passa a aceitar filtros de coluna combinados por **E**, paginação e
ordem estável no servidor; o navegador nunca filtra somente a página carregada.

- Escopo e timezone vêm da sessão e do banco. `slot`, `tenant_id`, timezone ou colaborador nunca
  são aceitos do HTTP.
- Atendimento elegível significa `deleted_at IS NULL`, `status <> 'cancelado'` e passado: agenda
  usa `COALESCE(fim_at,inicio_at) <= NOW()`; manual usa data local do tenant.
- O resumo conta carteira, aniversários de hoje e clientes com atendimento elegível. O ranking
  detalhado continua a rota reutilizável já existente.
- Aniversários adicionam `modo=calendario`, com `visao=semana|mes` e âncora `YYYY-MM-DD`. A data
  é civil e não sofre serialização UTC do navegador; `02-29` aparece só em ano bissexto real.
- `clientes.nome_personalizado` é aditivo, NFC/trim e máximo 120. A leitura usa sua precedência
  sobre `clientes.nome`; a origem não é reescrita. Só owner pode alterá-lo ou limpá-lo.

## Foto de perfil

O MVP usa `GET /portal/clientes/:id/avatar`, owner-only. Toda chamada reautoriza `id + slot +
tenant`, resolve a sessão WAHA no servidor e busca a foto sob demanda. O browser não recebe URL
da WAHA/CDN. Se não houver foto ou WAHA falhar, responde `204` para o frontend usar iniciais.

O cache é Redis efêmero: chave opaca SHA-256 de `tenant_id + cliente_id`, bytes ou sentinela
`none`, TTL explícito de 24h. Não há coluna, bucket, URL pública, prefetch, backfill ou refresh.
Antes de servir bytes, valida referência HTTPS em domínio WhatsApp/FBCDN, MIME permitido,
assinatura JPEG/PNG/WebP e máximo de 1 MB. A resposta é `Cache-Control: private, no-store`.

## Segurança e operação

Respostas de lista seguem mascarando telefone. Erros e logs não carregam nome, telefone, URL de
foto ou corpo de mensagem. O avatar não altera a rota/semântica do WhatsApp manual. Migração 088
é somente aditiva e adiciona índices parciais por `slot + tenant + telefone` para agenda/manual;
o manifesto SHA é atualizado. A prova de plano usa PostgreSQL real no CI com `PG_TEST_URL`.

## Consequências

O owner ganha filtros e personalização sem modificar histórico/snapshots; colaborador continua
read-only e recebe apenas a carteira de atendimentos próprios. Avatar pode ficar ausente por
privacidade, indisponibilidade ou cache negativo — isso é estado normal, não erro de produto.
