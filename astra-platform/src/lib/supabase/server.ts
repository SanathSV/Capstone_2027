import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { normaliseSupabaseUrl } from "./url";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * The request-scoped client. Every query it makes runs as the signed-in user,
 * so RLS is what decides which rows come back — the route handlers never have
 * to remember to filter by team.
 */
export function createSupabaseServerClient() {
  const cookieStore = cookies();

  return createServerClient(
    normaliseSupabaseUrl(required("NEXT_PUBLIC_SUPABASE_URL")),
    required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // Server Components cannot set cookies. The middleware refreshes
            // the session on every request, so a failure here is harmless.
          }
        },
        remove(name: string, options: CookieOptions) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            // Same as above.
          }
        },
      },
    },
  );
}

/**
 * Service-role client: bypasses RLS entirely.
 *
 * Only two things use it — writing a pre_context_runs audit row, and reading
 * the encrypted credentials out of team_integrations — and both do so *after*
 * `requireTeamLeader()` has already proved, using the caller's own session,
 * that they lead the team. Never hand this client a team id that came straight
 * off the request without that check.
 */
export function createSupabaseAdminClient() {
  return createClient(
    normaliseSupabaseUrl(required("NEXT_PUBLIC_SUPABASE_URL")),
    required("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

/** The signed-in user, or null. */
export async function getSessionUser() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}
