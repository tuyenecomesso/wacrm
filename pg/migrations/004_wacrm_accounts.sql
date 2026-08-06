-- ============================================================
-- 004_wacrm_accounts.sql — accounts domain completion
--
-- The `accounts`, `account_invitations`, `account_role_enum`,
-- `profiles.account_id`/`account_role`/`beta_features` and the
-- `accounts.default_currency` column were already ported in
-- 002_wacrm_business_tables.sql; the member/invitation RPCs
-- (`set_member_role`, `remove_account_member`,
-- `transfer_account_ownership`, `peek_invitation`,
-- `redeem_invitation`) live in 003_wacrm_functions.sql.
--
-- This file is a completion marker for the accounts domain: nothing
-- is left to add. Kept so the 001–013 numbering stays contiguous and
-- the boot ledger records the accounts domain as migrated.
--
-- Supabase-only constructs intentionally removed (direct-PG model):
--   * RLS policies and `is_account_member(account_id, min_role)`
--     (auth.uid()/RLS helper — tenancy is app-layer via account_id)
--   * `handle_new_user` + `on_auth_user_created` trigger (auth.users)
--   * FKs to auth.users (audit columns are TEXT)
--   * realtime publication / storage schema
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- No-op guard: accounts domain is fully covered by 002/003. Re-runs
-- are free; the ledger ensures this file runs exactly once.
DO $$
BEGIN
  RAISE NOTICE '004_wacrm_accounts: accounts domain fully ported in 002/003 — nothing to add';
END $$;
