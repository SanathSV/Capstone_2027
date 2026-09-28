import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { ApiError } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { normaliseSupabaseUrl } from "@/lib/supabase/url";

/**
 * Authentication for callers that are not the dashboard.
 *
 * The web app authenticates by cookie: the browser holds a Supabase session and
 * `@supabase/ssr` reads it off the request. A Chrome extension cannot do that —
 * it has its own origin, its own storage, and no cookies for this site — so it
 * carries `Authorization: Bearer <access_token>` instead.
 *
 * Both end up in the same place: a Supabase client bound to that user, so every
 * query is still filtered by the same RLS policies. Nothing here grants access;
 * it only establishes *who is asking*.
 */

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * A Supabase client that acts as the bearer of `token`.
 *
 * The token is passed as the request's Authorization header, so PostgREST
 * resolves the role and `auth.uid()` from it exactly as it would for a cookie
 * session. An invalid or expired token simply fails `getUser()` below.
 */
function clientForToken(token: string): SupabaseClient {
  return createServerClient(
    normaliseSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL!),
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${token}` } },
      // No cookie jar: this request has no session of its own to read or write.
      cookies: { get: () => undefined, set: () => {}, remove: () => {} },
    },
  );
}

export interface Caller {
  user: User;
  supabase: SupabaseClient;
  /** How they proved who they are. Useful in logs. */
  via: "bearer" | "cookie";
}

/**
 * Identifies the caller by bearer token if there is one, cookie otherwise.
 *
 * Bearer is checked first so an extension's token always wins over whatever
 * cookie happens to be in the same browser — otherwise a leader signed in as
 * themselves on the dashboard could silently act as that identity from a
 * request the extension made on behalf of someone else.
 */
export async function requireCaller(request: Request): Promise<Caller> {
  const token = bearerToken(request);

  if (token) {
    const supabase = clientForToken(token);
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      throw new ApiError(
        401,
        "That access token is not valid. Sign in again in the extension — " +
          "Supabase access tokens expire after about an hour.",
      );
    }
    return { user, supabase, via: "bearer" };
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) throw new ApiError(401, "Not signed in.");
  return { user, supabase, via: "cookie" };
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/**
 * A Chrome extension calls this API from `chrome-extension://<id>`, which is a
 * different origin, so every one of these routes needs CORS headers or the
 * browser drops the response before the extension ever sees it — silently, with
 * only a console message that mentions neither the route nor the fix.
 *
 * `*` is safe *specifically because* these routes carry no cookies: they
 * authenticate by bearer token only, so a hostile page that reached them would
 * be sending its own token or none at all, and would learn nothing it did not
 * already know. Do not copy this onto a cookie-authenticated route, where `*`
 * plus credentials is exactly the mistake CORS exists to prevent.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Max-Age": "86400",
};

export function withCors<T extends NextResponse>(response: T): T {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

/** The preflight every one of these routes must answer. */
export function corsPreflight(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
