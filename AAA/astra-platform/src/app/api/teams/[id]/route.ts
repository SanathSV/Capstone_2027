import {
  ApiError,
  assertUuid,
  cleanString,
  json,
  readJson,
  requireTeamAccess,
  requireTeamLeader,
  route,
} from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Team } from "@/lib/db/types";

export const dynamic = "force-dynamic";

interface Params {
  params: { id: string };
}

export async function GET(_request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    await requireTeamAccess(teamId);

    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("teams")
      .select("*")
      .eq("id", teamId)
      .single();

    if (error) throw new ApiError(500, error.message);
    return json({ team: data as Team });
  });
}

export async function PATCH(request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    await requireTeamLeader(teamId);

    const body = await readJson<Record<string, unknown>>(request);
    const patch: Record<string, unknown> = {};

    if ("name" in body) {
      patch.name = cleanString(body.name, { field: "Team name", max: 120, required: true });
    }
    if ("description" in body) {
      patch.description = cleanString(body.description, {
        field: "Description",
        max: 2000,
      });
    }
    if ("sprint_name" in body) {
      patch.sprint_name = cleanString(body.sprint_name, { field: "Sprint", max: 120 });
    }

    if (!Object.keys(patch).length) throw new ApiError(400, "Nothing to update.");

    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("teams")
      .update(patch)
      .eq("id", teamId)
      .select("*")
      .single();

    if (error) throw new ApiError(400, error.message);
    return json({ team: data as Team });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    await requireTeamLeader(teamId);

    const supabase = createSupabaseServerClient();
    // Roster, integrations and run history all cascade from the schema's
    // foreign keys, so one delete is the whole teardown.
    const { error } = await supabase.from("teams").delete().eq("id", teamId);
    if (error) throw new ApiError(400, error.message);
    return json({ deleted: teamId });
  });
}
