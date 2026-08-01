-- ============================================================
-- 001_wacrm_core_tables.sql — wacrm on direct PostgreSQL (Koyeb)
--
-- Ported from wacrm/supabase/migrations 001, 013, 015, 028, 036
-- for the connection-flow E2E. Differences from the Supabase
-- originals:
--   * No `auth.users` FK: `created_by` / `user_id` are plain
--     `text` (nullable) audit columns.
--   * No `accounts` FK: `account_id` is `text`. First-party
--     integration (business-hub) uses the vanessa workspace UUID
--     as the account id, which does not exist as a row in wacrm's
--     own `accounts` table.
--   * No RLS: the direct-Postgres layer is service-role semantics;
--     access control lives in the app layer (shared secret /
--     integration bearer key).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       text NOT NULL,
  created_by       text,
  name             text,
  url              text NOT NULL,
  secret           text NOT NULL,             -- AES-256-GCM-encrypted HMAC signing secret
  events           text[] NOT NULL DEFAULT '{}',
  is_active        boolean NOT NULL DEFAULT true,
  bypass_ssrf      boolean NOT NULL DEFAULT false,
  last_delivery_at timestamptz,
  failure_count    integer NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_account_id_idx
  ON webhook_endpoints (account_id);

CREATE TABLE IF NOT EXISTS whatsapp_config (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             text NOT NULL UNIQUE,
  user_id                text,
  phone_number_id        text UNIQUE,
  waba_id                text,
  access_token           text,
  verify_token           text,
  status                 text,
  connected_at           timestamptz,
  registered_at          timestamptz,
  subscribed_apps_at     timestamptz,
  last_registration_error text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
