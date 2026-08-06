-- ============================================================
-- rollback/007_wacrm_broadcasts.sql — DROP do que 007 adiciona
-- ============================================================
DO $$
BEGIN
  IF to_regclass('public.broadcast_recipients') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS broadcast_recipients_aggregate ON public.broadcast_recipients;
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.broadcast_recipient_aggregate_trigger();
DROP FUNCTION IF EXISTS public.recompute_broadcast_counts(uuid);
DROP FUNCTION IF EXISTS public._bcast_bump(uuid, text, integer);
DROP FUNCTION IF EXISTS public._bcast_cols_for_status(text);
