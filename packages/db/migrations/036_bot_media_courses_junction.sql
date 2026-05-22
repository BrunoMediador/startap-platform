-- Migration 036: tabela de junção bot_media_courses (N:N entre mídia e curso, por clone)
-- + coluna title em bot_media (renomear mídia na galeria)
-- + migração de dados de bot_media.course_slug → bot_media_courses
-- Idempotente: usa IF NOT EXISTS, ON CONFLICT DO NOTHING.
-- ATENÇÃO: colunas course_slug e is_course_intro em bot_media NÃO são removidas aqui
--   (fase 2 fará o cutover; código atual ainda as usa diretamente).
-- ATENÇÃO: o único índice parcial (idx_bot_media_courses_unique_intro) usa CREATE UNIQUE INDEX
--   fora de transação porque CONCURRENTLY não é compatível com BEGIN/COMMIT.

-- ============================================================
-- 1. Coluna title em bot_media (editável pelo operador na galeria)
-- ============================================================
BEGIN;

ALTER TABLE bot_media
  ADD COLUMN IF NOT EXISTS title VARCHAR(200);

-- Popula title com fallback: position (já existente) ou 'media_<id>'
UPDATE bot_media
   SET title = COALESCE(title, position)
 WHERE title IS NULL;

-- Marca colunas legadas como deprecated para sinalizar a fase 2
COMMENT ON COLUMN bot_media.course_slug IS
  'DEPRECATED (Migration 036): substituída por bot_media_courses.course_slug. Remover na fase 2.';

COMMENT ON COLUMN bot_media.is_course_intro IS
  'DEPRECATED (Migration 036): substituída por bot_media_courses.is_intro. Remover na fase 2.';

COMMENT ON COLUMN bot_media.title IS
  'Título exibível da mídia na galeria do painel. Editável pelo operador via PUT /gallery/:id/rename.';

-- ============================================================
-- 2. Tabela de junção bot_media_courses (N:N por clone)
-- ============================================================
CREATE TABLE IF NOT EXISTS bot_media_courses (
  id             SERIAL       PRIMARY KEY,
  slot           VARCHAR(50)  NOT NULL,
  media_id       INTEGER      NOT NULL REFERENCES bot_media(id) ON DELETE CASCADE,
  course_slug    VARCHAR(100) NOT NULL,
  is_intro       BOOLEAN      NOT NULL DEFAULT FALSE,
  position_order INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMP    DEFAULT NOW(),
  CONSTRAINT uq_bot_media_courses_slot_media_course UNIQUE (slot, media_id, course_slug),
  CONSTRAINT fk_bot_media_courses_course
    FOREIGN KEY (slot, course_slug) REFERENCES bot_courses(slot, course_slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bot_media_courses_slot_course
  ON bot_media_courses (slot, course_slug);

CREATE INDEX IF NOT EXISTS idx_bot_media_courses_media
  ON bot_media_courses (media_id);

-- ============================================================
-- 3. Migração de dados: bot_media.course_slug → bot_media_courses
-- Copia apenas registros onde course_slug não é NULL.
-- ON CONFLICT DO NOTHING: idempotente caso migration rode mais de uma vez.
-- ============================================================
INSERT INTO bot_media_courses (slot, media_id, course_slug, is_intro, position_order, created_at)
SELECT
  bm.slot,
  bm.id,
  bm.course_slug,
  COALESCE(bm.is_course_intro, FALSE),
  COALESCE(bm.position_order, 0),
  COALESCE(bm.updated_at, NOW())
FROM bot_media bm
WHERE bm.course_slug IS NOT NULL
  AND EXISTS (
    -- Garante que o curso ainda existe (FK; curso pode ter sido deletado sem cascade)
    SELECT 1 FROM bot_courses bc
     WHERE bc.slot = bm.slot AND bc.course_slug = bm.course_slug
  )
ON CONFLICT (slot, media_id, course_slug) DO NOTHING;

COMMIT;

-- ============================================================
-- 4. Índice único parcial: apenas UMA mídia is_intro=true por (slot, course_slug)
-- CREATE UNIQUE INDEX não aceita transação explícita — executa fora do BEGIN/COMMIT.
-- Idempotente via IF NOT EXISTS.
-- ============================================================
CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_media_courses_unique_intro
  ON bot_media_courses (slot, course_slug)
  WHERE is_intro = TRUE;
