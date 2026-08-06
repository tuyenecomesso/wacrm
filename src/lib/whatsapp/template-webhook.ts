import { normalizeStatus } from './template-status-normalize'
import { updateTemplateByMetaId } from './pg-templates'

const TEMPLATE_WEBHOOK_FIELDS = new Set([
  'message_template_status_update',
  'message_template_quality_update',
  'message_template_components_update',
])

export function isTemplateWebhookField(field: string): boolean {
  return TEMPLATE_WEBHOOK_FIELDS.has(field)
}

interface TemplateStatusUpdateValue {
  event?: string
  message_template_id?: string | number
  message_template_name?: string
  reason?: string
}

interface TemplateQualityUpdateValue {
  message_template_id?: string | number
  new_quality_score?: string
}

interface TemplateComponentsUpdateValue {
  message_template_id?: string | number
  message_template_name?: string
}

export interface TemplateWebhookChange {
  field: string
  value: unknown
}

export async function handleTemplateWebhookChange(
  change: TemplateWebhookChange,
  _unused?: unknown,
): Promise<void> {
  void _unused
  switch (change.field) {
    case 'message_template_status_update':
      await handleStatusUpdate(change.value as TemplateStatusUpdateValue)
      return
    case 'message_template_quality_update':
      await handleQualityUpdate(change.value as TemplateQualityUpdateValue)
      return
    case 'message_template_components_update':
      handleComponentsUpdate(change.value as TemplateComponentsUpdateValue)
      return
  }
}

async function handleStatusUpdate(value: TemplateStatusUpdateValue): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined
      ? String(value.message_template_id)
      : null
  if (!metaTemplateId || !value.event) {
    console.warn(
      '[template-webhook] status update missing message_template_id or event:',
      value,
    )
    return
  }

  const status = normalizeStatus(value.event)
  const update = {
    status,
    rejection_reason:
      status === 'REJECTED' ? value.reason ?? 'Rejected by Meta' : null,
    submission_error: null,
  }

  const updatedCount = await updateTemplateByMetaId(metaTemplateId, update)

  if (updatedCount === 0) {
    console.warn(
      '[template-webhook] status update received for unknown template:',
      metaTemplateId,
      value.message_template_name,
    )
    return
  }
  if (updatedCount > 1) {
    console.warn(
      `[template-webhook] status update matched ${updatedCount} rows for meta_template_id ${metaTemplateId} - investigate.`,
    )
  }
}

async function handleQualityUpdate(value: TemplateQualityUpdateValue): Promise<void> {
  const metaTemplateId =
    value.message_template_id !== undefined
      ? String(value.message_template_id)
      : null
  if (!metaTemplateId) {
    console.warn(
      '[template-webhook] quality update missing message_template_id:',
      value,
    )
    return
  }

  const raw = value.new_quality_score
  const score =
    raw && ['GREEN', 'YELLOW', 'RED'].includes(raw.toUpperCase())
      ? (raw.toUpperCase() as 'GREEN' | 'YELLOW' | 'RED')
      : null

  await updateTemplateByMetaId(metaTemplateId, {
    quality_score: score,
  })
}

function handleComponentsUpdate(value: TemplateComponentsUpdateValue): void {
  console.info(
    '[template-webhook] components updated by Meta for template',
    value.message_template_id,
    value.message_template_name,
    '- run "Sync from Meta" in Settings to pull the new components.',
  )
}
