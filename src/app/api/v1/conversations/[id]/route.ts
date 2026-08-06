// ============================================================
// GET /api/v1/conversations/{id} — read one conversation
// (scope: conversations:read). Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getConversationById, serializeConversation } from '@/lib/api/v1/conversations';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;
    const conversation = await getConversationById(ctx.accountId, id);
    if (!conversation) return fail('not_found', 'Conversation not found', 404);
    return ok(serializeConversation(conversation));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
