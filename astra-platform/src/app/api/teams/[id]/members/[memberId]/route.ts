import {
  ApiError,
  assertUuid,
  cleanString,
  json,
  readJson,
  requireTeamLeader,
  route,
} from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { TeamMember } from "@/lib/db/types";

export const dynamic = "force-dynamic";

interface Params {
  params: { id: string; memberId: string };
}

/** Change someone's sprint role. */
export async function PATCH(request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    const memberId = assertUuid(params.memberId, "Member id");
    await requireTeamLeader(teamId);

    const body = await readJson<{ sprint_role?: string }>(request);
    const sprint_role = cleanString(body.sprint_role, {
      field: "Sprint role",
      max: 60,
      required: true,
    })!;

    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("team_members")
      .update({ sprint_role })
      .eq("id", memberId)
      .eq("team_id", teamId)
      .select("*")
      .maybeSingle();

    if (error) throw new ApiError(400, error.message);
    if (!data) throw new ApiError(404, "That person is not on this team.");
    return json({ member: data as TeamMember });
  });
}

/** Remove someone from the team (they stay in the resource pool). */
export async function DELETE(_request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    const memberId = assertUuid(params.memberId, "Member id");
    await requireTeamLeader(teamId);

    const supabase = createSupabaseServerClient();

    const { data: seat, error: readError } = await supabase
      .from("team_members")
      .select("id, is_lead")
      .eq("id", memberId)
      .eq("team_id", teamId)
      .maybeSingle();

    if (readError) throw new ApiError(500, readError.message);
    if (!seat) throw new ApiError(404, "That person is not on this team.");
    // The leader's own seat is what makes the team visible to them and what the
    // context payload marks as `lead`. Removing it would strand the team.
    if (seat.is_lead) {
      throw new ApiError(
        409,
        "The team leader cannot be removed from their own team. Delete the team instead.",
      );
    }

    const { error } = await supabase
      .from("team_members")
      .delete()
      .eq("id", memberId)
      .eq("team_id", teamId);

    if (error) throw new ApiError(400, error.message);
    return json({ removed: memberId });
  });
}
