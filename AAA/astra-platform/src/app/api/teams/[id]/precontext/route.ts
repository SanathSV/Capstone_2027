import { assertUuid, json, route } from "@/lib/api";
import { corsPreflight, requireCaller, withCors } from "@/lib/apiAuth";
import { buildPreContext } from "@/lib/preContextService";
import { renderPreContextMarkdown } from "@/lib/context/markdown";
import type { PreContextPayload } from "@/lib/context/types";
import type { PreContextRun } from "@/lib/db/types";

/**
 * GET /api/teams/:id/precontext — the payload, for the extension's prefetch.
 *
 * Returns **Markdown**, because the value is bound for a context window rather
 * than a parser. On a real payload it is about half the tokens of the same data
 * as minified JSON: a table names each column once where an array of objects
 * repeats every key on every row. See COMPACTION_ALGO.md.
 *
 * Same engine as the dashboard's button — both call `buildPreContext()` — so
 * the extension can never get a payload the dashboard would not have produced.
 * The only difference is when it settles for a stored run:
 *
 *   1. A run under `FRESH_SECONDS` is re-rendered from its stored payload.
 *   2. Otherwise it generates, exactly as the dashboard does.
 *
 * `?format=json` returns the structured payload instead, for anything that
 * needs to read fields rather than reason about prose. `?refresh=1` forces a
 * fresh harvest.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface Params {
  params: { id: string };
}

/** A run younger than this is good enough to hand straight back. */
const FRESH_SECONDS = 10 * 60;

export function OPTIONS() {
  return corsPreflight();
}

export async function GET(request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    const { user, supabase } = await requireCaller(request);

    const url = new URL(request.url);
    const forceRefresh = url.searchParams.get("refresh") === "1";
    const wantJson = url.searchParams.get("format") === "json";

    let payload: PreContextPayload | null = null;
    let generatedAt: string | null = null;
    let runId: string | null = null;
    let status = "success";
    let source: "cache" | "generated" = "cache";

    if (!forceRefresh) {
      const { data } = await supabase
        .from("pre_context_runs")
        .select("id, status, payload, created_at")
        .eq("team_id", teamId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const run = data as Pick<
        PreContextRun,
        "id" | "status" | "payload" | "created_at"
      > | null;

      if (run?.payload) {
        const ageSeconds = (Date.now() - Date.parse(run.created_at)) / 1000;
        if (ageSeconds < FRESH_SECONDS) {
          payload = run.payload as PreContextPayload;
          generatedAt = run.created_at;
          runId = run.id;
          status = run.status;
        }
      }
    }

    let markdown: string;

    if (payload) {
      // Rendered on read rather than stored: the audit row keeps the structured
      // payload, so improving the renderer improves every past run too.
      markdown = renderPreContextMarkdown(payload);
    } else {
      const built = await buildPreContext({ teamId, userId: user.id, supabase, log: false });
      payload = built.payload;
      markdown = built.markdown;
      generatedAt = built.payload.meta.generated_at;
      runId = built.runId;
      status = built.status;
      source = "generated";
    }

    const ageSeconds = generatedAt
      ? Math.round((Date.now() - Date.parse(generatedAt)) / 1000)
      : 0;
    const tokenEstimate = Math.ceil(markdown.length / 4);

    return withCors(
      json({
        team_id: teamId,
        run_id: runId,
        status,
        /** "cache" or "generated" — so a slow response is explicable. */
        source,
        generated_at: generatedAt,
        age_seconds: ageSeconds,
        stale: ageSeconds > 24 * 60 * 60,
        format: wantJson ? "json" : "markdown",
        token_estimate: wantJson ? (payload.meta?.token_estimate ?? null) : tokenEstimate,
        /** What the JSON would have cost, so the saving is visible. */
        json_token_estimate: Math.ceil(JSON.stringify(payload).length / 4),
        // The value the bot is briefed with.
        payload: wantJson ? payload : markdown,
      }),
    );
  }).then(withCors);
}
