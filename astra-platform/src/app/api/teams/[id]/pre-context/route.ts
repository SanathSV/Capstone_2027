import { assertUuid, json, route } from "@/lib/api";
import { requireCaller } from "@/lib/apiAuth";
import { buildPreContext } from "@/lib/preContextService";

/**
 * POST /api/teams/:id/pre-context — the "Generate Pre-Context" button.
 *
 * Always generates. The dashboard's button means "go and look right now", so
 * there is no cache to consult; `GET .../precontext` is the one that settles
 * for a recent run when the caller wants an answer immediately.
 *
 * Everything it does lives in `buildPreContext()`, shared with that GET so the
 * two can never drift into producing different payloads:
 *
 *   1. Prove the caller leads this team (RLS, with their own session).
 *   2. Read the roster with that same session.
 *   3. Read + decrypt the credentials with the service role, strictly after 1.
 *   4. Fan out to GitHub / Jira / Slack, analyse, compact.
 *   5. Log the run, and console.log the payload for the terminal.
 *
 * Nothing is cached between clicks: sprint state moves, and a stale payload is
 * worse than a slow one.
 */

export const dynamic = "force-dynamic";
// Three third-party APIs with retries. The Node default would cut a slow Jira
// site off mid-flight and report a timeout that is really ours.
export const maxDuration = 60;

interface Params {
  params: { id: string };
}

export async function POST(request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    const { user, supabase } = await requireCaller(request);

    const { payload, markdown, status, runId } = await buildPreContext({
      teamId,
      userId: user.id,
      supabase,
      log: true,
    });

    return json({
      status,
      run_id: runId,
      generated_at: payload.meta.generated_at,
      // Both: the panel renders its analysis from the structured form, and
      // shows the markdown because that is the artefact the bot receives.
      payload,
      markdown,
      token_estimate: {
        markdown: Math.ceil(markdown.length / 4),
        json: payload.meta.token_estimate,
      },
    });
  });
}
