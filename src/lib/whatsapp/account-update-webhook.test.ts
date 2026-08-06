import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn()

vi.mock('@/lib/pg', () => ({
  getPool: () => ({ query: queryMock }),
}))

import {
  handleAccountUpdateChange,
  isAccountUpdateWebhookField,
} from './account-update-webhook'

describe('isAccountUpdateWebhookField', () => {
  it('recognises account_update', () => {
    expect(isAccountUpdateWebhookField('account_update')).toBe(true)
  })

  it('rejects other fields', () => {
    expect(isAccountUpdateWebhookField('messages')).toBe(false)
    expect(isAccountUpdateWebhookField('message_template_status_update')).toBe(false)
  })
})

describe('handleAccountUpdateChange', () => {
  beforeEach(() => {
    queryMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('marks the config disconnected on a known disconnect event', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ account_id: 'acct-1', waba_id: 'waba-999' }] }) // getConfigByWabaId
      .mockResolvedValueOnce({ rows: [] }) // markConfigDisconnected

    await handleAccountUpdateChange('waba-999', { event: 'ACCOUNT_DELETED' })

    expect(queryMock).toHaveBeenCalledTimes(2)
    expect(queryMock.mock.calls[0][0]).toContain('WHERE waba_id = $1')
    expect(queryMock.mock.calls[0][1]).toEqual(['waba-999'])
    expect(queryMock.mock.calls[1][0]).toContain("status = 'disconnected'")
    expect(queryMock.mock.calls[1][1]).toEqual(['acct-1'])
  })

  it.each(['PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED', 'ACCOUNT_OFFBOARDED', 'ACCOUNT_RESTRICTION', 'ACCOUNT_VIOLATION', 'DISABLED_UPDATE'])(
    'treats %s as a disconnect event',
    async (event) => {
      queryMock
        .mockResolvedValueOnce({ rows: [{ account_id: 'acct-1', waba_id: 'waba-999' }] })
        .mockResolvedValueOnce({ rows: [] })

      await handleAccountUpdateChange('waba-999', { event })

      expect(queryMock).toHaveBeenCalledTimes(2)
    }
  )

  it('ignores a non-disconnect event without querying the database', async () => {
    await handleAccountUpdateChange('waba-999', {
      event: 'BUSINESS_PRIMARY_LOCATION_COUNTRY_UPDATE',
    })

    expect(queryMock).not.toHaveBeenCalled()
  })

  it('no-ops when the waba_id is unknown', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }) // getConfigByWabaId -> null

    await handleAccountUpdateChange('unknown-waba', { event: 'ACCOUNT_DELETED' })

    expect(queryMock).toHaveBeenCalledTimes(1) // only the lookup, never the update
  })

  it('no-ops when waba_id is empty', async () => {
    await handleAccountUpdateChange('', { event: 'ACCOUNT_DELETED' })

    expect(queryMock).not.toHaveBeenCalled()
  })

  it('no-ops when event is missing', async () => {
    await handleAccountUpdateChange('waba-999', {})

    expect(queryMock).not.toHaveBeenCalled()
  })
})
