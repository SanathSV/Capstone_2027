import { ApiError, dbError, json, route } from "@/lib/api";
import { requireCaller } from "@/lib/apiAuth";
import { publishBotStatus } from "@/lib/botStatusPublish";
import {
  BotAuthError,
  cancelBotAuth,
  deleteBotAuth,
  describeRun,
  getRun,
  leaderPaths,
  localBotAuthEnabled,
  readBotAuthStatus,
  startBotAuth,
} from "@/lib/botAuth";

/**
 * The Team Leader's Google bot session.
 *
 *   GET     current status, from disk, and any run in flight
 *   POST    open the headful sign-in window
 *   DELETE  revoke: delete the local credentials (or cancel a running sign-in)
 *
 * Keyed on the signed-in user throughout. The user id is never taken from the
 * request — a leader can only ever authenticate their own bot, so there is no
 * id to forge.
 */

export const dynamic = "force-dynamic";
// The POST returns as soon as the browser is launched; the sign-in itself is
// polled. This ceiling only has to cover the spawn.
export const maxDuration = 60;

export async function GET(request: Request) {
  return route(async () => {
    const { user, supabase } = await requireCaller(request);
    const status = await publishBotStatus(supabase, user.id);

    return json({
      status,
      run: describeRun(getRun(user.id)),
      // The UI needs to distinguish "not set up yet" from "cannot be set up
      // here", which are the same badge but completely different advice.
      localFlowEnabled: localBotAuthEnabled(),
      storageKey: leaderPaths(user.id).storageKey,
    });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    const { user } = await requireCaller(request);

    try {
      const run = startBotAuth(user.id);
      return json({ run: describeRun(run) }, 202);
    } catch (error) {
      if (error instanceof BotAuthError) throw new ApiError(error.status, error.message);
      throw error;
    }
  });
}

export async function DELETE(request: Request) {
  return route(async () => {
    const { user, supabase } = await requireCaller(request);
    const url = new URL(request.url);

    // ?cancel=1 stops a sign-in in progress; without it, revoke the credentials.
    if (url.searchParams.get("cancel") === "1") {
      const cancelled = cancelBotAuth(user.id);
      return json({ cancelled, run: describeRun(getRun(user.id)) });
    }

    await deleteBotAuth(user.id);

    const { error } = await supabase
      .from("bot_credentials")
      .update({
        status: "revoked",
        google_email: null,
        cookie_count: null,
        expires_at: null,
        storage_path: null,
        last_error: null,
      })
      .eq("user_id", user.id);

    const problem = dbError("record the revocation", "authenticated", error);
    if (problem) throw problem;

    return json({ revoked: true, status: await readBotAuthStatus(user.id) });
  });
}
