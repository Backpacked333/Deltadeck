// Test-only: an in-memory stand-in for the Supabase client's table reads
// (select with eq, neq, in, order, limit, range, maybeSingle) and RPCs, over rows
// the test provides. Every read is recorded so a test can check what was
// asked. Columns are not projected: a row comes back whole.
import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, unknown>
type Filter = (row: Row) => boolean

export function fakeSupabase({
  tables = {},
  rpc = {},
  fail = [],
  userId = null,
}: {
  tables?: Record<string, Row[]>
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>
  /** Tables (or RPC names) whose reads fail. */
  fail?: string[]
  /** The signed-in user, if any. */
  userId?: string | null
}) {
  const reads: { table: string; filters: string[] }[] = []
  const from = (table: string) => {
    const filters: Filter[] = []
    const asked: string[] = []
    let order: { column: string; ascending: boolean } | null = null
    let limit = Infinity
    let offset = 0
    const result = () => {
      reads.push({ table, filters: asked })
      if (fail.includes(table))
        return { data: null, error: new Error(`${table} is down`) }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (order) {
        const { column, ascending } = order
        rows = [...rows].sort(
          (a, b) =>
            (String(a[column]) < String(b[column]) ? -1 : 1) *
            (ascending ? 1 : -1),
        )
      }
      return { data: rows.slice(offset, offset + limit), error: null }
    }
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        asked.push(`${column}=${String(value)}`)
        filters.push((r) => r[column] === value)
        return query
      },
      neq: (column: string, value: unknown) => {
        asked.push(`${column}!=${String(value)}`)
        filters.push((r) => r[column] !== value)
        return query
      },
      in: (column: string, values: unknown[]) => {
        asked.push(`${column} in ${values.length}`)
        filters.push((r) => values.includes(r[column]))
        return query
      },
      order: (column: string, options?: { ascending?: boolean }) => {
        order = { column, ascending: options?.ascending ?? true }
        return query
      },
      limit: (n: number) => {
        limit = n
        return query
      },
      range: (from: number, to: number) => {
        asked.push(`range ${from}-${to}`)
        offset = from
        limit = to - from + 1
        return query
      },
      maybeSingle: async () => {
        const { data, error } = result()
        return { data: data?.[0] ?? null, error }
      },
      then: (
        resolve: (value: { data: Row[] | null; error: Error | null }) => void,
      ) => resolve(result()),
    }
    return query
  }
  const client = {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      reads.push({ table: `rpc:${name}`, filters: [] })
      if (fail.includes(name))
        return { data: null, error: new Error(`${name} is down`) }
      return { data: rpc[name]?.(args) ?? [], error: null }
    },
    auth: {
      getSession: async () => ({
        data: { session: userId ? { user: { id: userId } } : null },
      }),
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
    },
  } as unknown as SupabaseClient
  return { client, reads }
}
