import { getPool } from '@/lib/pg'

export interface BuilderStepInput {
  id?: string
  step_type: string
  step_config: Record<string, unknown>
  branches?: { yes?: BuilderStepInput[]; no?: BuilderStepInput[] }
  branch?: 'yes' | 'no' | null
  parent_index?: number | null
}

interface InsertRow {
  id: string
  automation_id: string
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  step_type: string
  step_config: Record<string, unknown>
  position: number
}

interface Queryable {
  query: <T = unknown>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

export async function replaceSteps(
  automationId: string,
  input: BuilderStepInput[]
): Promise<string | null> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM automation_steps WHERE automation_id = $1', [automationId])
    const error = await insertSteps(automationId, input, client)
    if (error) {
      await client.query('ROLLBACK')
      return error
    }
    await client.query('COMMIT')
    return null
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    return error instanceof Error ? error.message : String(error)
  } finally {
    client.release()
  }
}

export async function insertSteps(
  automationId: string,
  input: BuilderStepInput[],
  db?: Queryable
): Promise<string | null> {
  if (!input || input.length === 0) return null

  const looksFlat = input.some((s) => s.branch !== undefined || s.parent_index !== undefined)
  const tree = looksFlat ? seedsToTree(input) : input

  const rows: InsertRow[] = []
  function walk(
    steps: BuilderStepInput[],
    parentId: string | null,
    branch: 'yes' | 'no' | null
  ) {
    steps.forEach((step, index) => {
      const id = step.id ?? uid()
      rows.push({
        id,
        automation_id: automationId,
        parent_step_id: parentId,
        branch,
        step_type: step.step_type,
        step_config: step.step_config ?? {},
        position: index,
      })
      if (step.step_type === 'condition' && step.branches) {
        if (step.branches.yes) walk(step.branches.yes, id, 'yes')
        if (step.branches.no) walk(step.branches.no, id, 'no')
      }
    })
  }
  walk(tree, null, null)

  if (rows.length === 0) return null

  const queryable = db ?? getPool()
  const values: string[] = []
  const params: unknown[] = []
  for (const row of rows) {
    params.push(
      row.id,
      row.automation_id,
      row.parent_step_id,
      row.branch,
      row.step_type,
      JSON.stringify(row.step_config),
      row.position
    )
    const base = params.length - 6
    values.push(
      `($${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::jsonb, $${base + 6})`
    )
  }

  try {
    await queryable.query(
      `INSERT INTO automation_steps
         (id, automation_id, parent_step_id, branch, step_type, step_config, position)
       VALUES ${values.join(', ')}`,
      params
    )
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function seedsToTree(seeds: BuilderStepInput[]): BuilderStepInput[] {
  const nodes: BuilderStepInput[] = seeds.map((step) => ({
    ...step,
    branches: { yes: [], no: [] },
  }))
  const roots: BuilderStepInput[] = []
  nodes.forEach((node, index) => {
    const seed = seeds[index]
    if (seed.parent_index == null) {
      roots.push(node)
      return
    }

    const parent = nodes[seed.parent_index]
    parent.branches = parent.branches ?? { yes: [], no: [] }
    const bucket = (seed.branch ?? 'yes') as 'yes' | 'no'
    ;(parent.branches[bucket] ??= []).push(node)
  })
  return roots
}

export interface BuilderStepNode extends BuilderStepInput {
  id: string
  branches: { yes: BuilderStepNode[]; no: BuilderStepNode[] }
}

interface DbStep {
  id: string
  parent_step_id: string | null
  branch: 'yes' | 'no' | null
  step_type: string
  step_config: Record<string, unknown>
  position: number
}

export async function loadStepsTree(automationId: string): Promise<BuilderStepNode[]> {
  const { rows } = await getPool().query<DbStep>(
    `SELECT id, parent_step_id, branch, step_type, step_config, position
       FROM automation_steps
      WHERE automation_id = $1
      ORDER BY position ASC`,
    [automationId]
  )

  const byId = new Map<string, BuilderStepNode>()
  for (const row of rows) {
    byId.set(row.id, {
      id: row.id,
      step_type: row.step_type,
      step_config: row.step_config ?? {},
      branches: { yes: [], no: [] },
    })
  }

  const roots: BuilderStepNode[] = []
  for (const row of rows) {
    const node = byId.get(row.id)
    if (!node) continue
    if (row.parent_step_id) {
      const parent = byId.get(row.parent_step_id)
      if (parent) {
        const bucket = (row.branch ?? 'yes') as 'yes' | 'no'
        parent.branches[bucket].push(node)
      }
      continue
    }
    roots.push(node)
  }

  return roots
}
