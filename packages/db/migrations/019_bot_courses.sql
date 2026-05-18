-- Migration 019: tabela bot_courses + vínculos em bot_media + seed de cursos.
-- Idempotente: usa IF NOT EXISTS, ON CONFLICT DO NOTHING / DO UPDATE.
-- ATENÇÃO: CREATE UNIQUE INDEX CONCURRENTLY não pode rodar dentro de BEGIN/COMMIT.
-- Por isso o index parcial é criado fora do bloco de transação principal.

-- ============================================================
-- 1. Tabela bot_courses (catálogo multi-tenant de cursos)
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_courses (
  id             BIGSERIAL    PRIMARY KEY,
  slot           VARCHAR(80)  NOT NULL,
  course_slug    VARCHAR(120) NOT NULL,
  name           VARCHAR(200) NOT NULL,
  description    TEXT,
  price          INTEGER      NOT NULL DEFAULT 0,  -- centavos
  duration       TEXT,
  position_order INTEGER      NOT NULL DEFAULT 0,
  enabled        BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_bot_courses_slot_slug UNIQUE (slot, course_slug)
);

CREATE INDEX IF NOT EXISTS idx_bot_courses_slot ON bot_courses(slot);

-- ============================================================
-- 2. Colunas adicionais em bot_media
-- ============================================================
ALTER TABLE bot_media
  ADD COLUMN IF NOT EXISTS course_slug    TEXT,
  ADD COLUMN IF NOT EXISTS is_course_intro BOOLEAN NOT NULL DEFAULT FALSE;

-- Constraint: course_slug implica media_type = 'video'
-- Só adiciona se ainda não existir (verifica no catálogo de constraints)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'chk_course_slug_video'
      AND conrelid = 'bot_media'::regclass
  ) THEN
    ALTER TABLE bot_media
      ADD CONSTRAINT chk_course_slug_video
      CHECK (course_slug IS NULL OR media_type = 'video');
  END IF;
END;
$$;

-- ============================================================
-- 3. Seed: cursos de teste_vendas_barbearia
-- ============================================================
INSERT INTO bot_courses (slot, course_slug, name, description, price, duration, position_order, enabled)
VALUES
  (
    'teste_vendas_barbearia',
    'curso-online-degrade',
    'Curso de Degradê Online',
    'Do zero ao avançado. Suporte VIP via WhatsApp, certificado nacional, acesso imediato, pagamento único com parcelamento facilitado.',
    29700,
    NULL,
    10,
    TRUE
  ),
  (
    'teste_vendas_barbearia',
    'curso-presencial-barbearia',
    'Curso Presencial de Barbearia',
    'Curso presencial com prática supervisionada. Inclui certificado de capacitação profissional e formatura ao final.',
    150000,
    NULL,
    20,
    TRUE
  )
ON CONFLICT (slot, course_slug) DO NOTHING;

-- ============================================================
-- 4. Seed: vínculo de bot_media com cursos
-- ============================================================
UPDATE bot_media
SET
  course_slug     = 'curso-online-degrade',
  is_course_intro = TRUE,
  updated_at      = NOW()
WHERE slot = 'teste_vendas_barbearia'
  AND position = 'online_degrade_apresentacao'
  AND (course_slug IS DISTINCT FROM 'curso-online-degrade' OR is_course_intro IS DISTINCT FROM TRUE);

UPDATE bot_media
SET
  course_slug     = 'curso-presencial-barbearia',
  is_course_intro = TRUE,
  updated_at      = NOW()
WHERE slot = 'teste_vendas_barbearia'
  AND position = 'presencial_alunos_formados'
  AND (course_slug IS DISTINCT FROM 'curso-presencial-barbearia' OR is_course_intro IS DISTINCT FROM TRUE);

UPDATE bot_media
SET
  course_slug     = 'curso-presencial-barbearia',
  is_course_intro = FALSE,
  updated_at      = NOW()
WHERE slot = 'teste_vendas_barbearia'
  AND position = 'presencial_alunos_cortando'
  AND (course_slug IS DISTINCT FROM 'curso-presencial-barbearia' OR is_course_intro IS DISTINCT FROM FALSE);

-- demo_corte_degrade_1 e demo_corte_degrade_2 ficam sem course_slug (vídeos livres/contextuais)
-- Nenhuma ação necessária: padrão já é NULL / FALSE.

-- ============================================================
-- 5. Unique partial index: garante 1 intro por (slot, course_slug)
-- CREATE UNIQUE INDEX CONCURRENTLY não aceita transação — roda fora do BEGIN.
-- Idempotente via IF NOT EXISTS.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_media_course_intro
  ON bot_media (slot, course_slug)
  WHERE is_course_intro = TRUE;
