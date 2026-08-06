import { createPgSupabaseCompat } from '@/lib/pg/supabase-compat'

let _adminClient: ReturnType<typeof createPgSupabaseCompat> | null = null

export function supabaseAdmin() {
  _adminClient ??= createPgSupabaseCompat()
  return _adminClient
}
