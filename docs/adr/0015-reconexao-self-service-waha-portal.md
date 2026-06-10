# ADR 0015 — Reconexão self-service da sessão WAHA no Portal do Cliente

- Status: PROPOSTO (aguarda aprovação do Bruno)
- Data: 2026-06-10
- Autor: 01-arquiteto
- Escopo: somente apps/portal-api + packages/integrations (cliente WAHA) + UI do portal-web. NÃO toca no gestão/painel-admin.

## Contexto
A sessão WAHA de um cliente cai com frequência. Hoje só o Bruno reconecta manualmente via dashboard WAHA — gargalo e ponto único de falha. Objetivo: o cliente logado no Portal (app.startap.tech) reconecta a própria sessão sem suporte humano. Canal principal = código de pareamento (8 chars, XXXX-XXXX); QR = fallback sempre visível.
Por que nunca funcionou antes: (Bug A) mandavam `+` no phoneNumber, sendo que request-code exige E.164 só dígitos; (Bug B) não faziam restart+poll antes, e request-code só funciona em SCAN_QR_CODE; enviar `method` dá 422 no NOWEB.

## Decisão
Expor no portal-api um fluxo self-service isolado por tenant, com código de pareamento primário e QR fallback, orquestrando status → restart → poll → request-code/qr server-side.
Decisões travadas pelo Bruno: (1) banner automático quando status != WORKING + tela sempre acessível; (2) número NÃO editável, código sempre no número cadastrado (flow_clones.cliente_telefone), derivado server-side, UI mostra mascarado sem input; se cliente_telefone null → cai pra QR + msg suporte; (3) restart automático ao clicar Reconectar, só na sessão daquele cliente; (4) foco 100% no portal, gestão fica de fora.

Contrato WAHA (congelado NOWEB): POST /api/{session}/auth/request-code body {"phoneNumber":"5511979630828"} (E.164, SÓ DÍGITOS, SEM +). NÃO enviar method (422). Resposta {"code":"XXXX-XXXX"}, expira ~60s, só em SCAN_QR_CODE. POST /api/sessions/{session}/restart leva FAILED/STOPPED/STARTING → SCAN_QR_CODE. Nunca logout. Nunca 2 restarts seguidos (invalida código) → debounce/lock. GET /api/sessions/{session} = verdade do estado (poll ~2s). GET /api/{session}/auth/qr = fallback, só em SCAN_QR_CODE.

## Máquina de estados
Estados: WORKING, STARTING, SCAN_QR_CODE, FAILED, STOPPED.
- WORKING: reconectar/codigo/qr → 409 (guard, protege sessão pagante).
- STARTING: aguarda poll (sem 2º restart); codigo/qr aguardam SCAN_QR_CODE.
- SCAN_QR_CODE: reconectar = noop; codigo gera; qr retorna.
- FAILED/STOPPED: reconectar = restart→poll até SCAN_QR_CODE; codigo/qr = 409 até virar SCAN_QR_CODE.
Erros: 409 estado incompatível; 422 body inválido (tratar como bug nosso, normalizar E.164 antes); 429 rate-limit/lock (com Retry-After); timeout 20s no poll → 504 tratado.

## cliente_telefone == null
codigo retorna 422 telefone_nao_cadastrado (nunca aceita input). UI degrada pra QR + "número não cadastrado, fale com suporte". Banner segue (depende só do status).

## Consequências
Instabilidade do pairing (Baileys) mitigada por QR fallback. Restart em sessão pagante (Cirilo) mitigado por guard != WORKING + lock Redis + rate-limit 1/30s. P0 de multi-tenancy NÃO piora (slot do JWT, sessão de flow_clones.waha_sessao, nunca input). LGPD: telefone mascarado. Timeout em toda chamada WAHA evita degradar o portal. Sem migration → rollback trivial.

## Rollout
Feature flag PORTAL_RECONEXAO_WAHA default OFF. Deploy OFF (dormente) → validar em WHATSAPP_ROUTER_TESTE (sem tocar Cirilo/Lola) → Bruno habilita pra piloto → depois clientes pagantes com guard != WORKING validado.

## Critérios de aceitação
request-code sem + e sem method; reconectar em WORKING → 409 sem restart; 2 cliques rápidos → 429 sem 2º restart; cliente_telefone null → telefone_nao_cadastrado + UI QR; toda chamada WAHA com timeout; slot/sessão nunca de input.
