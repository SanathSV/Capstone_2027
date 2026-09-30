import { CONFIG } from "../config.js";

/**
 * A Supabase client small enough to read, built on `fetch`.
 *
 * Not `@supabase/supabase-js`, and not because of size. Manifest V3 forbids
 * remotely-hosted code, so the library would have to be bundled — which means a
 * build step, a toolchain, and a `dist/` directory in an extension whose whole
 * appeal is that you can point "Load unpacked" at the folder and have it run.
 *
 * Everything below is two REST endpoints. Auth is
 * `POST /auth/v1/token?grant_type=...`; data is PostgREST at `/rest/v1/<table>`,
 * which is the same HTTP the library would have made.
 */

const AUTH = () => `${CONFIG.SUPABASE_URL}/auth/v1`;
const REST = () => `${CONFIG.SUPABASE_URL}/rest/v1`;

/**
 * Supabase returns errors in three different shapes depending on which service
 * answered. Normalising them here means every caller can just show `.message`.
 */
async function readError(response) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // fall through to the status line
  }
  const raw =
    body?.error_description ||
    body?.msg ||
    body?.message ||
    body?.error ||
    `${response.status} ${response.statusText}`;

  if (response.status === 400 && /invalid login/i.test(raw)) {
    return "That email and password do not match an account.";
  }
  if (response.status === 400 && /email not confirmed/i.test(raw)) {
    return "That account's email is not confirmed yet. Confirm it, or turn off " +
      "\"Confirm email\" in the Supabase dashboard.";
  }
  if (response.status === 429) {
    return "Supabase is rate limiting sign-ins. Wait a minute and try again.";
  }
  return raw;
}

/** Sign in with email and password. Returns the raw Supabase session. */
export async function signInWithPassword(email, password) {
  const response = await fetch(`${AUTH()}/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: CONFIG.SUPABASE_ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

/**
 * Exchange a refresh token for a new session.
 *
 * Access tokens last about an hour. A popup that only ever stored the access
 * token would work beautifully for an hour and then start failing with 401s
 * that look like a broken backend, so the refresh token is stored and used.
 */
export async function refreshSession(refreshToken) {
  const response = await fetch(`${AUTH()}/token?grant_type=refresh_token`, {
    method: "POST",
    headers: {
      apikey: CONFIG.SUPABASE_ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

export async function signOut(accessToken) {
  // Best effort: the local session is cleared by the caller either way, and a
  // failure here would only mean the token stays valid until it expires.
  try {
    await fetch(`${AUTH()}/logout`, {
      method: "POST",
      headers: {
        apikey: CONFIG.SUPABASE_ANON_KEY,
        authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    /* ignored on purpose */
  }
}

/**
 * Teams this user leads.
 *
 * The `leader_id=eq.<uid>` filter is a convenience, not the security boundary:
 * the RLS policy on `teams` already limits what this token can see. Sending it
 * anyway keeps the response small and says plainly what the query is for.
 */
export async function fetchLedTeams(accessToken, userId) {
  const query = new URLSearchParams({
    select: "id,name,sprint_name,description",
    leader_id: `eq.${userId}`,
    order: "name.asc",
  });

  const response = await fetch(`${REST()}/teams?${query}`, {
    headers: {
      apikey: CONFIG.SUPABASE_ANON_KEY,
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });

  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}
