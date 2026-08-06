-- ============================================================
-- 011_wacrm_ai.sql — AI domain completion
--
-- ai_configs, ai_knowledge_documents, ai_knowledge_chunks (incl.
-- pgvector embedding + HNSW index), ai_usage_log were already ported
-- in 002_wacrm_business_tables.sql; `match_ai_knowledge_fts`,
-- `match_ai_knowledge_semantic` and `claim_ai_reply_slot` live in
-- 003_wacrm_functions.sql. The AI auto-reply context is built in the
-- app layer (src/lib/ai/context.ts) against these tables.
--
-- This file is a completion marker for the AI domain: nothing is left
-- to add. Kept so the 001–013 numbering stays contiguous and the boot
-- ledger records the AI domain as migrated.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

DO $$
BEGIN
  RAISE NOTICE '011_wacrm_ai: AI domain fully ported in 002/003 — nothing to add';
END $$;
