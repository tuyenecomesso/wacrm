import { createClient } from '@/shims/supabase-js'

export function createAdminClient() {
  return createClient()
}
