// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Keyset-paginated (newest first). Filters: `?status=` (open/pending/
// closed) and `?contact_id=`. Each conversation embeds its contact +
// tags via the shared CONVERSATION_SELECT.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  buildPage,
} from '@/lib/api/v1/pagination';
import { getConversationById, listConversations, serializeConversation } from '@/lib/api/v1/conversations';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');

    const { items, nextCursor } = buildPage(
      await listConversations({
        accountId: ctx.accountId,
        limit,
        cursor,
        status,
        contactId,
      }),
      limit
    );
    return okList(items.map((r) => serializeConversation(r)), nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
