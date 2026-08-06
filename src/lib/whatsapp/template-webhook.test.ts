import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn()

vi.mock('@/lib/pg', () => ({
  getPool: () => ({ query: queryMock }),
}))

import {
  handleTemplateWebhookChange,
  isTemplateWebhookField,
} from './template-webhook'

describe('isTemplateWebhookField', () => {
  it('recognises the three template fields', () => {
    expect(isTemplateWebhookField('message_template_status_update')).toBe(true)
    expect(isTemplateWebhookField('message_template_quality_update')).toBe(true)
    expect(isTemplateWebhookField('message_template_components_update')).toBe(true)
  })

  it('rejects messaging fields', () => {
    expect(isTemplateWebhookField('messages')).toBe(false)
    expect(isTemplateWebhookField('message_status')).toBe(false)
  })
})

describe('handleTemplateWebhookChange', () => {
  beforeEach(() => {
    queryMock.mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('flips status to APPROVED and clears any rejection_reason', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'row-1' }] })

    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 12345,
      },
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE message_templates'),
      ['12345', 'APPROVED', null, null],
    )
  })

  it('persists the reason field on REJECTED', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'row-1' }] })

    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'REJECTED',
        message_template_id: 'TMPL_99',
        reason: 'Template uses non-compliant language.',
      },
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.any(String),
      ['TMPL_99', 'REJECTED', 'Template uses non-compliant language.', null],
    )
  })

  it('falls back to a generic reason when REJECTED has no reason', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'row-1' }] })

    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'REJECTED', message_template_id: '7' },
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.any(String),
      ['7', 'REJECTED', 'Rejected by Meta', null],
    )
  })

  it('normalises PENDING_REVIEW to PENDING', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'row-1' }] })

    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'PENDING_REVIEW', message_template_id: '1' },
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.any(String),
      ['1', 'PENDING', null, null],
    )
  })

  it('logs and exits when meta_template_id is missing', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: { event: 'APPROVED' },
    })

    expect(queryMock).not.toHaveBeenCalled()
  })

  it('logs a warning when the row is unknown locally', async () => {
    const warn = vi.spyOn(console, 'warn')
    queryMock.mockResolvedValueOnce({ rows: [] })

    await handleTemplateWebhookChange({
      field: 'message_template_status_update',
      value: {
        event: 'APPROVED',
        message_template_id: 'NEVER_SEEN',
        message_template_name: 'mystery',
      },
    })

    expect(warn).toHaveBeenCalled()
  })

  it('sets quality_score from new_quality_score', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })

    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '99',
        new_quality_score: 'YELLOW',
      },
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('SET quality_score = $2'),
      ['99', 'YELLOW'],
    )
  })

  it('stores null for unrecognised quality scores', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] })

    await handleTemplateWebhookChange({
      field: 'message_template_quality_update',
      value: {
        message_template_id: '99',
        new_quality_score: 'PURPLE',
      },
    })

    expect(queryMock).toHaveBeenCalledWith(
      expect.stringContaining('SET quality_score = $2'),
      ['99', null],
    )
  })

  it('components update is an info-log no-op', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    await handleTemplateWebhookChange({
      field: 'message_template_components_update',
      value: {
        message_template_id: '5',
        message_template_name: 'x',
      },
    })

    expect(queryMock).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalled()
  })

  it('unknown field is a defensive no-op', async () => {
    await handleTemplateWebhookChange({
      field: 'message_template_future_field',
      value: {},
    })

    expect(queryMock).not.toHaveBeenCalled()
  })
})
