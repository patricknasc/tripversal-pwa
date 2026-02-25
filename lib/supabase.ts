import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _admin: SupabaseClient | null = null;
let _anon: SupabaseClient | null = null;

// Service-role client — API routes only, never exposed to browser
export function getSupabaseAdmin(): SupabaseClient {
  if (!_admin) _admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
  return _admin;
}

// Anon client — safe for client-side reads (RLS enforced)
export function getSupabaseAnon(): SupabaseClient {
  if (!_anon) _anon = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
  return _anon;
}
