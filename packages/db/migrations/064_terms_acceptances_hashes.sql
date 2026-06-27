-- Migration 064: terms_acceptances.terms_hash / privacy_hash — HASH DE PROVA do conteúdo
-- legal aceito (SCRUM-31 / ADR 0029, complementa a 063 / PR #391).
--
-- POR QUÊ: a prova de aceite (063) já guarda a VERSÃO ('v1'), mas a versão sozinha não
-- prova QUE TEXTO foi aceito — editar o texto de uma versão sem bumpar não muda a versão.
-- O sha256(conteúdo canônico + versão) é a impressão digital imutável do texto exato:
--   - terms_hash   : sha256 do conteúdo canônico dos Termos aceitos (server-authoritative,
--                    de apps/portal-api/src/lib/legal-version.ts:TERMS_HASH).
--   - privacy_hash : idem para a Política de Privacidade (PRIVACY_HASH).
-- Dá tamper-evidence (detecta drift de texto sem bump) e permite verificar a prova contra
-- um texto arquivado. Não é dado pessoal — é hash de documento PÚBLICO; sem risco LGPD.
--
-- FORWARD-ONLY (decisão SCRUM-31): NULLABLE de propósito. Aceites ANTIGOS (gravados antes
-- desta release, ex.: o do clone_barber_dragon_caly8b) ficam com hash NULL — SEM backfill
-- e SEM forçar re-aceite. Só aceites NOVOS carregam o hash. NULL = "aceite pré-hash".
--
-- ISOLAMENTO / multi-tenancy (regra de ouro 5): colunas moram em terms_acceptances, que já
-- carrega slot + tenant_id (063). Aditivo puro — não toca a dívida P0 de multi-tenancy.
--
-- ADITIVA: só ADD COLUMN. SEM backfill, SEM tocar linha/coluna existente, SEM DROP/DELETE.
--   Nenhum cliente atual afetado (aceites existentes seguem válidos, só sem hash).
-- Idempotente: ADD COLUMN IF NOT EXISTS. Re-rodar é no-op.
-- NÃO destrutiva: nada removido; nenhuma coluna dropada na mesma release que adiciona.
--
-- ── ROLLBACK (rodar manualmente; RELEASE SEPARADA — regra de ouro 9; só com aprovação
--    explícita do Bruno) ──────────────────────────────────────────────────────────────
--   BEGIN;
--     ALTER TABLE terms_acceptances DROP COLUMN IF EXISTS privacy_hash;
--     ALTER TABLE terms_acceptances DROP COLUMN IF EXISTS terms_hash;
--   COMMIT;
--   → as colunas somem; o resto da prova (slot/versões/ip/ua) fica idêntico.
-- ───────────────────────────────────────────────────────────────────────────────────

BEGIN;

-- sha256 hex (64 chars) do conteúdo canônico dos Termos aceitos. NULL = aceite pré-hash.
ALTER TABLE terms_acceptances ADD COLUMN IF NOT EXISTS terms_hash   TEXT;
-- sha256 hex (64 chars) do conteúdo canônico da Política aceita. NULL = aceite pré-hash.
ALTER TABLE terms_acceptances ADD COLUMN IF NOT EXISTS privacy_hash TEXT;

COMMENT ON COLUMN terms_acceptances.terms_hash IS
  'sha256(conteúdo canônico + versão) dos Termos aceitos (SCRUM-31). Server-authoritative; '
  'NULL = aceite gravado antes da feature de hash (forward-only, sem backfill).';
COMMENT ON COLUMN terms_acceptances.privacy_hash IS
  'sha256(conteúdo canônico + versão) da Política aceita (SCRUM-31). Server-authoritative; '
  'NULL = aceite gravado antes da feature de hash (forward-only, sem backfill).';

COMMIT;
