@AGENTS.md

## Development Workflow - Mandatory Completion Gate

After every non-trivial implementation, do not mark the work complete immediately. The following completion loop is mandatory:

1. Run the project verification commands relevant to the change (tests, lint, type checks, build, migrations, or static analysis).
2. Load and run the skill defined at workspace-root `.agents/skills/production-readiness-auditor/SKILL.md` against the complete implementation and its end-to-end flow.
3. Load and run the skill defined at workspace-root `.agents/skills/anti-overengineering-codex-skill/SKILL.md` to detect unnecessary abstractions, avoidable model calls, duplicated logic, excess context, cost, latency, or moving parts.
4. Treat every supported BLOCKER, HIGH, MEDIUM, failed check, missing critical test, and actionable simplification as implementation work. Fix it autonomously without asking the user for permission or confirmation.
5. Re-run the affected verification commands and both skills after the fixes. Continue the audit -> fix -> verify loop until all checks pass and both reviews are green, with no unresolved production blocker or actionable overengineering finding.
6. Only then mark the task, OpenSpec item, or change as completed. Never mark partial, failing, unaudited, or knowingly fragile work as done.

This gate runs automatically before completion; do not wait for the user to request it. If an external dependency, unavailable credential, or irreversible decision makes green status impossible, keep the work open and report the exact blocker instead of claiming completion.

## Current Operating Model

- `wacrm` is now treated as an `API-only` service layer.
- Authentication for supported API routes is bearer-key based:
  - public/admin keys: `Authorization: Bearer wacrm_live_...`
  - first-party webhook/integration keys: `Authorization: Bearer whsec_...`
- Direct PostgreSQL via `DATABASE_URL` is the source of truth. Do not add new Supabase reads/writes for active API work.
- Local media storage is rooted at `MEDIA_ROOT` and should be assumed to be a persistent writable volume in production.
- Schedule `GET /api/whatsapp/media/cleanup` weekly with `x-cron-secret: $AUTOMATION_CRON_SECRET`; it deletes only `chat_media` rows older than 30 days that are no longer referenced by `messages.media_url`.
- The old Next.js UI under `src/app/(auth)`, `src/app/(dashboard)`, `src/components/**`, and `src/hooks/**` is deprecated transition surface. Preserve buildability unless explicitly asked to remove it, but prefer API-layer work over UI work.
- When touching `/api/whatsapp/*`, preserve first-party webhook delivery behavior (`dispatchWebhookEvent`) and the bearer-auth contract consumed by the business-hub.

## Verification Commands

Run these from `wacrm/` when relevant:

- `npm.cmd run typecheck`
- `npm.cmd test`
- `npm.cmd run build`
- `npm.cmd run lint`
