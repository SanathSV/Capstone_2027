import { ApiError, json, readJson, route } from "@/lib/api";
import { corsPreflight, requireCaller, withCors } from "@/lib/apiAuth";
import {
  formatSummonLog,
  summariseCredentials,
  summarisePreContext,
} from "@/lib/botSummon";
import { writeSummonDump } from "@/lib/requestDump";

/**
 * POST /api/bot/summon — the Chrome extension asking for a bot in a meeting.
 *
 * This is the seam between the dashboard and the bot fleet. In Phase 1 it is a
 * dummy: it authenticates the caller, checks the four fields are really there,
 * prints them, and acknowledges. In Phase 2 it launches the container.
 *
 * Authentication is by bearer token, because the caller is an extension on its
 * own origin with no cookies for this site. Leadership is then checked against
 * the database rather than taken from the request — a team id is trivially
 * forged, and the whole point of the check is that it cannot be.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface SummonBody {
  team_id?: string;
  meet_link?: string;
  pre_context?: Record<string, unknown> | null;
  bot_credentials?: Record<string, unknown> | null;
}

/** Meet room codes are three-four-three lowercase letters. */
const MEET_URL = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(\?.*)?$/i;

export function OPTIONS() {
  return corsPreflight();
}

export async function POST(request: Request) {
  return route(async () => {
    const { user, supabase, via } = await requireCaller(request);
    const body = await readJson<SummonBody>(request);

    const teamId = body.team_id?.trim();
    const meetLink = body.meet_link?.trim();

    if (!teamId) throw new ApiError(400, "team_id is required.");
    if (!meetLink) throw new ApiError(400, "meet_link is required.");
    if (!MEET_URL.test(meetLink)) {
      throw new ApiError(
        400,
        `"${meetLink}" is not a Google Meet link. Expected https://meet.google.com/xxx-yyyy-zzz.`,
      );
    }

    const { data: team, error } = await supabase
      .from("teams")
      .select("id, name, leader_id")
      .eq("id", teamId)
      .maybeSingle();

    if (error) throw new ApiError(500, error.message);
    if (!team) throw new ApiError(404, "Team not found.");
    if (team.leader_id !== user.id) {
      throw new ApiError(403, "Only the team leader can summon the bot for this team.");
    }

    const context = summarisePreContext(body.pre_context);
    const creds = summariseCredentials(body.bot_credentials);

    // The four fields, for the terminal. Counts and states only — never a
    // cookie value; see the note in formatSummonLog.
    console.log(
      formatSummonLog({
        teamId: team.id,
        teamName: team.name,
        meetLink,
        callerEmail: user.email ?? user.id,
        via,
        context,
        creds,
      }),
    );

    // The same request, written verbatim to _sent_data_extension/ so it can be
    // inspected, diffed, or fed to a bot container. Unlike the log above this
    // file DOES contain the credentials, which is why the directory gitignores
    // itself — see the header of requestDump.ts.
    const dump = await writeSummonDump({
      received_at: new Date().toISOString(),
      caller: { id: user.id, email: user.email ?? null, via },
      team: { id: team.id, name: team.name },
      meet_link: meetLink,
      body: {
        team_id: teamId,
        meet_link: meetLink,
        pre_context: body.pre_context ?? null,
        bot_credentials: body.bot_credentials ?? null,
      },
      summary: { pre_context: context, bot_credentials: creds },
    });

    if (dump) {
      console.log(
        `  ↳ saved to ${dump.path}` +
          `  (${(dump.bytes / 1024).toFixed(1)} KB${dump.redacted ? ", cookies redacted" : ""})\n`,
      );
    }

    // PHASE 2: launch the ephemeral bot container here — the pre-context
    // payload injected as a ConfigMap or env file, and the credentials mounted
    // from Supabase Storage at leaders/{user_id}/auth.json rather than being
    // round-tripped through the browser as they are in Phase 1.

    return withCors(
      json({
        status: "success",
        message: "Bot connect payload received with full credentials and context",
        // Where the full request was written, so the caller can point a script
        // at it without guessing the filename.
        saved_to: dump?.path ?? null,
        received: {
          team_id: team.id,
          team_name: team.name,
          meet_link: meetLink,
          pre_context: context,
          bot_credentials: {
            present: creds.present,
            state: creds.state,
            auth_cookies: creds.auth_cookies ?? 0,
          },
        },
      }),
    );
  }).then(withCors);
}
