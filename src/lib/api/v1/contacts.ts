// ============================================================
// Shared contact logic for the public API (v1) contact endpoints.
//
// Direct-Postgres port: the public API no longer depends on a
// Supabase client. Every helper scopes explicitly by `account_id`
// and talks to `pg` through the shared pool.
// ============================================================

import { getPool } from '@/lib/pg';
import { getAccountOwnerUserId } from '@/lib/db/repos/accounts';
import { phonesMatch } from '@/lib/whatsapp/phone-utils';
import { sanitizePhoneForMeta, isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils';
import type { Cursor } from '@/lib/api/v1/pagination';

export const CONTACT_SELECT = 'pg-direct';

export interface ApiContact {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  tags: { id: string; name: string; color: string }[];
  created_at: string;
  updated_at: string;
}

export class ContactError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ContactError';
    this.status = status;
  }
}

interface ContactRow {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  company: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
  tags?: Array<{ id: string; name: string; color: string } | null> | null;
  contact_tags?: Array<{ tags: { id: string; name: string; color: string } | null }>;
}

function cleanTagList(
  row: Record<string, unknown>
): { id: string; name: string; color: string }[] {
  const direct = Array.isArray(row.tags) ? row.tags : [];
  if (direct.length > 0) {
    return direct.filter((tag): tag is { id: string; name: string; color: string } => {
      return (
        !!tag &&
        typeof tag === 'object' &&
        typeof (tag as { id?: unknown }).id === 'string' &&
        typeof (tag as { name?: unknown }).name === 'string' &&
        typeof (tag as { color?: unknown }).color === 'string'
      );
    });
  }

  const joins = Array.isArray(row.contact_tags) ? row.contact_tags : [];
  return joins
    .map((join) => join?.tags ?? null)
    .filter((tag): tag is { id: string; name: string; color: string } => {
      return !!tag;
    });
}

export function serializeContact(row: Record<string, unknown>): ApiContact {
  return {
    id: row.id as string,
    phone: row.phone as string,
    name: (row.name as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    company: (row.company as string | null) ?? null,
    avatar_url: (row.avatar_url as string | null) ?? null,
    tags: cleanTagList(row),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function buildContactSelectSql(): string {
  return `
    SELECT
      c.id,
      c.phone,
      c.name,
      c.email,
      c.company,
      c.avatar_url,
      c.created_at,
      c.updated_at,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', t.id,
            'name', t.name,
            'color', t.color
          )
        ) FILTER (WHERE t.id IS NOT NULL),
        '[]'::json
      ) AS tags
    FROM contacts c
    LEFT JOIN contact_tags ct ON ct.contact_id = c.id
    LEFT JOIN tags t ON t.id = ct.tag_id
  `;
}

function buildContactGroupSql(): string {
  return `
    GROUP BY
      c.id, c.phone, c.name, c.email, c.company, c.avatar_url, c.created_at, c.updated_at
  `;
}

export async function resolveAuditUserId(accountId: string): Promise<string> {
  const pool = getPool();

  const { rows: configRows } = await pool.query<{ user_id: string }>(
    `SELECT user_id
     FROM whatsapp_config
     WHERE account_id = $1
     LIMIT 1`,
    [accountId]
  );
  if (configRows[0]?.user_id) return configRows[0].user_id;

  const ownerUserId = await getAccountOwnerUserId(accountId);
  if (ownerUserId) return ownerUserId;

  throw new ContactError('Account owner could not be resolved', 500);
}

async function findExistingContact(
  accountId: string,
  phone: string
): Promise<{ id: string; phone: string } | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;
  const { rows } = await getPool().query<{ id: string; phone: string }>(
    `SELECT id, phone
     FROM contacts
     WHERE account_id = $1
       AND phone LIKE $2`,
    [accountId, `%${suffix}`]
  );

  return rows.find((row) => phonesMatch(row.phone, phone)) ?? null;
}

export interface ContactInput {
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
}

export async function findOrCreateContact(
  accountId: string,
  auditUserId: string,
  input: ContactInput
): Promise<{ id: string; created: boolean }> {
  const sanitized = sanitizePhoneForMeta(input.phone);
  if (!isValidE164(sanitized)) {
    throw new ContactError(
      "'phone' must be a valid phone number in E.164 format (e.g. +14155550123)",
      400
    );
  }

  const existing = await findExistingContact(accountId, sanitized);
  if (existing) return { id: existing.id, created: false };

  try {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO contacts (account_id, user_id, phone, name, email, company)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        accountId,
        auditUserId,
        sanitized,
        input.name ?? sanitized,
        input.email ?? null,
        input.company ?? null,
      ]
    );
    return { id: rows[0].id, created: true };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      const raced = await findExistingContact(accountId, sanitized);
      if (raced) return { id: raced.id, created: false };
    }
    console.error('[api/v1/contacts] create error:', error);
    throw new ContactError('Failed to create contact', 500);
  }
}

