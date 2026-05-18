# Missão 005 — Wizard de Clone com Sessão WAHA Automática

**DRI:** dev-front (005-C/D) + dev-back (005-B)
**Apetite:** médio (4–6 PRs, 2–3 semanas)
**Status:** pendente
**Cliente:** Bruno e Ícaro — operadores fechando vendas e colocando cliente em produção
**Aberta em:** 2026-05-18

---

## PR-FAQ embedded

**Hoje, 2026-05-18, a Startap lança o Wizard de Clone completo — Bruno ou Ícaro fecham a venda, abrem o painel, percorrem 5 passos e o cliente já está escaneando o QR do próprio bot, tudo sem tocar no servidor.**

Antes, clonar um fluxo e conectar a sessão WAHA exigia três telas diferentes, criação manual da sessão e vinculação separada no banco. Agora é um fluxo guiado único: o operador termina no passo 5 e o cliente já está online. Ícaro diz: "antes eu abria 4 abas pra fazer isso; agora é uma."

**Q: Quem se beneficia?**
A: Bruno e Ícaro no fechamento de cada cliente novo. Em breve, o próprio cliente em onboarding self-service.

**Q: Por que agora?**
A: A Missão 003 entregou as duas peças isoladas — `createClone()` e `POST /api/sessions`. Sem esta missão, o operador continua orquestrando 3–4 telas manualmente. É o principal gargalo de velocidade do ciclo de venda.

**Q: Qual o risco de não fazer?**
A: Cada cliente novo exige 5–10 min de trabalho manual do operador. Com crescimento de vendas, isso escala mal. O princípio 7 do modelo operacional fica formalmente aberto.

**Q: Quais alternativas foram consideradas?**
A: (1) Wizard separado — descartado, aumenta superfície de UI sem ganho. (2) CLI scaffolder — válido para automação futura, mas não resolve a UX do operador hoje. (3) Estender o wizard atual — escolhido: o wizard já existe em `painel-admin/public/index.html` com 3 steps (matriz, dados, sessão), só falta o QR ao vivo e a orquestração backend.

**Q: O que NÃO está incluso?**
A: Auto-conexão Google Calendar (fluxo manual já existe via 003-L); pipeline de vídeo (Missão 004); multi-tenant self-service (login próprio do cliente final); rollback automático de sessão no WAHA se clone falhar.

**Q: Como medimos sucesso?**
A: Em até 14 dias após deploy, Ícaro clona barbearia, cliente escaneia QR e recebe resposta do bot em menos de 2 minutos, sem SSH ou SQL manual.

**Q: Riscos?**
A: (1) WAHA demora 10–30s para criar sessão — UI precisa de loading honesto com timeout visível. (2) Conflito de nome de sessão em criações paralelas — backend valida unicidade antes do `POST /api/sessions`. (3) Cliente fecha o navegador antes de escanear — clone fica criado com sessão dangling; mitigação: coluna `status = 'aguardando_qr'` já existe em `flow_clones`, o painel lista clones pendentes com botão "Continuar onboarding".

---

## Contexto técnico

O wizard atual (`openCloneWizard` / `renderWizardStep` em `painel-admin/public/index.html:3603`) tem **3 steps**: (1) escolha de matriz, (2) dados do cliente, (3) tela com botão "Criar sessão e mostrar QR" — mas esse botão ainda não cria a sessão automaticamente nem faz polling do QR.

No backend existem dois endpoints separados:
- `POST /api/clones` — chama `createClone()` de `packages/db/src/queries/flow-clones.ts:85`
- `POST /api/clones/:id/bind-session` — chama `setCloneSession()` de `flow-clones.ts:294`

Não existe endpoint orquestrado que faça os dois em sequência e já dispare a criação da sessão WAHA. O `POST /api/sessions` (003-E) cria a sessão no WAHA; o `GET /api/sessions/:name/qr` retorna o QR base64. O status `WORKING` no WAHA sinaliza conexão estabelecida.

---

## Solução proposta

- Novo endpoint `POST /api/clones/with-waha` que orquestra em sequência: cria clone no banco, cria sessão WAHA com nome `clone_<slot>`, vincula via `setCloneSession()`, retorna `{ clone_id, slot, waha_sessao, status }`
- Wizard estendido para **5 steps**: (1) Matriz, (2) Dados do cliente, (3) Personalização (opcional, herdável), (4) QR ao vivo com polling de 3s e auto-avanço ao `WORKING`, (5) Confirmação com link ao clone e atalho para Google Calendar
- Step 4 exibe estado honesto: "Criando sessão...", "Aguardando QR...", "Aguardando conexão...", "Conectado!"
- Tratamento de erro no step 4: botão "Tentar de novo" + link "Criar sessão manualmente" (abre aba Sessões WAHA)
- Painel de clones lista clones com `status = 'aguardando_qr'` com badge e botão "Continuar onboarding"

---

## Definition of Done

- [ ] Endpoint `POST /api/clones/with-waha` cria clone + sessão WAHA + vínculo em sequência, com validação de unicidade de nome de sessão
- [ ] Wizard cobre 5 steps em fluxo único, sem página separada
- [ ] Step 4 faz polling de QR a cada 3s e avança automaticamente ao detectar `status=WORKING`
- [ ] Error state no step 4: mensagem clara + botão "Tentar de novo" + fallback manual
- [ ] Clones com `status=aguardando_qr` aparecem no painel com badge e botão "Continuar onboarding"
- [ ] Smoke test: Ícaro clona barbearia → cliente escaneia QR → mensagem no WhatsApp cai no bot → bot responde com prompt da matriz
- [ ] `docs/produto/modelo-operacional-startap.md` — princípio 7 marcado como implementado
- [ ] PR mergeada pelo Bruno
- [ ] Deploy validado em produção

---

## Fora de escopo

- Auto-conexão Google Calendar (fluxo manual já existe)
- Pipeline de upload de vídeo (Missão 004)
- Multi-tenant self-service com login do cliente final
- Rollback automático no WAHA em caso de falha parcial de clone

---

## Plano de PRs

| PR | Responsável | O que faz |
|---|---|---|
| 005-A | product-owner | Este documento + revisão do wizard atual (sem código) |
| 005-B | dev-back | Endpoint `POST /api/clones/with-waha` — orquestra clone + sessão + vínculo |
| 005-C | dev-front | Wizard estendido: steps 4 (QR ao vivo) e 5 (confirmação) |
| 005-D | dev-front | UX polish: loading states, error states, retry, badge "Continuar onboarding" |
| 005-E | tester + product-owner | Smoke test end-to-end + atualização do modelo operacional |

---

## Dependências

- Missão 003 encerrada (todos os endpoints de clone e sessão WAHA em produção)
- WAHA respondendo em `http://129.121.47.231:3008` (assumindo prod estável)
- Bruno e Ícaro disponíveis para smoke test end-to-end na 005-E

---

## Riscos

- WAHA demora mais que 30s para criar sessão: UI mostra contador regressivo e permite cancelar sem deixar clone dangling
- Conflito de nome de sessão em criações paralelas: backend consulta sessões existentes antes de criar (`GET /api/sessions`)
- Clone criado mas sessão nunca conectada: coluna `status` já modela `aguardando_qr` — painel lista e permite retomar

---

## Atualizações

- 2026-05-18: missão aberta pelo `product-owner` após Bruno aprovar como P0 pós-encerramento da Missão 003.
