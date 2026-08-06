import { createClient as createShimClient } from '@/shims/supabase-js'

export function createClient() {
  return createShimClient()
}
