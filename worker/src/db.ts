import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config.js';
import type { Database } from './db.types.js';

export function createDb(cfg: Config): SupabaseClient<Database> {
  return createClient<Database>(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, {
    global: { headers: { 'User-Agent': 'RematchBot/0.1 (+https://github.com/rematch-app)' } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
