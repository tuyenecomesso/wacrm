-- ============================================================
-- 013_wacrm_local_media.sql
--
-- Local media metadata for MEDIA_ROOT-backed uploads.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS chat_media (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  text NOT NULL,
  path        text NOT NULL UNIQUE,
  url         text NOT NULL,
  mime_type   text,
  size_bytes  integer NOT NULL CHECK (size_bytes >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_media_account_created
  ON chat_media (account_id, created_at DESC);
