-- ============================================================
-- rollback/010_wacrm_ops.sql — DROP do que 010 adiciona
-- ============================================================
DROP TRIGGER IF EXISTS on_conversation_assigned ON conversations;
DROP FUNCTION IF EXISTS notify_conversation_assigned();
DROP FUNCTION IF EXISTS public.record_webhook_failure(uuid, integer);
