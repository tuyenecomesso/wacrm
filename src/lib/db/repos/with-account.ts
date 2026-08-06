export interface AccountScopedClause {
  sql: string
  params: readonly unknown[]
}

/**
 * Append a stable `account_id = $n` predicate to a query fragment.
 * Tiny helper, but it keeps repo call sites from hand-rolling index
 * math and makes account scoping visually obvious.
 */
export function withAccountClause(
  accountId: string,
  params: readonly unknown[] = [],
  column = 'account_id',
): AccountScopedClause {
  return {
    sql: `${column} = $${params.length + 1}`,
    params: [...params, accountId],
  }
}
