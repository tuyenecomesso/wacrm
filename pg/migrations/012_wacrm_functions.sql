-- ============================================================
-- 012_wacrm_functions.sql — functions domain completion
--
-- Every PL/pgSQL RPC that existed as a Supabase SECURITY DEFINER
-- function is already ported across the migration set:
--
--   * 003_wacrm_functions.sql  — increment_automation_execution_count,
--     increment_flow_execution_count, set_member_role,
--     remove_account_member, transfer_account_ownership,
--     peek_invitation, redeem_invitation, touch_presence,
--     filter_contacts_by_tags, match_ai_knowledge_fts,
--     match_ai_knowledge_semantic, claim_ai_reply_slot
--   * 005_wacrm_crm.sql        — merge_duplicate_contacts
--   * 007_wacrm_broadcasts.sql — _bcast_bump, _bcast_cols_for_status,
--     broadcast_recipient_aggregate_trigger, recompute_broadcast_counts
--   * 010_wacrm_ops.sql        — notify_conversation_assigned,
--     record_webhook_failure
--
-- Functions that existed in Supabase but are intentionally NOT ported
-- (direct-PG model):
--   * is_account_member / enforce_profile_privilege_columns —
--     RLS helpers that derive identity from auth.uid(); tenancy and
--     role checks live in the app layer (src/lib/auth, src/lib/api-keys)
--   * handle_new_user — auth.users signup trigger
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE '012_wacrm_functions: all PL/pgSQL RPCs ported across 003/005/007/010 — nothing to add';
END $$;
