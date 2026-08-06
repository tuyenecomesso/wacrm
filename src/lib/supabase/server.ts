import { createClient as createShimClient } from '@/shims/supabase-js'

export async function createClient() {
  return createShimClient()
}
