import { describe, expect, it } from 'vitest';

import { resolveConversationByPhone } from './resolve-conversation';
import { SendMessageError } from './send-message';

describe('resolveConversationByPhone', () => {
  it('rejects an invalid phone before any DB call', async () => {
    await expect(
      resolveConversationByPhone('acct', 'not-a-phone')
    ).rejects.toBeInstanceOf(SendMessageError);
  });
});
