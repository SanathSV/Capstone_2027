import { ApiError, assertUuid, json, requireTeamAccess, requireUser, route } from "@/lib/api";
import { getMeetingDetail } from "@/lib/db/queries";

/**
 * GET /api/meetings/:meetingId — the meeting, and everything said in it.
 *
 * Access is checked against the meeting's TEAM, not the meeting: the row itself
 * carries no notion of who may read it, and `team_id` can be null when the
 * container's lookup failed at summon time — in which case `team_ref` holds the
 * id the extension sent, and that is what gets checked instead. Skipping that
 * fallback would make a meeting recorded during a database blip unreadable to
 * its own team forever.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: { meetingId: string } },
) {
  return route(async () => {
    const meetingId = assertUuid(params.meetingId, "Meeting id");
    await requireUser();

    const detail = await getMeetingDetail(meetingId);
    if (!detail) throw new ApiError(404, "No such meeting.");

    const teamRef = detail.meeting.team_id ?? detail.meeting.team_ref;
    const isUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamRef);
    if (!isUuid) {
      // A meeting recorded against a scratch workspace id belongs to no team,
      // so there is nobody it can be shown to.
      throw new ApiError(403, "This meeting is not linked to a team you can see.");
    }
    await requireTeamAccess(teamRef);

    return json(detail);
  });
}
