import { getPool } from '@/lib/pg'

export interface MessageTemplateRow {
  id: string
  account_id: string
  user_id: string
  name: string
  category: string
  language: string
  header_type: string | null
  header_content: string | null
  header_media_url: string | null
  header_handle: string | null
  body_text: string
  footer_text: string | null
  buttons: unknown
  sample_values: unknown
  status: string
  meta_template_id: string | null
  quality_score: string | null
  submission_error: string | null
  rejection_reason: string | null
  last_submitted_at: string | null
  created_at: string
  updated_at: string
}

const TEMPLATE_COLUMNS = `
  id,
  account_id,
  user_id,
  name,
  category,
  language,
  header_type,
  header_content,
  header_media_url,
  header_handle,
  body_text,
  footer_text,
  buttons,
  sample_values,
  status,
  meta_template_id,
  quality_score,
  submission_error,
  rejection_reason,
  last_submitted_at,
  created_at,
  updated_at
`

export interface TemplateWriteInput {
  account_id: string
  user_id: string
  name: string
  category: string
  language: string
  header_type: string | null
  header_content: string | null
  header_media_url: string | null
  header_handle: string | null
  body_text: string
  footer_text: string | null
  buttons: unknown
  sample_values: unknown
  status: string
  meta_template_id: string | null
  quality_score?: string | null
  submission_error: string | null
  rejection_reason?: string | null
  last_submitted_at: string | null
}

export async function getTemplateByIdForAccount(
  accountId: string,
  id: string
): Promise<MessageTemplateRow | null> {
  const { rows } = await getPool().query<MessageTemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}
     FROM message_templates
     WHERE account_id = $1
       AND id = $2
     LIMIT 1`,
    [accountId, id]
  )
  return rows[0] ?? null
}

export async function findTemplateByAccountNameLanguage(
  accountId: string,
  name: string,
  language: string
): Promise<Pick<MessageTemplateRow, 'id'> | null> {
  const { rows } = await getPool().query<Pick<MessageTemplateRow, 'id'>>(
    `SELECT id
     FROM message_templates
     WHERE account_id = $1
       AND name = $2
       AND language = $3
     LIMIT 1`,
    [accountId, name, language]
  )
  return rows[0] ?? null
}

export async function upsertTemplateByLegacyKey(
  input: TemplateWriteInput
): Promise<MessageTemplateRow> {
  const { rows } = await getPool().query<MessageTemplateRow>(
    `INSERT INTO message_templates (
       account_id,
       user_id,
       name,
       category,
       language,
       header_type,
       header_content,
       header_media_url,
       header_handle,
       body_text,
       footer_text,
       buttons,
       sample_values,
       status,
       meta_template_id,
       quality_score,
       submission_error,
       rejection_reason,
       last_submitted_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19
     )
     ON CONFLICT (user_id, name, language)
     DO UPDATE SET
       account_id = EXCLUDED.account_id,
       category = EXCLUDED.category,
       header_type = EXCLUDED.header_type,
       header_content = EXCLUDED.header_content,
       header_media_url = EXCLUDED.header_media_url,
       header_handle = EXCLUDED.header_handle,
       body_text = EXCLUDED.body_text,
       footer_text = EXCLUDED.footer_text,
       buttons = EXCLUDED.buttons,
       sample_values = EXCLUDED.sample_values,
       status = EXCLUDED.status,
       meta_template_id = EXCLUDED.meta_template_id,
       quality_score = EXCLUDED.quality_score,
       submission_error = EXCLUDED.submission_error,
       rejection_reason = EXCLUDED.rejection_reason,
       last_submitted_at = EXCLUDED.last_submitted_at,
       updated_at = now()
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      input.account_id,
      input.user_id,
      input.name,
      input.category,
      input.language,
      input.header_type,
      input.header_content,
      input.header_media_url,
      input.header_handle,
      input.body_text,
      input.footer_text,
      input.buttons == null ? null : JSON.stringify(input.buttons),
      input.sample_values == null ? null : JSON.stringify(input.sample_values),
      input.status,
      input.meta_template_id,
      input.quality_score ?? null,
      input.submission_error,
      input.rejection_reason ?? null,
      input.last_submitted_at,
    ]
  )
  return rows[0]
}

export async function updateTemplateByIdForAccount(
  accountId: string,
  id: string,
  patch: Partial<TemplateWriteInput>
): Promise<MessageTemplateRow | null> {
  const fields: string[] = []
  const values: unknown[] = [accountId, id]

  const entries = Object.entries(patch)
  for (const [key, value] of entries) {
    values.push(
      key === 'buttons' || key === 'sample_values'
        ? value == null
          ? null
          : JSON.stringify(value)
        : value
    )
    const placeholder = `$${values.length}`
    if (key === 'buttons' || key === 'sample_values') {
      fields.push(`${key} = ${placeholder}::jsonb`)
    } else {
      fields.push(`${key} = ${placeholder}`)
    }
  }

  if (fields.length === 0) {
    return getTemplateByIdForAccount(accountId, id)
  }

  const { rows } = await getPool().query<MessageTemplateRow>(
    `UPDATE message_templates
     SET ${fields.join(', ')},
         updated_at = now()
     WHERE account_id = $1
       AND id = $2
     RETURNING ${TEMPLATE_COLUMNS}`,
    values
  )
  return rows[0] ?? null
}

export async function insertTemplate(
  input: TemplateWriteInput
): Promise<void> {
  await getPool().query(
    `INSERT INTO message_templates (
       account_id,
       user_id,
       name,
       category,
       language,
       header_type,
       header_content,
       header_media_url,
       header_handle,
       body_text,
       footer_text,
       buttons,
       sample_values,
       status,
       meta_template_id,
       quality_score,
       submission_error,
       rejection_reason,
       last_submitted_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19
     )`,
    [
      input.account_id,
      input.user_id,
      input.name,
      input.category,
      input.language,
      input.header_type,
      input.header_content,
      input.header_media_url,
      input.header_handle,
      input.body_text,
      input.footer_text,
      input.buttons == null ? null : JSON.stringify(input.buttons),
      input.sample_values == null ? null : JSON.stringify(input.sample_values),
      input.status,
      input.meta_template_id,
      input.quality_score ?? null,
      input.submission_error,
      input.rejection_reason ?? null,
      input.last_submitted_at,
    ]
  )
}

export async function deleteTemplateByIdForAccount(
  accountId: string,
  id: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `DELETE FROM message_templates
     WHERE account_id = $1
       AND id = $2`,
    [accountId, id]
  )
  return (rowCount ?? 0) > 0
}

export async function updateTemplateByMetaId(
  metaTemplateId: string,
  patch: Pick<
    Partial<TemplateWriteInput>,
    'status' | 'quality_score' | 'submission_error' | 'rejection_reason'
  >
): Promise<number> {
  const fields: string[] = []
  const values: unknown[] = [metaTemplateId]

  for (const [key, value] of Object.entries(patch)) {
    values.push(value ?? null)
    fields.push(`${key} = $${values.length}`)
  }

  if (fields.length === 0) return 0

  const { rowCount } = await getPool().query(
    `UPDATE message_templates
     SET ${fields.join(', ')},
         updated_at = now()
     WHERE meta_template_id = $1`,
    values
  )
  return rowCount ?? 0
}
