-- ============================================================
-- 006_wacrm_messaging.sql — messaging domain completion
--
-- conversations, messages, message_reactions, message_templates and
-- quick_replies were already ported in 002_wacrm_business_tables.sql,
-- including the messaging-specific columns:
--   * messages.reply_to_message_id, interactive_reply_id,
--     interactive_payload, ai_generated
--   * conversations.unread_count, ai_autoreply_disabled,
--     ai_reply_count, ai_handoff_summary
--   * message_templates.* Meta-integration columns + status check
--   * quick_replies (text/interactive) with interactive_payload
--
-- This file is a completion marker for the messaging domain: nothing
-- is left to add. Kept so the 001–013 numbering stays contiguous and
-- the boot ledger records the messaging domain as migrated.
--
-- Supabase-only constructs intentionally removed (direct-PG model):
--   * storage buckets (chat-media) — media goes to local MEDIA_ROOT
--     (see wacrm-local-media-store)
--   * realtime publication
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE '006_wacrm_messaging: messaging domain fully ported in 002 — nothing to add';
END $$;
