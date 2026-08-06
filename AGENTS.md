<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes â€” APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## wacrm Status

- `wacrm` should be treated as `API-only` for active implementation work.
- Preferred auth path is bearer key auth through `Authorization: Bearer ...`:
  - `wacrm_live_...` for account-scoped API keys
  - `whsec_...` for first-party webhook/integration callers
- Preferred data path is direct PostgreSQL through `pg` and `DATABASE_URL`.
- `MEDIA_ROOT` is the local media storage root; production assumes a mounted persistent volume.
- Schedule `GET /api/whatsapp/media/cleanup` weekly with `x-cron-secret: $AUTOMATION_CRON_SECRET`; it deletes only `chat_media` rows older than 30 days that are no longer referenced by `messages.media_url`.
- The legacy browser UI remains in the repo as deprecated transition surface. Keep it buildable unless the task explicitly targets removal, but do not reintroduce Supabase as an implementation dependency for new server/API work.
