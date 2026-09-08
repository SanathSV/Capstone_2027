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
import type { TeamMemberWithEmployee } from "@/lib/db/types";

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
      .from("team_members")
      .select(`*, employee:employees ( * )`)
      .eq("team_id", teamId)
      .order("is_lead", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) throw new ApiError(500, error.message);
    return json({ members: (data ?? []) as unknown as TeamMemberWithEmployee[] });
  });
}

/** Seat one or more resource-pool employees on the team. */
export async function POST(request: Request, { params }: Params) {
  return route(async () => {
    const teamId = assertUuid(params.id, "Team id");
    await requireTeamLeader(teamId);

    const body = await readJson<{
      employee_id?: string;
      sprint_role?: string;
      members?: { employee_id: string; sprint_role?: string }[];
    }>(request);

    // Accept one member or a batch: the team page adds one at a time, the
    // wizard adds a whole roster.
    const incoming = body.members ?? (body.employee_id
      ? [{ employee_id: body.employee_id, sprint_role: body.sprint_role }]
      : []);

    if (!incoming.length) throw new ApiError(400, "No employees given.");

    const rows = incoming.map((m) => ({
      team_id: teamId,
      employee_id: assertUuid(m.employee_id, "Employee id"),
      sprint_role:
        cleanString(m.sprint_role, { field: "Sprint role", max: 60 }) ?? "Engineer",
    }));

    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("team_members")
      .upsert(rows, { onConflict: "team_id,employee_id", ignoreDuplicates: true })
      .select(`*, employee:employees ( * )`);

    if (error) throw new ApiError(400, error.message);
    return json({ members: (data ?? []) as unknown as TeamMemberWithEmployee[] }, 201);
  });
}
