import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  console.warn('Supabase env vars missing — check frontend/.env')
}

// Same Supabase project as the landing app. Because both apps use the same
// project + storage key, a session created on the landing site is visible
// here too (when served on the same domain). Cross-domain, the user signs
// in on the landing site and arrives here with access already granted.
export const supabase = createClient(url, anonKey)

export const getSession = () => supabase.auth.getSession()