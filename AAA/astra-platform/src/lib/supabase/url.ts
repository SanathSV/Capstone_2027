/**
 * Normalises NEXT_PUBLIC_SUPABASE_URL to the bare project origin.
 *
 * supabase-js builds its own paths — `/auth/v1/...` for auth, `/rest/v1/...`
 * for PostgREST — from whatever base URL it is handed. So a base URL that
 * already carries a path silently produces requests like
 * `/rest/v1/auth/v1/otp`, which 404 with an "invalid path" error that names
 * neither the cause nor this variable.
 *
 * The trap is that the dashboard's Data API page prominently shows a "RESTful
 * endpoint" ending in `/rest/v1`, which looks exactly like the thing to copy.
 * Rather than let that cost someone an evening, strip it here.
 */
export function normaliseSupabaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  // Only ever strip the two paths supabase-js appends itself. Anything else is
  // left alone: a self-hosted project can legitimately live under a sub-path,
  // and quietly rewriting that would be its own mystery.
  return trimmed.replace(/\/(rest|auth|storage|realtime)\/v1$/, "");
}
