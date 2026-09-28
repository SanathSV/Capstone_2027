import { refreshSession, signOut } from "./supabase.js";

/**
 * The session, in `chrome.storage.local`.
 *
 * A popup is destroyed every time it closes, so nothing can live in memory: the
 * session has to survive in storage or the leader signs in again on every
 * click. `storage.local` is scoped to the extension and not readable by web
 * pages, which is the right place for a token — `localStorage` on a content
 * page would not be.
 */

const KEY = "astra.session";
/** Refresh this far ahead of expiry, so a click never lands on a dead token. */
const REFRESH_MARGIN_SECONDS = 120;

export async function loadSession() {
  const stored = await chrome.storage.local.get(KEY);
  return stored[KEY] ?? null;
}

export async function saveSession(session) {
  // Supabase returns expires_in (seconds from now); an absolute instant is what
  // we actually want to compare against later.
  const expiresAt =
    session.expires_at ??
    Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600);

  const record = {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: expiresAt,
    user: {
      id: session.user?.id,
      email: session.user?.email,
    },
  };

  await chrome.storage.local.set({ [KEY]: record });
  return record;
}

export async function clearSession() {
  const session = await loadSession();
  if (session?.access_token) await signOut(session.access_token);
  await chrome.storage.local.remove(KEY);
}

/**
 * The current session, refreshed if it is about to expire.
 *
 * Returns null when there is nothing usable, which the popup treats as "show
 * the sign-in form". A refresh that fails means the refresh token is spent too,
 * so the stored session is cleared rather than left to fail again on the next
 * click.
 */
export async function getValidSession() {
  const session = await loadSession();
  if (!session?.access_token) return null;

  const now = Math.floor(Date.now() / 1000);
  if (session.expires_at - REFRESH_MARGIN_SECONDS > now) return session;

  if (!session.refresh_token) {
    await chrome.storage.local.remove(KEY);
    return null;
  }

  try {
    return await saveSession(await refreshSession(session.refresh_token));
  } catch {
    await chrome.storage.local.remove(KEY);
    return null;
  }
}
