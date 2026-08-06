-- ============================================================
-- 008_wacrm_flows.sql — flows domain completion
--
-- flows, flow_nodes (incl. send_media node_type), flow_runs,
-- flow_run_events and the flow-media storage concept were already
-- ported in 002_wacrm_business_tables.sql; `increment_flow_execution_
-- count` lives in 003_wacrm_functions.sql.
--
-- This file is a completion marker for the flows domain: nothing is
-- left to add. Kept so the 001–013 numbering stays contiguous and the
-- boot ledger records the flows domain as migrated.
--
-- Supabase-only constructs intentionally removed (direct-PG model):
--   * flow-media storage bucket + RLS — media goes to local MEDIA_ROOT
--     (see wacrm-local-media-store)
--   * realtime publication
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE '008_wacrm_flows: flows domain fully ported in 002/003 — nothing to add';
END $$;
