import type { SupabaseClient } from "@supabase/supabase-js";
import { localBotAuthEnabled, readBotAuthStatus, type BotAuthStatus } from "@/lib/botAuth";

/**
 * Mirrors a leader's on-disk bot status into `bot_credentials`.
 *
 * The credential is a file on one machine; this row is how everyone else finds
 * out about it. A team member opening a team page needs to know whether the
 * leader's bot can join, and the file that answers that is on the leader's
 * laptop, not the server they are both talking to.
 *
 * Which means the row is only ever as current as the last time the leader's own
 * browser hit the server. That is the whole reason this is a shared function
 * rather than something buried in one route: it has to be called from every
 * place the leader's status is read, or the dashboard says "Authenticated" while
 * every team page still says "Not Authenticated" — which is exactly what
 * happened when only `GET /api/bot-auth` published and the Settings page read
 * the disk directly.
 *
 * Never throws. A stale badge is a nuisance; a Settings page that 500s because
 * a status write failed is worse.
 */
export async function publishBotStatus(
  supabase: SupabaseClient,
  userId: string,
): Promise<BotAuthStatus> {
  const status = await readBotAuthStatus(userId);

  // A hosted website has no local session to publish. Do not overwrite the
  // leader's existing bot record just because this machine has no auth file.
  if (!localBotAuthEnabled()) return status;

  const { error } = await supabase.from("bot_credentials").upsert(
    {
      user_id: userId,
      // 'failed' is a run outcome, not a stored credential state; the table
      // records what the leader *has*, which in that case is nothing.
      status: status.state === "failed" ? "none" : status.state,
      google_email: status.googleEmail,
      cookie_count: status.cookieCount,
      expires_at: status.expiresAt,
      // PHASE 2: becomes the Supabase Storage key leaders/{user_id}/auth.json.
      storage_path: status.storagePath,
      last_error: status.error,
    },
    { onConflict: "user_id" },
  );

  if (error) {
    // PGRST205 means the table is missing from PostgREST's schema cache, which
    // in practice means the migration has not been applied — or was applied and
    // then wiped by re-running schema.sql, whose cascade on `profiles` takes
    // this table with it. Say so, rather than leaving a silently wrong badge.
    const hint =
      error.code === "PGRST205"
        ? " — run ../astra-extras/supabase/schema.sql (it now creates bot_credentials), then " +
          "reload the schema cache under Settings → API"
        : "";
    console.error(`[astra:bot-status] could not publish: ${error.message}${hint}`);
  }

  return status;
}
