-- ============================================================
-- 036_webhook_endpoints_bypass_ssrf.sql — first-party integration
-- support via webhook_endpoints.
--
-- Instead of a separate `integrations` table, first-party
-- integrations use a `bypass_ssrf` flag on `webhook_endpoints`.
-- This lets the existing delivery pipeline handle both public
-- webhooks and trusted internal integrations without duplicating
-- the dispatch logic, the failure-counting RPC, or the RLS model.
--
-- Changes
--   1. `name` — optional human label (e.g. "business-hub-prod").
--   2. `bypass_ssrf` — when true, the SSRF guard is skipped so
--      the URL may point to private / loopback addresses.
--
-- The `record_webhook_failure` RPC from migration 028 handles
-- both use cases — no new RPC is needed.
-- ============================================================

ALTER TABLE webhook_endpoints
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS bypass_ssrf boolean NOT NULL DEFAULT false;
