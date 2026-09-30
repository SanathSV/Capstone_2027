import { ApiError, assertUuid, json, requireTeamLeader, route } from "@/lib/api";
import { getChatContext, NoContextError } from "@/lib/chatContext";

/**
 * GET /api/teams/:id/chat-context — exactly the briefing the chat is using.
 *
 * Deliberately NOT `/precontext`, which the extension uses. That one treats a
 * run older than ten minutes as stale and re-harvests, because it is about to
 * put a bot in a live meeting and wants current facts. Calling it merely to
 * *display* what the assistant knows would fire a three-API harvest — and, on a
 * team whose stored credentials cannot be decrypted, fail outright with a 500
 * for a panel that only wanted to show some text.
 *
 * This goes through `getChatContext`, so it returns the same bytes the last
 * answer was grounded in, hits the same in-process memo, and never triggers
 * work the caller did not ask for. `?refresh=1` is the way to ask for it.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request, { params }: { params: { id: string } }) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    // Leader-only, matching /api/chat: this returns the briefing verbatim, so
    // it must not be a way around the check that guards the chat itself.
    const user = await requireTeamLeader(teamId);

    const refresh = new URL(request.url).searchParams.get("refresh") === "1";

    try {
      const context = await getChatContext(teamId, user.id, { refresh });
      return json({
        markdown: context.markdown,
        generated_at: context.generatedAt,
        age_seconds: context.ageSeconds,
        source: context.source,
        stale: context.stale,
        chars: context.markdown.length,
      });
    } catch (error) {
      if (error instanceof NoContextError) throw new ApiError(409, error.message);
      throw error;
    }
  });
}
