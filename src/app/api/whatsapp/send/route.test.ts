import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  INTERNAL_ACCOUNT_HEADER,
  INTERNAL_KEY_HEADER,
  INTERNAL_SCOPES_HEADER,
} from '@/lib/auth/api-context'

const conversationInserts: Array<Record<string, unknown>> = []

let existingConversation: Record<string, unknown> | null = null
let contactRow: Record<string, unknown> | null = null
let createdConversation: Record<string, unknown> | null = null

const CONTACT = {
  id: 'contact-1',
  account_id: 'acct-1',
  phone: '+15551234567',
}

function makeSupabaseMock() {
  function builder(table: string) {
    let didInsert = false

    const selectResult = () => {
      switch (table) {
        case 'profiles':
          return { data: { account_id: 'acct-1' }, error: null }
        case 'contacts':
          return { data: contactRow, error: null }
        case 'conversations':
          return { data: createdConversation ?? existingConversation, error: null }
        default:
          return { data: null, error: null }
      }
    }

    const insertResult = () => {
      switch (table) {
        case 'conversations':
          return {
            data: {
              id: 'conv-new',
              account_id: 'acct-1',
              contact_id: 'contact-1',
              contact: CONTACT,
            },
            error: null,
          }
        default:
          return { data: null, error: null }
      }
    }

    const terminal = () => Promise.resolve(didInsert ? insertResult() : selectResult())

    const b: Record<string, unknown> = {}
    const chain = () => b
    for (const m of ['select', 'eq', 'in', 'order', 'limit', 'update', 'delete']) {
      b[m] = vi.fn(chain)
    }
    b.insert = vi.fn((payload: Record<string, unknown>) => {
      didInsert = true
      if (table === 'conversations') {
        conversationInserts.push(payload)
        createdConversation = {
          id: 'conv-new',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          contact: CONTACT,
        }
      }
      return b
    })
    b.single = vi.fn(terminal)
    b.maybeSingle = vi.fn(terminal)
    b.then = (resolve: (v: unknown) => unknown) =>
      resolve(didInsert ? insertResult() : selectResult())
    return b
  }

  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-1' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  }
}

let supabaseMock = makeSupabaseMock()

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => supabaseMock),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      for (const m of ['update', 'eq', 'select']) b[m] = vi.fn(chain)
      b.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null })
      return b
    },
  }),
}))

const { sendMessageToConversation, validateSendMessageParams } = vi.hoisted(() => ({
  sendMessageToConversation: vi.fn(
    async (_accountId: string, params: Record<string, unknown>) => ({
      messageId: params.conversationId === 'conv-existing' ? 'msg-existing' : 'msg-1',
      whatsappMessageId: 'wamid-1',
    }),
  ),
  validateSendMessageParams: vi.fn(),
}))
const { getPool } = vi.hoisted(() => ({
  getPool: vi.fn(() => ({
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM contacts')) {
        return { rows: contactRow ? [{ id: String(params[0]) }] : [] }
      }
      if (sql.includes('FROM conversations')) {
        return {
          rows:
            createdConversation ?? existingConversation
              ? [{ id: (createdConversation ?? existingConversation)?.id }]
              : [],
        }
      }
      if (sql.includes('INSERT INTO conversations')) {
        conversationInserts.push({
          account_id: params[0],
          user_id: params[1],
          contact_id: params[2],
        })
        createdConversation = {
          id: 'conv-new',
          account_id: 'acct-1',
          contact_id: 'contact-1',
          contact: CONTACT,
        }
        return { rows: [{ id: 'conv-new' }] }
      }
      if (sql.includes('FROM whatsapp_config')) {
        return { rows: [{ user_id: 'user-1' }] }
      }
      if (sql.includes('FROM accounts')) {
        return { rows: [{ owner_user_id: 'user-1' }] }
      }
      return { rows: [] }
    }),
  })),
}))

vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation,
  validateSendMessageParams,
  SendMessageError: class SendMessageError extends Error {
    status: number

    constructor(_code: string, message: string, status: number) {
      super(message)
      this.status = status
    }
  },
}))
vi.mock('@/lib/pg', () => ({
  getPool,
}))

import { POST } from './route'

function postContactTemplate(overrides: Record<string, unknown> = {}) {
  return POST(
    new Request('http://localhost/api/whatsapp/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [INTERNAL_ACCOUNT_HEADER]: 'acct-1',
        [INTERNAL_KEY_HEADER]: 'key-1',
        [INTERNAL_SCOPES_HEADER]: 'messages:send',
      },
      body: JSON.stringify({
        contact_id: 'contact-1',
        message_type: 'template',
        template_name: 'order_update',
        template_language: 'en_US',
        template_message_params: { body: ['Acme', '#1234'] },
        template_params: ['Acme', '#1234'],
        ...overrides,
      }),
    }),
  )
}

describe('POST /api/whatsapp/send - contact_id template path', () => {
  beforeEach(() => {
    conversationInserts.length = 0
    existingConversation = null
    createdConversation = null
    contactRow = CONTACT
    supabaseMock = makeSupabaseMock()
    sendMessageToConversation.mockClear()
    validateSendMessageParams.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('creates a conversation for a contact with none, then delegates send via shared core', async () => {
    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(json.message_id).toBe('msg-1')
    expect(json.whatsapp_message_id).toBe('wamid-1')

    expect(conversationInserts).toHaveLength(1)
    expect(conversationInserts[0]).toMatchObject({
      account_id: 'acct-1',
      contact_id: 'contact-1',
    })

    expect(sendMessageToConversation).toHaveBeenCalledWith('acct-1', {
      conversationId: 'conv-new',
      messageType: 'template',
      contentText: undefined,
      mediaUrl: undefined,
      filename: undefined,
      templateName: 'order_update',
      templateLanguage: 'en_US',
      templateParams: ['Acme', '#1234'],
      templateMessageParams: { body: ['Acme', '#1234'] },
      interactivePayload: undefined,
      replyToMessageId: undefined,
    })
  })

  it('reuses an existing conversation instead of creating a duplicate', async () => {
    existingConversation = {
      id: 'conv-existing',
      account_id: 'acct-1',
      contact_id: 'contact-1',
      contact: CONTACT,
    }

    const res = await postContactTemplate()
    expect(res.status).toBe(200)

    expect(conversationInserts).toHaveLength(0)
    expect(sendMessageToConversation).toHaveBeenCalledWith(
      'acct-1',
      expect.objectContaining({ conversationId: 'conv-existing' }),
    )
  })

  it('404s when the contact is not in the caller account', async () => {
    contactRow = null

    const res = await postContactTemplate()
    const json = await res.json()

    expect(res.status).toBe(404)
    expect(json.error).toMatch(/contact not found/i)
    expect(sendMessageToConversation).not.toHaveBeenCalled()
  })

  it('400s when neither conversation_id nor contact_id is provided', async () => {
    const res = await POST(
      new Request('http://localhost/api/whatsapp/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [INTERNAL_ACCOUNT_HEADER]: 'acct-1',
          [INTERNAL_KEY_HEADER]: 'key-1',
          [INTERNAL_SCOPES_HEADER]: 'messages:send',
        },
        body: JSON.stringify({ message_type: 'template', template_name: 'x' }),
      }),
    )
    expect(res.status).toBe(400)
  })
})
