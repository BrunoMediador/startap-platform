# Guia de Onboarding — Cliente Startap

> ⚠️ **Draft pendente de revisão do Bruno** — texto inicial preparado durante MODO VIAGEM. O conteúdo descritivo está correto; o tom comercial pode ser ajustado.

Bem-vindo. Este guia explica passo a passo como a **Startap** atende o seu negócio no WhatsApp: do primeiro teste até a operação com um bot dedicado por cliente.

---

## 1. O que a Startap entrega

- Um **bot de WhatsApp** que conversa com seus clientes 24/7 — atende em linguagem natural, entende áudio, segue o tom que você definir.
- Integrações prontas: **Google Calendar** (agendamento), **OpenAI** (texto), **Whisper** (áudio em português).
- **Painel web** pra você acompanhar conversas, leads e custos sem depender de planilha.
- Sem app pra instalar no seu celular. Tudo roda no nosso servidor, conectado à sua linha do WhatsApp Business.

Hoje atendemos três modelos de negócio prontos (você pode usar qualquer um como ponto de partida):

| Modelo | Fluxo padrão | Quem usa hoje |
|---|---|---|
| **Barbearia** | Atende cliente, mostra horários livres, agenda no Google Calendar | Barbearia Cirilo |
| **Curso / venda** | Qualifica interessado, manda materiais, fecha venda do curso | Curso de Barbeiro Ricardo |
| **Misto** | Vende curso + agenda serviços (combina os dois) | Em testes |

---

## 2. Como testar antes de contratar

1. Você nos envia uma mensagem solicitando o teste do **fluxo matriz** que parece com o seu negócio (`teste_barbearia`, `teste_vendas` ou `teste_vendas_barbearia`).
2. Liberamos o nosso número de teste (ou um número descartável conectado ao matriz).
3. Você conversa com o bot por 1–3 dias, em qualquer horário. Vê como ele responde, ajusta dúvidas.
4. Quando aprovar, partimos para a **personalização** (próxima seção).

Você só paga quando vira cliente — o teste é por nossa conta.

---

## 3. O modelo de "clone"

Cada cliente novo vira um **clone** de uma matriz. Quer dizer:

- O bot já vem com o cérebro do fluxo (agendamento, venda, atendimento misto) — você não escreve do zero.
- A **personalização** é leve: nome do negócio, horário de funcionamento, serviços oferecidos, tom de voz (formal/informal/divertido), agenda do Google a usar, lista de produtos/preços.
- O clone tem **sessão WhatsApp própria** — seu número, seu QR code, seus contatos. Independente de outros clientes.
- Os **leads e agendamentos** ficam separados — você só vê o que é seu.

Diferenças entre clientes ficam em código? Não. Tudo é configurado via painel ou prompt. Se precisar de algo realmente único (integração com um sistema seu, por exemplo), conversamos.

---

## 4. Como ligar seu WhatsApp ao clone

Ao contratar:

1. Nós criamos a **sessão WAHA** dedicada ao seu clone.
2. Você abre o painel (`https://gestao.startap.tech`, com a credencial que mandamos), entra no card do seu bot e clica em **Conectar WhatsApp**.
3. O painel mostra um **QR code** parecido com o do WhatsApp Web.
4. No seu celular: WhatsApp Business → Configurações → Aparelhos conectados → Conectar aparelho → escaneie o QR.
5. Em 5–15 segundos, o status do clone vira **Conectado**. A partir daqui, qualquer mensagem que chegar no seu número é atendida pelo bot.

> Importante: você continua mexendo no WhatsApp normalmente. O bot só responde quando **você não responde primeiro**. Pode pausá-lo a qualquer momento.

---

## 5. Acompanhando o dia a dia

No painel você vê:

- **Dashboard** — quantas mensagens hoje/semana, leads novos nas últimas 24h, agendamentos pendentes, custo de IA acumulado.
- **Bots** — abre o card do seu clone, edita o prompt, sobe áudios/imagens/PDFs que o bot envia em momentos específicos.
- **Execuções** — log do que o bot fez em cada conversa (útil pra debug).
- **Relatórios** — listas exportáveis de leads, agendamentos, conversas.
- **Configurações** — limpeza de histórico, palavras de pausa (mensagens que o bot reconhece pra parar de responder).

Em mobile o painel também funciona — pode acompanhar pelo celular.

---

## 6. Custos previstos

Você paga por:

1. **Mensalidade da Startap** — combinada na contratação (depende do volume e do modelo).
2. **Tokens de IA** — repassados pelo custo real. O painel mostra USD gastos por dia (Dashboard → "Custo 7 dias"). Conversa típica de 5 mensagens custa US$ 0,001–0,01 dependendo do modelo. Mensalmente fica em alguns dólares para volumes pequenos.

Sem letra miúda. Você acompanha tudo pelo painel.

---

## 7. O que **não** está incluído

Para deixar transparente:

- ❌ Você assinar o WhatsApp Business no seu nome (você já tem).
- ❌ Conta Google (necessária pra agenda — se o seu fluxo usa agenda).
- ❌ Atendimento humano. O bot atende, você (ou seu time) intervém quando quiser. Não temos call center.
- ❌ Conteúdo das mídias enviadas (vídeos, imagens, PDFs) — você fornece, a gente sobe no painel.

---

## 8. Cancelamento

A qualquer momento. Pedimos 30 dias de aviso pra:
- Devolver os dados de leads/agendamentos em planilha.
- Encerrar a sessão WAHA sem deixar a sua linha bloqueada.

Sem multa.

---

## 9. Próximo passo

Está pronto pra testar? Manda mensagem pra **nosso WhatsApp comercial** e a gente combina o número de teste do fluxo que faz sentido pra você.

> Pra contratar direto sem teste: também dá. A gente faz onboarding em 1 dia útil.

---

*Documento mantido pelo time de produto. Última atualização: 2026-05-17. Mudanças nesse texto passam pelo Bruno antes de ir pro ar.*
