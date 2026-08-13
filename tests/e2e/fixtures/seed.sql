BEGIN;

INSERT INTO bot_config
  (slot, display_name, provider, model, temperature, horarios_funcionamento, servicos, personalizacao)
VALUES
  ('e2e_matriz', 'Matriz E2E', 'openai', 'gpt-e2e', 0.1,
   '{"seg":{"ativo":true,"inicio":"09:00","fim":"18:00"}}'::jsonb,
   '[{"nome":"Servico E2E","duracao_min":30,"preco":100}]'::jsonb,
   '{"nome_negocio":"Negocio E2E"}'::jsonb),
  ('e2e_tenant_a', 'Empresa homonima', 'openai', 'gpt-e2e', 0.1, NULL, NULL, NULL),
  ('e2e_tenant_b', 'Empresa homonima', 'deepseek', 'deepseek-chat', 0.1, NULL, NULL, NULL),
  ('e2e_overdue', 'Empresa overdue E2E', 'openai', 'gpt-e2e', 0.1, NULL, NULL, NULL),
  ('e2e_owner', 'Empresa owner E2E', 'openai', 'gpt-e2e', 0.1, NULL, NULL, NULL),
  ('e2e_billing', 'Empresa billing E2E', 'openai', 'gpt-e2e', 0.1, NULL, NULL, NULL)
ON CONFLICT (slot) DO NOTHING;

INSERT INTO bot_prompt (slot, prompt)
VALUES
  ('e2e_matriz', 'Voce atende em ambiente E2E isolado.'),
  ('e2e_tenant_a', 'Voce atende o tenant A no ambiente E2E.'),
  ('e2e_tenant_b', 'Voce atende o tenant B no ambiente E2E.'),
  ('e2e_overdue', 'Voce atende o tenant overdue no ambiente E2E.'),
  ('e2e_owner', 'Voce atende o tenant owner no ambiente E2E.'),
  ('e2e_billing', 'Voce atende o tenant billing no ambiente E2E.')
ON CONFLICT (slot) DO UPDATE SET prompt = EXCLUDED.prompt;

INSERT INTO flow_clones
  (slot, matriz_slot, display_name, cliente_nome, personalizacao, waha_sessao, status,
   flow_enabled, suspended_kind, suspended_reason, modo_atendente_enabled)
VALUES
  ('e2e_tenant_a', 'e2e_matriz', 'Empresa homonima', 'Cliente E2E',
   '{"agenda_automatica":false,"nome_negocio":"Empresa homonima"}'::jsonb,
   'e2e_session_a', 'active', true, NULL, NULL, true),
  ('e2e_tenant_b', 'e2e_matriz', 'Empresa homonima', 'Cliente E2E',
   '{"agenda_automatica":false,"nome_negocio":"Empresa homonima"}'::jsonb,
   'e2e_session_b', 'active', true, NULL, NULL, true),
  ('e2e_overdue', 'e2e_matriz', 'Empresa overdue E2E', 'Cliente E2E',
   '{"agenda_automatica":false}'::jsonb,
   'e2e_session_overdue', 'active', true, NULL, NULL, true),
  ('e2e_owner', 'e2e_matriz', 'Empresa owner E2E', 'Cliente E2E',
   '{"agenda_automatica":false}'::jsonb,
   'e2e_session_owner', 'active', false, 'owner_request', 'Pausa E2E do dono', true),
  ('e2e_billing', 'e2e_matriz', 'Empresa billing E2E', 'Cliente E2E',
   '{"agenda_automatica":false}'::jsonb,
   'e2e_session_billing', 'active', false, 'billing', 'Suspensao E2E billing', true)
ON CONFLICT (slot) DO NOTHING;

INSERT INTO client_billing (slot, next_due_date, amount_cents, last_payment_at, status)
VALUES
  ('e2e_tenant_a', CURRENT_DATE + 30, 10000, NOW(), 'active'),
  ('e2e_tenant_b', CURRENT_DATE + 30, 10000, NOW(), 'active'),
  ('e2e_overdue', CURRENT_DATE - 10, 10000, NOW() - INTERVAL '40 days', 'overdue'),
  ('e2e_owner', CURRENT_DATE - 10, 10000, NOW() - INTERVAL '40 days', 'overdue'),
  ('e2e_billing', CURRENT_DATE - 10, 10000, NOW() - INTERVAL '40 days', 'suspended')
ON CONFLICT (slot) DO NOTHING;

INSERT INTO billing_charges
  (slot, cycle, external_id, abacate_charge_id, amount_cents, status, expires_at)
VALUES
  ('e2e_owner', '2099-01-01', 'e2e_owner-2099-01-01', 'pix_e2e_owner', 10000, 'pending', NOW() + INTERVAL '1 day'),
  ('e2e_billing', '2099-01-01', 'e2e_billing-2099-01-01', 'pix_e2e_billing', 10000, 'pending', NOW() + INTERVAL '1 day');

INSERT INTO flow_execution_logs
  (execution_id, flow_id, flow_name, bot, session, event_type, status, message, created_at)
VALUES
  ('00000000-0000-4000-8000-000000000171', 'e2e_tenant_a', 'Empresa homonima',
   'e2e_tenant_a', 'e2e_worker_probe', 'e2e.worker-stale', 'running',
   'Marcador sintetico para job deterministico E2E', NOW() - INTERVAL '10 minutes');

COMMIT;
