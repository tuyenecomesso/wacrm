-- ============================================================
-- 010_wacrm_ops.sql — operations domain completion
--
-- api_keys, notifications, member_presence and webhook_endpoints were
-- already ported in 002_wacrm_business_tables.sql; the presence and
-- api-key flows are served by `touch_presence` (003) and the app-layer
-- `src/lib/api-keys/` (see wacrm-api-key-security).
--
-- This file completes the domain with two ported functions:
--   * notify_conversation_assigned + on_conversation_assigned trigger
--     (supabase migration 027) — adapted for direct-PG: there is no
--     auth.uid()/session actor, so the notification is attributed to
--     the system (actor_user_id NULL) and the self-assignment skip is
--     dropped (the app layer decides whether to assign).
--   * record_webhook_failure (supabase migration 028) — atomic
--     consecutive-failure counter that auto-disables a dead endpoint.
--     The deliverer also keeps an app-layer equivalent in
--     src/lib/webhooks/pg-repo.ts; the SQL port is retained for parity
--     and ops use.
--
-- RLS policies / column grants and the supabase_realtime publication
-- are intentionally removed (direct-PG model).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 027 — notify on conversation assignment
-- ============================================================
CREATE OR REPLACE FUNCTION notify_conversation_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_contact_name TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.assigned_agent_id IS NULL THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.assigned_agent_id IS NULL
       OR NEW.assigned_agent_id IS NOT DISTINCT FROM OLD.assigned_agent_id THEN
      RETURN NEW;
    END IF;
  END IF;

  SELECT COALESCE(NULLIF(name, ''), phone) INTO v_contact_name
  FROM contacts WHERE id = NEW.contact_id;

  INSERT INTO notifications (
    account_id, user_id, type, conversation_id, contact_id,
    actor_user_id, title, body
  ) VALUES (
    NEW.account_id,
    NEW.assigned_agent_id,
    'conversation_assigned',
    NEW.id,
    NEW.contact_id,
    NULL, -- direct-PG: no session actor; attribute to the system
    'New conversation assigned',
    'You were assigned a conversation with ' || COALESCE(v_contact_name, 'a contact')
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never let a notification failure block the assignment itself.
  RAISE WARNING 'Failed to create assignment notification for conversation %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_conversation_assigned ON conversations;
CREATE TRIGGER on_conversation_assigned
  AFTER INSERT OR UPDATE OF assigned_agent_id ON conversations
  FOR EACH ROW EXECUTE FUNCTION notify_conversation_assigned();

-- ============================================================
-- 028 — atomic webhook failure counter + auto-disable
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_webhook_failure(
  endpoint_id uuid,
  max_failures int
)
RETURNS void AS $$
  UPDATE webhook_endpoints
  SET failure_count = failure_count + 1,
      is_active = CASE
        WHEN failure_count + 1 >= max_failures THEN false
        ELSE is_active
      END
  WHERE id = endpoint_id;
$$ LANGUAGE sql;
