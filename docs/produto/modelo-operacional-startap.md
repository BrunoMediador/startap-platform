# Modelo Operacional Startap

**Criado por:** product-owner
**Data:** 2026-05-18
**Contexto:** Fala do Bruno apos rejeicao da vitrine Linear-like simples (PR #56)
**Relacionado a:** [Missao 003](../missoes/003-overhaul-painel-admin.md) | [ADR 0005](../adr/0005-direcao-visual-painel.md)

---

## 1. Identidade do produto

A Startap vende fluxos automatizados de WhatsApp com IA para nichos especificos: barbearias, vendedores de curso e a combinacao dos dois. O produto opera sobre 4 fluxos: 1 interno (startap/Lola, usado pela propria empresa para prospecção) e 3 matrizes de teste (teste_barbearia, teste_vendas, teste_vendas_barbearia) onde clientes potenciais experimentam o bot antes de contratar. O modelo de negocio e recorrente: o cliente aprova o teste, preenche um formulario, e ganha um clone dedicado rodando no numero e na agenda dele.

Mais detalhes sobre stack e infraestrutura em [CLAUDE.md](../../CLAUDE.md).

---

## 2. Funil de vendas (resumo)

```
Prospecção (Lola no Instagram → WhatsApp)
   ↓
Time de vendas humano (Bruno + Ícaro usam o painel)
   ↓
Cliente entra no router de teste (multi-tenant temporario)
   ↓
Cliente aprova → preenche form com dados do negocio
   ↓
Clone dedicado: sessao WAHA propria, agenda propria, bot 24/7
```

O funil completo, incluindo responsabilidades por etapa, esta descrito em [CLAUDE.md](../../CLAUDE.md).

---

## 3. Modelo operacional — os 10 principios

Os principios abaixo foram estabelecidos pelo Bruno em 2026-05-18 e representam o comportamento esperado do sistema em producao.

**Roteamento**

1. **WAHA de teste filtra por numero cadastrado.** Uma mensagem que chega a qualquer sessao de teste (teste_barbearia, teste_vendas, teste_vendas_barbearia) so recebe resposta se o numero estiver cadastrado em `routing_clientes`. Mensagens de numeros nao mapeados sao ignoradas silenciosamente. Isso protege o router de teste de virar suporte ao cliente de quem nao e lead qualificado.

2. **WAHA startap (Lola) nao filtra por numero.** Qualquer mensagem recebida pelo fluxo `startap` aciona o bot. Lola foi feita para prospectar: quanto mais gente entrar, melhor. Sem lista de bloqueio por numero.

**Operacao humana**

3. **Pausa configuravel por fluxo.** Cada fluxo pode ter sua propria pausa ativada e desativada, com comandos customizaveis (ex: `#pausar` / `#ativar`). Bruno ou Icaro ativam pausa para um bot especifico sem afetar os demais. Os comandos de pausa sao editaveis via painel.

**Configuracao rica**

4. **Midia com contexto para a IA.** Ao fazer upload de uma imagem, audio ou documento para um bot, o operador informa uma descricao/contexto que e enviado junto ao modelo de IA. A IA nao interpreta a midia diretamente — ela usa o contexto textual fornecido pelo operador para entender o que aquele arquivo significa.

5. **Editor de prompt em tempo real.** Alterar o prompt de um bot e ver o efeito em segundos, sem abrir o n8n ou acessar o banco. A edicao acontece inline no painel, com save imediato e aplicacao ao proximo turno de conversa.

6. **Troca de modelo via UI.** O operador escolhe o modelo de IA (gpt-4o, deepseek, outros) diretamente pelo painel. Sem acesso ao n8n para trocar provider ou versao de modelo.

**Clone**

7. **Clone = sessao WAHA dedicada.** Quando um cliente aprova e clona a matriz, ele ganha uma sessao WAHA propria (nao compartilhada com outros clientes). O fluxo clonado roda no numero do proprio cliente.

8. **Clone com agenda exige token do Google Calendar do cliente.** Se a matriz clonada inclui agendamento (barbearia ou misto), o token OAuth do Google Calendar do cliente e obrigatorio antes de ativar o clone. O sistema deve rejeitar a ativacao se o token nao estiver configurado.

**Operacao**

9. **Limpeza horaria de historico de chat.** Um cron job limpa o `chat_histories` de todos os fluxos a cada hora. Isso evita que a janela de contexto da IA acumule mensagens de turnos antigos, reduz custo de tokens e evita confusoes por contexto desatualizado.

10. **Velocidade como meta de produto.** O ciclo prospectar → testar → clonar deve ser rapido. O foco esta nas 3 matrizes existentes (barbearia, vendas, vendas+barbearia). Novas matrizes ou nichos sao decididos pelo Bruno; o time nao expande o catalogo por conta propria.

---

## 4. Mapeamento entidade x principio

| Principio | Entidade / componente |
|---|---|
| 1 — Filtro por numero (teste) | `routing_clientes` |
| 2 — Sem filtro (Lola) | sessao WAHA `startap` + fluxo `startap` |
| 3 — Pausa por fluxo | `flow_pause` (ou config equivalente por fluxo) + campos de comando customizavel |
| 4 — Midia com contexto | tabela/campo `bot_media` + campo `contexto` |
| 5 — Editor de prompt em tempo real | `bot_prompt` + endpoint `PUT /api/bots/:id/prompt` com aplicacao imediata |
| 6 — Troca de modelo via UI | `bot_config.model` / `bot_config.provider` + UI de selecao |
| 7 — Clone com sessao dedicada | `flow_clones` + `waha_sessao` dedicada por clone |
| 8 — Token Calendar obrigatorio | `flow_clones.google_calendar_token` (verificar nome real no schema) |
| 9 — Limpeza horaria | cron job sobre tabela `chat_histories` |
| 10 — Velocidade | meta de produto (sem entidade tecnica — governanca do Bruno) |

---

## 5. Principios x fases da Missao 003

| Principio | Fase 003 | Observacao |
|---|---|---|
| 1 — Filtro roteamento | **003-F** | Secao de roteamento global; exibe e edita `routing_clientes` |
| 2 — Lola sem filtro | fora de 003 | Comportamento ja existente no fluxo `startap`; sem mudanca planejada |
| 3 — Pausa por fluxo | **003-G** | Junto com edicao de prompt/modelo — controles de configuracao por bot |
| 4 — Midia com contexto | **003-H** | Upload de midia reformulado; campo de contexto adicionado ao formulario |
| 5 — Editor de prompt | **003-G** | Endpoint `PUT` + UI inline; verificar se exige migration de schema |
| 6 — Troca de modelo | **003-G** | Dropdown de modelo/provider no mesmo painel de configuracao inline |
| 7 — Clone com sessao WAHA | **003-E** | Secao de sessoes WAHA: criar, vincular, reconectar, derrubar |
| 8 — Token Calendar obrigatorio | **003-K** | Configuracoes de clone; validacao obrigatoria antes de ativar |
| 9 — Limpeza horaria | missao nova (proposta: **Missao 005**) | Cron job de limpeza nao esta mapeado em nenhuma fase de 003 — requer backend + agendamento |
| 10 — Velocidade | meta continua | Sem fase tecnica; avaliado pelo Bruno a cada gate de aprovacao de PR |

> **Nota sobre Missao 005 (proposta):** o principio 9 exige um cron job persistente que limpe `chat_histories` periodicamente. Isso e escopo de backend/infra, nao de painel. Deve ser priorizado pelo Bruno separadamente apos 003 estabilizar.

---

## 6. O que NAO e Startap

- **Nao e multi-tenant real.** Cada clone e um fluxo dedicado — nao ha compartilhamento de recursos entre clientes.
- **Nao e SaaS self-service.** O cliente nao se cadastra sozinho. O time de vendas (Bruno e Icaro) guia o processo do inicio ao fim.
- **Nao e multi-canal.** So WhatsApp via WAHA. Sem Telegram, Instagram DM, SMS ou email no escopo atual.
- **Nao tem landing ou captacao no produto.** O Instagram da Startap puxa para o WhatsApp; o repositorio nao tem pagina publica de captacao.
- **Nao integra com CRM externo.** Leads vivem no painel Startap. Nenhuma integracao com HubSpot, Pipedrive ou equivalente esta planejada.

---

## 7. Atualizacoes (log)

| Data | Evento |
|---|---|
| 2026-05-18 | Documento criado pelo `product-owner` a partir de fala do Bruno apos rejeicao da vitrine Linear-like simples (PR #56) |
