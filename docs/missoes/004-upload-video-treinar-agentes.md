# PR-FAQ (rascunho) — Missão 004: Upload de Vídeo para Treinar Agentes

> **Escrito por:** `product-owner`
> **Data:** 2026-05-18
> **Status:** RASCUNHO — aguardando priorização pelo Bruno
> **Origem:** cortado do escopo de Missão 003 por decisão do Bruno em 2026-05-18

---

## PR-FAQ: Upload de Vídeo para Treinar Agentes de IA

### Press Release

**Hoje, <data a definir>, a Startap lança o suporte a vídeos de treinamento no painel — uma forma de o time carregar, organizar e referenciar vídeos que os agentes de IA usam como contexto ao responder clientes.**

Antes, não havia como subir vídeos de treinamento para os agentes. Bruno não conseguia descrever fluxos em vídeo para os bots entenderem. Agora, o painel tem uma seção dedicada para upload, listagem e vinculação de vídeos de treinamento a cada agente ou fluxo.

Bruno diz: "Antes eu não conseguia nem descrever o vídeo pros nossos agentes entenderem. Agora é só subir e vincular."

### FAQ Interna

**Q: Quem se beneficia?**
A: Bruno — principal responsável por configurar os agentes de IA e alimentar o contexto de treinamento dos bots em produção.

**Q: Por que foi separado da Missão 003?**
A: A Missão 003 cobre o overhaul visual do painel. Suporte a vídeo exige backend próprio (storage, endpoint de upload, vínculo com agente/fluxo) que vai além do escopo visual e pode estourar o apetite de 003. Separar permite que 003 entregue valor mais rápido sem travar em complexidade de storage.

**Q: Como funciona pro cliente (Bruno)?**
A: (a detalhar após priorização — plano de quebra não escrito ainda)

**Q: O que NÃO está incluso?**
A: (a detalhar após priorização)

**Q: Como medimos sucesso?**
A: (a definir com Bruno na sessão de priorização)

**Q: Qual o apetite?**
A: A definir — suspeita inicial: médio (2-4 PRs). Depende de como o storage será resolvido (S3, volume local, serviço externo).

**Q: Quem é o DRI?**
A: A definir — suspeita: `dev-back` (backend de storage + endpoint) + `dev-front` (UI de upload e listagem).

**Q: Riscos?**
A:
1. **Storage de vídeo em produção:** decisão de onde guardar (S3, volume Docker, serviço externo) pode virar ADR antes de codar.
2. **Tamanho de arquivo e timeout:** uploads grandes podem travar o Express atual sem streaming configurado.
3. **Vínculo entre vídeo e agente de IA:** como o LLM referencia o vídeo (URL pública? transcrição automática?) precisa ser definido antes de qualquer PR.

---

> **Proximos passos:** Bruno prioriza esta missão no backlog. Quando for a vez, `product-owner` completa o PR-FAQ, `arquiteto` avalia necessidade de ADR (storage), e o plano de quebra é escrito.
