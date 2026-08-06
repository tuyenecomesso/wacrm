-- ============================================================
-- 009_wacrm_automations.sql — automations domain completion
--
-- automations, automation_steps, automation_logs,
-- automation_pending_executions were already ported in
-- 002_wacrm_business_tables.sql; `increment_automation_execution_
-- count` lives in 003_wacrm_functions.sql.
--
-- This file is a completion marker for the automations domain:
-- nothing is left to add. Kept so the 001–013 numbering stays
-- contiguous and the boot ledger records the automations domain as
-- migrated.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE '009_wacrm_automations: automations domain fully ported in 002/003 — nothing to add';
END $$;
