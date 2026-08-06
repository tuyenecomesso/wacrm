-- ============================================================
-- 014_wacrm_webhook_idempotency.sql
--
-- Adds the uniqueness guarantees needed by inbound webhook upserts:
--   * one conversation per (account_id, contact_id)
--   * one stored Meta wamid per conversation
--
-- Idempotent and safe to re-run.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON conversations (account_id, contact_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_message_id
  ON messages (conversation_id, message_id)
  WHERE message_id IS NOT NULL;
