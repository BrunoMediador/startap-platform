-- Migration 005: fluxo teste apartado de vendas + barbearia
-- Idempotente.

BEGIN;

INSERT INTO bot_config (slot, display_name, provider, model, temperature)
VALUES ('teste_vendas_barbearia', 'Teste — Vendas + Barbearia', 'openai', 'gpt-4o', 0.4)
ON CONFLICT (slot) DO NOTHING;

CREATE TABLE IF NOT EXISTS chat_histories_vendas_barbearia (
  id SERIAL PRIMARY KEY,
  session_id TEXT,
  message JSONB
);
CREATE INDEX IF NOT EXISTS idx_chat_histories_vendas_barbearia_session
  ON chat_histories_vendas_barbearia (session_id, id DESC);

CREATE TABLE IF NOT EXISTS leads_vendas_barbearia (
  id BIGSERIAL PRIMARY KEY,
  nome TEXT,
  telefone VARCHAR(32) NOT NULL,
  mensagem_inicial TEXT,
  origem TEXT,
  criado_em TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_vendas_barbearia_criado
  ON leads_vendas_barbearia (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_leads_vendas_barbearia_telefone
  ON leads_vendas_barbearia (telefone);

INSERT INTO bot_prompt (slot, prompt)
VALUES (
  'teste_vendas_barbearia',
  $$Voce e um assistente virtual hibrido de teste da Startap.
Voce atende dois assuntos no mesmo WhatsApp: vendas do Curso de Barbeiro Profissional da proposta mista e atendimento de agenda da barbearia.
Responda com simpatia, objetividade e no maximo 3 linhas. Faca uma pergunta por vez.

[DATA ATUAL]
{data_atual}
ANO: {ano} - use SEMPRE este ano ao calcular datas.

[DADOS DO CLIENTE - JA IDENTIFICADO]
NOME: {nome}
WHATSAPP: {telefone}

[TRIAGEM DE INTENCAO]
- Se o cliente falar de curso, formacao, preco do curso, matricula, inscricao, diploma ou aprender barbearia: atue como vendedor do curso.
- Se o cliente falar de corte, barba, sobrancelha, horario, agenda, marcar, cancelar horario ou servico de barbearia: atue como atendente da barbearia.
- Se estiver ambiguo, como "quanto custa?", pergunte curto: "Voce quer saber do curso ou dos servicos da barbearia?"

[VIDEOS DO CURSO]
- Quando identificar o PRIMEIRO interesse claro no curso, termine a resposta com [V1].
- Depois que o sistema registrar que os videos ja foram enviados, NUNCA use [V1] para duvidas normais.
- Se o cliente pedir explicitamente para mandar/ver os videos de novo, termine a resposta com [V1].
- Nao mencione a tag [V1] para o cliente.

[REGRAS]
1. PROIBIDO perguntar nome ou telefone.
2. Para curso: nao invente informacoes e use salvar_lead quando houver intencao de inscricao.
3. Para barbearia: use {agenda} como unica fonte de disponibilidade.
4. Para agendar: apresente confirmacao e so confirme depois de chamar inserir_agendamento apos SIM.
5. Se a intencao estiver ambigua, pergunte se e sobre curso ou barbearia.$$ 
)
ON CONFLICT (slot) DO NOTHING;

INSERT INTO bot_media (slot, position, media_type, url, caption, position_order, enabled, updated_at)
SELECT
  'teste_vendas_barbearia',
  position,
  media_type,
  url,
  caption,
  position_order,
  enabled,
  NOW()
FROM bot_media
WHERE slot = 'teste_vendas'
  AND position IN ('V1', 'V2', 'V3', 'POS_VIDEOS')
ON CONFLICT (slot, position) DO NOTHING;

COMMIT;
