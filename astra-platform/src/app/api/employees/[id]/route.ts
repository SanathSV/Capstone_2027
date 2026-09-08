import { ApiError, assertUuid, cleanString, json, readJson, requireUser, route } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { validateHandles } from "@/lib/validation";
import type { Employee } from "@/lib/db/types";

export const dynamic = "force-dynamic";

interface Params {
  params: { id: string };
}

export async function PATCH(request: Request, { params }: Params) {
  return route(async () => {
    await requireUser();
    const id = assertUuid(params.id, "Employee id");
    const body = await readJson<Record<string, unknown>>(request);

    // Only the keys actually present are touched, so the directory form can
    // send a single field without blanking the rest of the row.
    const patch: Record<string, unknown> = {};
    if ("full_name" in body) {
      patch.full_name = cleanString(body.full_name, {
        field: "Name",
        max: 120,
        required: true,
      });
    }
    if ("email" in body) {
      const email = cleanString(body.email, { field: "Email", max: 254, required: true })!;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new ApiError(400, "That does not look like an email address.");
      }
      patch.email = email;
    }
    if ("title" in body) {
      patch.title = cleanString(body.title, { field: "Title", max: 120 });
    }
    if ("github_username" in body || "jira_account_id" in body || "slack_user_id" in body) {
      const { github, slack, jira } = validateHandles(body);
      if ("github_username" in body) patch.github_username = github;
      if ("slack_user_id" in body) patch.slack_user_id = slack;
      if ("jira_account_id" in body) patch.jira_account_id = jira;
    }

    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, "Nothing to update.");
    }

    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("employees")
      .update(patch)
      .eq("id", id)
      .select("*")
      .maybeSingle();

    if (error?.code === "23505") {
      throw new ApiError(409, "Another directory entry already uses that email.");
    }
    if (error) throw new ApiError(400, error.message);
    if (!data) throw new ApiError(404, "That person is not in the resource pool.");

    return json({ employee: data as Employee });
  });
}

export async function DELETE(_request: Request, { params }: Params) {
  return route(async () => {
    await requireUser();
    const id = assertUuid(params.id, "Employee id");

    const supabase = createSupabaseServerClient();
    // Deleting cascades into every team's roster, so the RLS policy limits it
    // to whoever added the person. A row we cannot delete simply does not come
    // back from the returning clause.
    const { data, error } = await supabase
      .from("employees")
      .delete()
      .eq("id", id)
      .select("id")
      .maybeSingle();

    if (error) throw new ApiError(400, error.message);
    if (!data) {
      throw new ApiError(
        403,
        "Only the person who added this employee can remove them from the directory.",
      );
    }

    return json({ deleted: id });
  });
}
