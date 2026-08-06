// @deprecated wacrm is API-only — Supabase SSR removed during direct-pg migration.

import { createClient } from './supabase-js';

export function createBrowserClient(..._args: unknown[]) {
  return createClient();
}

export function createServerClient(..._args: unknown[]) {
  return createClient();
}
