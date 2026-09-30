import { readFile } from "node:fs/promises";
import { ApiError, json, route } from "@/lib/api";
import { corsPreflight, requireCaller, withCors } from "@/lib/apiAuth";
import { leaderPaths, localBotAuthEnabled, readBotAuthStatus } from "@/lib/botAuth";

/**
 * GET /api/bot-auth/session — the caller's own bot session, in full.
 *
 * ⚠ This returns a LIVE GOOGLE SESSION. Anyone holding the response is signed
 * in as the bot account with no password and no second factor.
 *
 * Three things keep that defensible, and all three matter:
 *
 *  1. It only ever returns the *caller's own* credentials. There is no user id
 *     in the request to swap for someone else's.
 *  2. It is gated on ASTRA_ALLOW_LOCAL_BOT_AUTH, so it does not exist at all on
 *     a deployed server — only on the leader's own machine, where the file is
 *     already sitting on the same disk.
 *  3. It is never logged, never stored by the caller, and never echoed back by
 *     /api/bot/summon, which reports only the shape of what it received.
 *
 * PHASE 2 removes this route. The bot container fetches the object straight
 * from Supabase Storage at `leaders/{user_id}/auth.json` with a short-lived
 * signed URL, so the credential never travels through a browser at all. Round-
 * tripping it through an extension is a Phase-1 convenience, not a design.
 */

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: Request) {
  return route(async () => {
    const { user } = await requireCaller(request);

    if (!localBotAuthEnabled()) {
      throw new ApiError(
        503,
        "Bot credentials are not served by this deployment. They live on the " +
          "machine where the leader authenticated, and in Phase 2 the bot container " +
          "reads them straight from Supabase Storage instead.",
      );
    }

    const status = await readBotAuthStatus(user.id);
    if (status.state !== "authenticated" || !status.filePresent) {
      throw new ApiError(
        404,
        "Your bot account is not authenticated on this machine. Open Astra → " +
          "Settings → Bot Account Setup and authenticate it first.",
      );
    }

    let storageState: unknown;
    try {
      storageState = JSON.parse(await readFile(leaderPaths(user.id).auth, "utf8"));
    } catch (error) {
      throw new ApiError(
        500,
        `The credentials file could not be read: ${(error as Error).message}`,
      );
    }

    return withCors(
      json({
        // The Playwright storage state, verbatim — cookies plus origins. This
        // is exactly what the bot container needs to launch pre-authenticated.
        ...(storageState as Record<string, unknown>),
        google_email: status.googleEmail,
        expires_at: status.expiresAt,
      }),
    );
  }).then(withCors);
}
