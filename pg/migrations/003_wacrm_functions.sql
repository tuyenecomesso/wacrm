-- ============================================================
-- 003_wacrm_functions.sql — wacrm RPCs on direct PostgreSQL
--
-- Rewritten from the Supabase RPCs (migrations 007, 012, 018,
-- 019, 020, 024, 025, 030, 031). Supabase-only constructs removed:
--   * SECURITY DEFINER / SET search_path dropped (service-role
--     semantics; access control lives in the app layer)
--   * caller identity derived from the session JWT replaced by
--     explicit scope parameters (p_account_id / p_user_id /
--     p_acting_user_id, all TEXT — SSO identifiers, not
--     necessarily UUIDs)
--   * account_id columns are TEXT (see 002), so joins against
--     accounts.id / account_invitations.account_id cast to uuid
--
-- All functions preserve the original validation logic, error
-- SQLSTATEs (42501 forbidden / 22023 invalid input) and return
-- types. Idempotent via CREATE OR REPLACE.
-- ============================================================

-- ============================================================
-- increment_automation_execution_count (007)
-- Atomic increment of automations.execution_count.
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_automation_execution_count(p_automation_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE automations
  SET
    execution_count = execution_count + 1,
    last_executed_at = NOW()
  WHERE id = p_automation_id;
$$;

-- ============================================================
-- increment_flow_execution_count (012)
-- Atomic increment of flows.execution_count.
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_flow_execution_count(p_flow_id UUID)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE flows
  SET
    execution_count = execution_count + 1,
    last_executed_at = NOW()
  WHERE id = p_flow_id;
$$;

-- ============================================================
-- set_member_role (018)
-- Admin+ changes another member's role within the caller's
-- account. Cannot promote/demote to/from owner. Cannot target
-- self. p_role is a text enum value ('owner'|'admin'|'agent'|
-- 'viewer') validated below.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_account_id TEXT,
  p_target_user_id TEXT,
  p_role TEXT,
  p_acting_user_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caller_role account_role_enum;
  v_target_account_id TEXT;
  v_target_role account_role_enum;
BEGIN
  -- Acting user must be a member of the target account.
  SELECT account_role
  INTO v_caller_role
  FROM profiles
  WHERE user_id = p_acting_user_id
    AND account_id = p_account_id;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_target_user_id = p_acting_user_id THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_target_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> p_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;

  IF p_role NOT IN ('owner', 'admin', 'agent', 'viewer') THEN
    RAISE EXCEPTION 'Invalid role: %', p_role USING ERRCODE = '22023';
  END IF;

  IF p_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET account_role = p_role::account_role_enum
  WHERE user_id = p_target_user_id;
END;
$$;

-- ============================================================
-- remove_account_member (018)
-- Admin+ removes another member. The removed user keeps their
-- login; a fresh personal account is created and their profile
-- reassigned to it as 'owner'. Cannot target the owner or self.
-- Returns the new personal account id.
-- ============================================================
CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_account_id TEXT,
  p_target_user_id TEXT,
  p_acting_user_id TEXT
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caller_role account_role_enum;
  v_target_account_id TEXT;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
BEGIN
  SELECT account_role
  INTO v_caller_role
  FROM profiles
  WHERE user_id = p_acting_user_id
    AND account_id = p_account_id;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'This action requires the admin role or higher'
      USING ERRCODE = '42501';
  END IF;

  IF p_target_user_id = p_acting_user_id THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_target_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> p_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_target_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
  SET account_id = v_new_account_id::text,
      account_role = 'owner'
  WHERE user_id = p_target_user_id;

  RETURN v_new_account_id;
END;
$$;

-- ============================================================
-- transfer_account_ownership (018)
-- Owner only. Atomically demotes the current owner to 'admin',
-- promotes the target to 'owner', and updates accounts.
-- ============================================================
CREATE OR REPLACE FUNCTION public.transfer_account_ownership(
  p_account_id TEXT,
  p_new_owner_id TEXT,
  p_acting_user_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caller_role account_role_enum;
  v_target_account_id TEXT;
  v_target_role account_role_enum;
BEGIN
  SELECT account_role
  INTO v_caller_role
  FROM profiles
  WHERE user_id = p_acting_user_id
    AND account_id = p_account_id;

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'Only the account owner can transfer ownership'
      USING ERRCODE = '42501';
  END IF;

  IF p_new_owner_id = p_acting_user_id THEN
    RAISE EXCEPTION 'You are already the owner'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_new_owner_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> p_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  UPDATE profiles SET account_role = 'admin'
  WHERE user_id = p_acting_user_id;

  UPDATE profiles SET account_role = 'owner'
  WHERE user_id = p_new_owner_id;

  UPDATE accounts SET owner_user_id = p_new_owner_id
  WHERE id = p_account_id::uuid;
END;
$$;

-- ============================================================
-- peek_invitation (019)
-- Anonymous read by token (the plaintext token is hashed by the
-- route before reaching the DB; here p_token is the hash).
-- Returns { ok, reason?, account_name?, role?, expires_at? }.
-- ============================================================
CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id::uuid;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'expires_at', v_inv.expires_at
  );
END;
$$;

-- ============================================================
-- redeem_invitation (019)
-- Authenticated. Atomically moves the caller's profile to the
-- inviter's account, marks the invitation accepted and deletes
-- the orphan personal account (only when it is ownerless-and-
-- empty, verified below). Returns the joined account_id.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token TEXT,
  p_user_id TEXT
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_caller_id TEXT := p_user_id;
  v_inv account_invitations%ROWTYPE;
  v_old_account_id TEXT;
  v_old_account_owner TEXT;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id::uuid
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id::uuid;

  RETURN v_inv.account_id::uuid;
END;
$$;

-- ============================================================
-- touch_presence (024)
-- Upserts the caller's member_presence row. The account and user
-- are explicit caller parameters (no session-JWT derivation).
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_presence(
  p_account_id TEXT,
  p_user_id TEXT,
  p_status TEXT
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_status NOT IN ('online', 'away') THEN
    RAISE EXCEPTION 'Invalid presence status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES (p_user_id, p_account_id, p_status, now())
  ON CONFLICT (user_id) DO UPDATE
    SET status       = excluded.status,
        last_seen_at = now(),
        account_id   = excluded.account_id;
END;
$$;

-- ============================================================
-- filter_contacts_by_tags (025)
-- Distinct contacts having ANY of the selected tags (OR),
-- with the same name/phone/email search as the list page,
-- windowed total count, LIMIT/OFFSET in one query. Scoped to
-- the caller's account via p_account_id (RLS-free model).
-- ============================================================
CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_account_id TEXT,
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE c.account_id = p_account_id
      AND ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

-- ============================================================
-- match_ai_knowledge_fts (030/032)
-- Lexical full-text retrieval over ai_knowledge_chunks, scoped
-- to the caller's account (p_account_id).
-- ============================================================
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_fts(
  p_account_id  TEXT,
  p_query       text,
  p_match_count integer
)
RETURNS TABLE (id uuid, content text, rank real) AS $$
  SELECT c.id,
         c.content,
         ts_rank(c.fts, plainto_tsquery('simple', p_query)) AS rank
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.fts @@ plainto_tsquery('simple', p_query)
  ORDER BY rank DESC
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE;

-- ============================================================
-- match_ai_knowledge_semantic (030/032)
-- Semantic (pgvector) retrieval. p_query_embedding is the
-- canonical pgvector literal "[0.1,0.2,...]" passed as text and
-- cast inside so node-pg binds it unambiguously; the HNSW index
-- serves the <=> order-by.
-- ============================================================
CREATE OR REPLACE FUNCTION public.match_ai_knowledge_semantic(
  p_account_id      TEXT,
  p_query_embedding text,
  p_match_count     integer
)
RETURNS TABLE (id uuid, content text, distance real) AS $$
  SELECT c.id,
         c.content,
         (c.embedding <=> p_query_embedding::vector(1536)) AS distance
  FROM ai_knowledge_chunks c
  WHERE c.account_id = p_account_id
    AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> p_query_embedding::vector(1536)
  LIMIT GREATEST(p_match_count, 0);
$$ LANGUAGE sql STABLE;

-- ============================================================
-- claim_ai_reply_slot (029)
-- Atomically claims one auto-reply slot on a conversation: the
-- cap check and the +1 happen in a single UPDATE, so exactly
-- max_replies slots can ever be claimed. Returns true when a
-- slot was claimed, false when the cap is reached. Scoped to
-- the caller's account (p_account_id).
-- ============================================================
CREATE OR REPLACE FUNCTION public.claim_ai_reply_slot(
  p_account_id TEXT,
  p_conversation_id uuid,
  p_max_replies integer
)
RETURNS boolean AS $$
  WITH claimed AS (
    UPDATE conversations
    SET ai_reply_count = ai_reply_count + 1
    WHERE id = p_conversation_id
      AND account_id = p_account_id
      AND ai_reply_count < p_max_replies
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM claimed);
$$ LANGUAGE sql;
