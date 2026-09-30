import { assertUuid, json, requireTeamAccess, route } from "@/lib/api";
import { getTeamMeetings } from "@/lib/db/queries";

/**
 * GET /api/teams/:id/meetings — every meeting the bot has held for this team.
 *
 * `requireTeamAccess` rather than `requireTeamLeader`: a transcript is a record
 * of a meeting the whole team was in, and hiding it from everyone but the
 * leader would make it useless as one. RLS enforces the same rule a second time
 * at the row level, so a forged team id in the URL still returns nothing.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    await requireTeamAccess(teamId);
    return json({ meetings: await getTeamMeetings(teamId) });
  });
}
