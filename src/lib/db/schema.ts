import type { Pool } from "pg";

// ============================================================
// Runtime schema metadata for the direct-Postgres data layer.
//
// The Koyeb database is shared with vanessa-backend /
// vanessa-business-hub (117 tables). This module is the ONLY
// place that knows which tables belong to wacrm — every query
// executor (server direct + the /api/db browser proxy) resolves
// tables/columns through here, so a table outside the wacrm
// whitelist is never reachable.
//
// Metadata is introspected once per process from
// information_schema and cached on globalThis (survives dev
// reloads like the pg pool in src/lib/pg.ts).
// ============================================================

export const WACRM_TABLES = [
  "profiles",
  "contacts",
  "tags",
  "contact_tags",
  "custom_fields",
  "contact_custom_values",
  "contact_notes",
  "conversations",
  "messages",
  "whatsapp_config",
  "message_templates",
  "pipelines",
  "pipeline_stages",
  "deals",
  "broadcasts",
  "broadcast_recipients",
  "automations",
  "automation_steps",
  "automation_logs",
  "automation_pending_executions",
  "message_reactions",
  "flows",
  "flow_nodes",
  "flow_runs",
  "flow_run_events",
  "accounts",
  "account_invitations",
  "member_presence",
  "api_keys",
  "notifications",
  "webhook_endpoints",
  "ai_configs",
  "ai_knowledge_documents",
  "ai_knowledge_chunks",
  "ai_usage_log",
  "quick_replies",
] as const;

export type WacrmTable = (typeof WACRM_TABLES)[number];

export interface ColumnInfo {
  name: string;
  /** data_type from information_schema, e.g. 'uuid', 'text', 'jsonb'. */
  type: string;
  notNull: boolean;
}

export interface FkInfo {
  /** Column on the source table. */
  column: string;
  /** Referenced table. */
  refTable: string;
  /** Referenced column (always 'id' in this schema). */
  refColumn: string;
  /** Constraint name, used to disambiguate `table!constraint(...)` embeds. */
  constraint: string;
}

export interface TableInfo {
  name: string;
  columns: Map<string, ColumnInfo>;
  fks: FkInfo[];
  hasAccountId: boolean;
}

export interface Schema {
  tables: Map<string, TableInfo>;
  /** FK column(s) the current table uses to reach `refTable` (to-one embeds). */
  fksTo(table: string, refTable: string): FkInfo[];
  /** Tables that reference `table` via a FK (to-many embeds). */
  fksFrom(table: string): { child: string; fk: FkInfo }[];
}

/**
 * Tables without an `account_id` column whose tenancy flows through
 * a single FK to a parent that does carry one. Used to auto-scope
 * reads/writes on join tables when the executor runs with a caller
 * context (mirrors the RLS policies the ported schema removed).
 */
export const CHILD_PARENT_TENANCY: Record<string, { parent: string; fk: string }> =
  {
    contact_tags: { parent: "contacts", fk: "contact_id" },
    contact_custom_values: { parent: "contacts", fk: "contact_id" },
    pipeline_stages: { parent: "pipelines", fk: "pipeline_id" },
    messages: { parent: "conversations", fk: "conversation_id" },
    automation_steps: { parent: "automations", fk: "automation_id" },
    message_reactions: { parent: "conversations", fk: "conversation_id" },
    flow_nodes: { parent: "flows", fk: "flow_id" },
    flow_run_events: { parent: "flow_runs", fk: "flow_run_id" },
    broadcast_recipients: { parent: "broadcasts", fk: "broadcast_id" },
  };

declare global {
  var __wacrmDbSchema: Schema | null;
}

async function introspect(pool: Pool): Promise<Schema> {
  const tables = new Map<string, TableInfo>();

  const colRes = await pool.query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, ordinal_position`,
    [WACRM_TABLES],
  );
  for (const row of colRes.rows as {
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }[]) {
    let info = tables.get(row.table_name);
    if (!info) {
      info = { name: row.table_name, columns: new Map(), fks: [], hasAccountId: false };
      tables.set(row.table_name, info);
    }
    info.columns.set(row.column_name, {
      name: row.column_name,
      type: row.data_type,
      notNull: row.is_nullable === "NO",
    });
    if (row.column_name === "account_id") info.hasAccountId = true;
  }

  // Foreign keys (public schema, non-system).
  const fkRes = await pool.query(
    `SELECT tc.table_name                                   AS src_table,
            kcu.column_name                                 AS src_column,
            ccu.table_name                                  AS ref_table,
            ccu.column_name                                 AS ref_column,
            tc.constraint_name                              AS constraint_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ANY($1::text[])
      ORDER BY tc.table_name, kcu.ordinal_position`,
    [WACRM_TABLES],
  );
  for (const row of fkRes.rows as {
    src_table: string;
    src_column: string;
    ref_table: string;
    ref_column: string;
    constraint_name: string;
  }[]) {
    const info = tables.get(row.src_table);
    if (!info) continue;
    info.fks.push({
      column: row.src_column,
      refTable: row.ref_table,
      refColumn: row.ref_column,
      constraint: row.constraint_name,
    });
  }

  const schema: Schema = {
    tables,
    fksTo(table, refTable) {
      return tables.get(table)?.fks.filter((f) => f.refTable === refTable) ?? [];
    },
    fksFrom(table) {
      const out: { child: string; fk: FkInfo }[] = [];
      for (const info of tables.values()) {
        for (const fk of info.fks) {
          if (fk.refTable === table) out.push({ child: info.name, fk });
        }
      }
      return out;
    },
  };
  return schema;
}

/** Returns true when `column` is a known column of `table` (or a `->>key`
 *  JSON accessor whose base column is a known jsonb column). */
export function isKnownColumn(schema: Schema, table: string, column: string): boolean {
  const info = schema.tables.get(table);
  if (!info) return false;
  if (info.columns.has(column)) return true;
  const jsonbPath = column.match(/^(\w+)->>\w+$/);
  if (jsonbPath) {
    const base = info.columns.get(jsonbPath[1]);
    return !!base && base.type === "jsonb";
  }
  return false;
}

/** Cached schema accessor. Callers must pass the shared pool. */
export async function getSchema(pool: Pool): Promise<Schema> {
  globalThis.__wacrmDbSchema ??= await introspect(pool);
  return globalThis.__wacrmDbSchema;
}
