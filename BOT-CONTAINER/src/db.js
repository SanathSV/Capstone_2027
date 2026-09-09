import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";
import { log } from "./log.js";

/**
 * The relational persistence layer: teams -> meetings -> transcripts.
 *
 * ---------------------------------------------------------------------------
 * READS ARE FORBIDDEN WHILE A MEETING IS LIVE
 * ---------------------------------------------------------------------------
 * This module exposes exactly one read (`resolveTeam`) and it runs once, before
 * the browser is launched. After that the container only ever writes.
 *
 * That is a deliberate constraint, not an accident of the current code. Asking
 * Supabase for transcript history to build a prompt would put a network
 * round-trip on the critical path between someone finishing a question and the
 * bot answering it — and it would grow linearly with meeting length, so the
 * bot would get slower the longer the standup ran. The conversation history
 * lives in memory instead (see context.js); the database is a durable record,
 * not a working set.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVICE ROLE KEY
 * ---------------------------------------------------------------------------
 * The container has no user session. It is writing rows on behalf of a meeting
 * it is not a member of, so there is no `auth.uid()` for RLS to match and every
 * insert would be refused by the policies. The service role key bypasses RLS,
 * which is why it must never leave the container — it is not the anon key and
 * it is not safe in a browser.
 */

let client = null;

/**
 * A WebSocket that is never opened.
 *
 * `createClient()` builds a RealtimeClient eagerly, and that constructor calls
 * `WebSocketFactory.getWebSocketConstructor()`, which **throws** when the
 * runtime has no global `WebSocket`:
 *
 *     Node.js detected but native WebSocket not found. Suggested solution:
 *     Ensure you are running Node.js 22+ or provide a WebSocket implementation
 *     via the transport option.
 *
 * A global `WebSocket` only exists from Node 22, and the Playwright base image
 * this container is built on ships Node 20 — so the client blew up on the first
 * summon inside Docker while working fine on a Node 22 laptop.
 *
 * Bumping Node would fix it today and leave the same trap for the next person
 * who changes the base image. This is the durable fix: the container **never
 * uses realtime** — it does four REST operations and no subscriptions — so the
 * honest thing is to hand realtime a transport it will never instantiate and
 * make the Node version irrelevant. The real WebSocket is preferred when there
 * is one, purely so nothing is silently downgraded on a runtime that has it.
 */
class UnusedWebSocket {
  constructor() {
    throw new Error(
      "BOT-CONTAINER does not use Supabase realtime. Something tried to open a " +
        "subscription; use the REST helpers in src/db.js instead.",
    );
  }
}

export function supabase() {
  if (client) return client;
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    throw new Error("Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).");
  }
  client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-astra-client": "bot-container" } },
    realtime: { transport: globalThis.WebSocket ?? UnusedWebSocket },
  });
  return client;
}

/** PostgREST's "you have not run the migration" error, in plain words. */
function explain(error, what) {
  if (!error) return null;
  if (error.code === "PGRST205" || /schema cache/i.test(error.message ?? "")) {
    return new Error(
      `${what} failed: the table is missing from Supabase. Run ` +
        `sql/001_meetings_transcripts.sql in the SQL editor, then wait a few ` +
        `seconds for the schema cache to reload. (${error.message})`,
    );
  }
  if (error.code === "42501" || /permission denied/i.test(error.message ?? "")) {
    return new Error(
      `${what} failed: permission denied. This key is probably the anon key, ` +
        `not the service role key. (${error.message})`,
    );
  }
  return new Error(`${what} failed: ${error.message}`);
}

/**
 * Look up the team the payload names.
 *
 * Astra's own `teams` table is the one in the spec's hierarchy — its column is
 * `name`, which is the spec's `team_name`. We never create a row in it: it
 * requires a `leader_id` referencing a real profile, and inventing one would
 * put a fictional team on somebody's dashboard.
 *
 * An unresolvable id is not fatal. The meeting is still recorded, linked by
 * `team_ref` (the raw string from the payload) with a null `team_id`, so a bot
 * summoned against a scratch workspace still produces a transcript.
 */
export async function resolveTeam(teamId) {
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId);
  if (!isUuid) return { id: null, name: null, description: null, resolved: false };

  const { data, error } = await supabase()
    .from("teams")
    .select("id, name, description")
    .eq("id", teamId)
    .maybeSingle();

  if (error) {
    // A lookup failure must not stop a meeting starting.
    log.warn(`could not resolve team ${teamId}`, error.message);
    return { id: null, name: null, description: null, resolved: false };
  }
  if (!data) return { id: null, name: null, description: null, resolved: false };
  return { id: data.id, name: data.name, description: data.description, resolved: true };
}

/**
 * Open a meeting row.
 *
 * `meeting_number` is assigned by the database, not here: two bots summoned for
 * the same team in the same second would both read the same `max()+1` and
 * collide. The trigger in the migration takes an advisory lock per team, which
 * is the only place that can be done safely.
 */
export async function createMeeting({ teamId, teamRef, meetLink, sessionId }) {
  const { data, error } = await supabase()
    .from("meetings")
    .insert({
      team_id: teamId,
      team_ref: teamRef,
      meet_link: meetLink,
      session_id: sessionId,
      // The row is opened before the browser exists; the session drives it
      // forward through launching -> joining -> in_call from there.
      status: "queued",
    })
    .select("id, meeting_number")
    .single();

  const problem = explain(error, "Creating the meeting row");
  if (problem) throw problem;
  return data;
}

export async function updateMeeting(meetingId, patch) {
  const { error } = await supabase().from("meetings").update(patch).eq("id", meetingId);
  const problem = explain(error, "Updating the meeting row");
  if (problem) throw problem;
}

/**
 * One finalised utterance.
 *
 * Called only from the FIFO queue, which is what keeps `created_at` monotonic
 * within a meeting. `spoken_at` carries the browser's own timestamp so the
 * ordering survives even if two inserts land in the same millisecond.
 */
export async function insertTranscript({ meetingId, speaker, content, spokenAt, kind }) {
  const { error } = await supabase().from("transcripts").insert({
    meeting_id: meetingId,
    speaker_name: (speaker || "Unknown").slice(0, 120),
    content: String(content).slice(0, 8000),
    spoken_at: spokenAt ?? new Date().toISOString(),
    kind: kind ?? "speech",
  });
  const problem = explain(error, "Saving a transcript line");
  if (problem) throw problem;
}

/** Cheap connectivity probe for /health — one row, no data. */
export async function ping() {
  const { error } = await supabase().from("meetings").select("id").limit(1);
  return error ? { ok: false, error: error.message } : { ok: true };
}
