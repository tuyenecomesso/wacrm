import { getPool } from '@/lib/pg'

type Row = Record<string, unknown>

type QueryResultShape = {
  data: unknown
  error: { message: string; code?: string } | null
  count?: number | null
}

type OrderSpec = { column: string; ascending: boolean }
type FilterSpec =
  | { op: 'eq'; column: string; value: unknown }
  | { op: 'gte'; column: string; value: unknown }
  | { op: 'in'; column: string; values: readonly unknown[] }
  | { op: 'is'; column: string; value: unknown }
  | { op: 'filter'; column: string; operator: string; value: unknown }

function quoteIdent(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`)
  }
  return `"${identifier}"`
}

function buildSelect(columns: string): string {
  const trimmed = columns.trim()
  if (!trimmed || trimmed === '*') return '*'
  return columns
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      if (part === '*') return '*'
      if (part.includes('(') || part.includes('->')) return part
      return part
        .split('.')
        .map((piece) => quoteIdent(piece))
        .join('.')
    })
    .join(', ')
}

function buildWhere(filters: FilterSpec[], params: unknown[]): string {
  if (filters.length === 0) return ''
  const clauses = filters.map((filter) => {
    if (filter.op === 'eq') {
      params.push(filter.value)
      return `${filter.column} = $${params.length}`
    }
    if (filter.op === 'gte') {
      params.push(filter.value)
      return `${filter.column} >= $${params.length}`
    }
    if (filter.op === 'in') {
      params.push(filter.values)
      return `${filter.column} = ANY($${params.length})`
    }
    if (filter.op === 'is') {
      if (filter.value === null) return `${filter.column} IS NULL`
      params.push(filter.value)
      return `${filter.column} IS NOT DISTINCT FROM $${params.length}`
    }
    params.push(filter.value)
    if (filter.operator === 'eq') {
      return `${filter.column} = $${params.length}`
    }
    throw new Error(`Unsupported filter operator: ${filter.operator}`)
  })
  return ` WHERE ${clauses.join(' AND ')}`
}

class PgSupabaseQuery implements PromiseLike<QueryResultShape> {
  private mode: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private filters: FilterSpec[] = []
  private orders: OrderSpec[] = []
  private selected = '*'
  private rowLimit: number | null = null
  private head = false
  private count = false
  private mutationRows: Row[] | null = null
  private conflictTarget: string | null = null
  private ignoreDuplicates = false
  private expect: 'many' | 'single' | 'maybeSingle' = 'many'

  constructor(private readonly table: string) {}

  select(columns = '*', options?: { count?: 'exact'; head?: boolean }) {
    this.selected = columns
    this.count = options?.count === 'exact'
    this.head = options?.head === true
    return this
  }

  insert(values: Row | Row[]) {
    this.mode = 'insert'
    this.mutationRows = Array.isArray(values) ? values : [values]
    return this
  }

  update(values: Row) {
    this.mode = 'update'
    this.mutationRows = [values]
    return this
  }

  delete() {
    this.mode = 'delete'
    return this
  }

  upsert(values: Row | Row[], options?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this.mode = 'insert'
    this.mutationRows = Array.isArray(values) ? values : [values]
    this.conflictTarget = options?.onConflict ?? null
    this.ignoreDuplicates = options?.ignoreDuplicates === true
    return this
  }

  eq(column: string, value: unknown) {
    this.filters.push({ op: 'eq', column, value })
    return this
  }

  gte(column: string, value: unknown) {
    this.filters.push({ op: 'gte', column, value })
    return this
  }

  in(column: string, values: readonly unknown[]) {
    this.filters.push({ op: 'in', column, values })
    return this
  }

  is(column: string, value: unknown) {
    this.filters.push({ op: 'is', column, value })
    return this
  }

  filter(column: string, operator: string, value: unknown) {
    this.filters.push({ op: 'filter', column, operator, value })
    return this
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending !== false })
    return this
  }

  limit(value: number) {
    this.rowLimit = value
    return this
  }

  single() {
    this.expect = 'single'
    return this
  }

  maybeSingle() {
    this.expect = 'maybeSingle'
    return this
  }

  then<TResult1 = QueryResultShape, TResult2 = never>(
    onfulfilled?: ((value: QueryResultShape) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled ?? undefined, onrejected ?? undefined)
  }

  private async execute(): Promise<QueryResultShape> {
    try {
      if (this.mode === 'select') return await this.executeSelect()
      if (this.mode === 'insert') return await this.executeInsert()
      if (this.mode === 'update') return await this.executeUpdate()
      return await this.executeDelete()
    } catch (error) {
      return {
        data: this.expect === 'many' ? [] : null,
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: (error as { code?: string }).code,
        },
        count: null,
      }
    }
  }

  private async executeSelect(): Promise<QueryResultShape> {
    const params: unknown[] = []
    if (this.count && this.head) {
      const sql = `SELECT COUNT(*)::int AS count FROM ${quoteIdent(this.table)}${buildWhere(
        this.filters,
        params,
      )}`
      const { rows } = await getPool().query<{ count: number }>(sql, params)
      return { data: null, error: null, count: rows[0]?.count ?? 0 }
    }

    const orderSql =
      this.orders.length > 0
        ? ` ORDER BY ${this.orders
            .map((order) => `${order.column} ${order.ascending ? 'ASC' : 'DESC'}`)
            .join(', ')}`
        : ''
    const limitSql = this.rowLimit !== null ? ` LIMIT ${this.rowLimit}` : ''
    const sql = `SELECT ${buildSelect(this.selected)} FROM ${quoteIdent(this.table)}${buildWhere(
      this.filters,
      params,
    )}${orderSql}${limitSql}`
    const { rows } = await getPool().query<Row>(sql, params)
    return this.finishRows(rows)
  }

  private async executeInsert(): Promise<QueryResultShape> {
    const rowsToInsert = this.mutationRows ?? []
    if (rowsToInsert.length === 0) return { data: [], error: null }

    const columns = [...new Set(rowsToInsert.flatMap((row) => Object.keys(row)))]
    const params: unknown[] = []
    const valuesSql = rowsToInsert
      .map((row) => {
        const placeholders = columns.map((column) => {
          params.push((row as Row)[column] ?? null)
          return `$${params.length}`
        })
        return `(${placeholders.join(', ')})`
      })
      .join(', ')

    let sql = `INSERT INTO ${quoteIdent(this.table)} (${columns
      .map(quoteIdent)
      .join(', ')}) VALUES ${valuesSql}`

    if (this.conflictTarget) {
      const keys = this.conflictTarget.split(',').map((part) => part.trim())
      const target = keys.map(quoteIdent).join(', ')
      if (this.ignoreDuplicates) {
        sql += ` ON CONFLICT (${target}) DO NOTHING`
      } else {
        const updates = columns
          .filter((column) => !keys.includes(column))
          .map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`)
        sql +=
          updates.length > 0
            ? ` ON CONFLICT (${target}) DO UPDATE SET ${updates.join(', ')}`
            : ` ON CONFLICT (${target}) DO NOTHING`
      }
    }

    if (!this.head) {
      sql += ` RETURNING ${buildSelect(this.selected)}`
    }

    const { rows } = await getPool().query<Row>(sql, params)
    return this.finishRows(rows)
  }

  private async executeUpdate(): Promise<QueryResultShape> {
    const update = this.mutationRows?.[0] ?? {}
    const params: unknown[] = []
    const assignments = Object.entries(update).map(([column, value]) => {
      params.push(value)
      return `${quoteIdent(column)} = $${params.length}`
    })
    let sql = `UPDATE ${quoteIdent(this.table)} SET ${assignments.join(', ')}`
    sql += buildWhere(this.filters, params)
    if (!this.head) {
      sql += ` RETURNING ${buildSelect(this.selected)}`
    }
    const { rows } = await getPool().query<Row>(sql, params)
    return this.finishRows(rows)
  }

  private async executeDelete(): Promise<QueryResultShape> {
    const params: unknown[] = []
    const sql = `DELETE FROM ${quoteIdent(this.table)}${buildWhere(this.filters, params)}`
    await getPool().query(sql, params)
    return { data: [], error: null }
  }

  private finishRows(rows: Row[]): QueryResultShape {
    if (this.expect === 'single') {
      if (rows.length !== 1) {
        return { data: null, error: { message: 'Expected exactly one row' } }
      }
      return { data: rows[0], error: null }
    }
    if (this.expect === 'maybeSingle') {
      if (rows.length > 1) {
        return { data: null, error: { message: 'Expected zero or one row' } }
      }
      return { data: rows[0] ?? null, error: null }
    }
    return { data: rows, error: null }
  }
}

export function createPgSupabaseCompat() {
  return {
    from(table: string) {
      return new PgSupabaseQuery(table)
    },
    async rpc(name: string, args: Record<string, unknown>) {
      try {
        const entries = Object.entries(args)
        const params = entries.map(([, value]) => value)
        const placeholders = entries.map((_, index) => `$${index + 1}`).join(', ')
        const sql = `SELECT * FROM ${quoteIdent(name)}(${placeholders})`
        const { rows } = await getPool().query<Row>(sql, params)
        return { data: rows[0] ? Object.values(rows[0])[0] : null, error: null }
      } catch (error) {
        return {
          data: null,
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: (error as { code?: string }).code,
          },
        }
      }
    },
  }
}