async function resolveTagIds(
  accountId: string,
  userId: string,
  tagNames: string[]
): Promise<Map<string, string>> {
  const uniqueNames: string[] = [];
  const seen = new Set<string>();
  for (const raw of tagNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueNames.push(name);
  }

  const { rows: existing } = await getPool().query<{ id: string; name: string }>(
    `SELECT id, name
     FROM tags
     WHERE account_id = $1`,
    [accountId]
  );

  const tagIdByKey = new Map<string, string>();
  for (const tag of existing) {
    tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
  }

  const toCreate = uniqueNames.filter((name) => !tagIdByKey.has(name.toLowerCase()));
  if (toCreate.length > 0) {
    const values: string[] = [];
    const params: unknown[] = [];
    for (const name of toCreate) {
      params.push(userId, accountId, name, '#3b82f6');
      const offset = params.length - 3;
      values.push(`($${offset}, $${offset + 1}, $${offset + 2}, $${offset + 3})`);
    }

    const { rows: created } = await getPool().query<{ id: string; name: string }>(
      `INSERT INTO tags (user_id, account_id, name, color)
       VALUES ${values.join(', ')}
       RETURNING id, name`,
      params
    );

    for (const tag of created) {
      tagIdByKey.set(tag.name.trim().toLowerCase(), tag.id);
    }
  }

  return tagIdByKey;
}

export async function setContactTags(
  accountId: string,
  auditUserId: string,
  contactId: string,
  tagNames: string[]
): Promise<void> {
  const tagIdByKey = await resolveTagIds(accountId, auditUserId, tagNames);
  const desired = new Set<string>(tagIdByKey.values());

  const { rows: currentRows } = await getPool().query<{ tag_id: string }>(
    `SELECT tag_id
     FROM contact_tags
     WHERE contact_id = $1`,
    [contactId]
  );

  const existing = new Set(currentRows.map((row) => row.tag_id));
  const toRemove = [...existing].filter((tagId) => !desired.has(tagId));
  const toAdd = [...desired].filter((tagId) => !existing.has(tagId));

  if (toRemove.length > 0) {
    await getPool().query(
      `DELETE FROM contact_tags
       WHERE contact_id = $1
         AND tag_id = ANY($2::uuid[])`,
      [contactId, toRemove]
    );
  }

  if (toAdd.length > 0) {
    const values: string[] = [];
    const params: unknown[] = [];
    for (const tagId of toAdd) {
      params.push(contactId, tagId);
      const offset = params.length - 1;
      values.push(`($${offset}, $${offset + 1})`);
    }

    await getPool().query(
      `INSERT INTO contact_tags (contact_id, tag_id)
       VALUES ${values.join(', ')}
       ON CONFLICT (contact_id, tag_id) DO NOTHING`,
      params
    );
  }
}

export async function getContactById(
  accountId: string,
  contactId: string
): Promise<ApiContact | null> {
  const { rows } = await getPool().query<ContactRow>(
    `${buildContactSelectSql()}
     WHERE c.account_id = $1
       AND c.id = $2
     ${buildContactGroupSql()}
     LIMIT 1`,
    [accountId, contactId]
  );

  return rows[0] ? serializeContact(rows[0] as unknown as Record<string, unknown>) : null;
}

export async function listContacts(params: {
  accountId: string;
  limit: number;
  cursor: Cursor | null;
  search: string;
  tag: string | null;
}): Promise<Array<ApiContact & { created_at: string; id: string }>> {
  const values: unknown[] = [params.accountId];
  const where: string[] = ['c.account_id = $1'];

  if (params.search) {
    values.push(`%${params.search}%`);
    const idx = values.length;
    where.push(`(c.name ILIKE $${idx} OR c.phone ILIKE $${idx})`);
  }

  if (params.tag) {
    values.push(params.tag);
    where.push(`EXISTS (
      SELECT 1
      FROM contact_tags ctf
      WHERE ctf.contact_id = c.id
        AND ctf.tag_id = $${values.length}
    )`);
  }

  if (params.cursor) {
    values.push(params.cursor.createdAt, params.cursor.id);
    const tsIdx = values.length - 1;
    const idIdx = values.length;
    where.push(`(
      c.created_at < $${tsIdx}
      OR (c.created_at = $${tsIdx} AND c.id < $${idIdx})
    )`);
  }

  values.push(params.limit + 1);

  const { rows } = await getPool().query<ContactRow>(
    `${buildContactSelectSql()}
     WHERE ${where.join(' AND ')}
     ${buildContactGroupSql()}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $${values.length}`,
    values
  );

  return rows.map((row) => serializeContact(row as unknown as Record<string, unknown>));
}

export async function updateContactFields(params: {
  accountId: string;
  contactId: string;
  updates: Record<string, unknown>;
}): Promise<void> {
  const entries = Object.entries(params.updates);
  if (entries.length === 0) return;

  const assignments = entries.map(([field], index) => `${field} = $${index + 3}`);
  const values = [params.contactId, params.accountId, ...entries.map(([, value]) => value)];

  await getPool().query(
    `UPDATE contacts
     SET ${assignments.join(', ')}
     WHERE id = $1
       AND account_id = $2`,
    values
  );
}
