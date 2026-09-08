import { ApiError, cleanString, json, readJson, requireUser, route } from "@/lib/api";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { validateHandles } from "@/lib/validation";
import type { Employee } from "@/lib/db/types";

/**
 * The resource pool: the company directory every team draws from.
 *
 * The three handle fields are the whole point of this table — they are what
 * lets the context engine say "PR #418 was opened by Grace Hopper, the Tech
 * Lead" instead of "PR #418 was opened by gracehopper".
 */

export const dynamic = "force-dynamic";

interface EmployeeBody {
  full_name?: string;
  email?: string;
  title?: string;
  github_username?: string;
  jira_account_id?: string;
  slack_user_id?: string;
}

export async function GET() {
  return route(async () => {
    await requireUser();
    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("employees")
      .select("*")
      .order("full_name", { ascending: true });

    if (error) throw new ApiError(500, error.message);
    return json({ employees: (data ?? []) as Employee[] });
  });
}

export async function POST(request: Request) {
  return route(async () => {
    const user = await requireUser();
    const body = await readJson<EmployeeBody>(request);

    const full_name = cleanString(body.full_name, {
      field: "Name",
      max: 120,
      required: true,
    })!;
    const email = cleanString(body.email, { field: "Email", max: 254, required: true })!;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new ApiError(400, "That does not look like an email address.");
    }
    const title = cleanString(body.title, { field: "Title", max: 120 });
    const { github, slack, jira } = validateHandles(body);

    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase
      .from("employees")
      .insert({
        full_name,
        email,
        title,
        github_username: github,
        jira_account_id: jira,
        slack_user_id: slack,
        created_by: user.id,
      })
      .select("*")
      .single();

    // 23505 is unique_violation: the directory already has this person.
    if (error?.code === "23505") {
      throw new ApiError(409, `${email} is already in the resource pool.`);
    }
    if (error) throw new ApiError(400, error.message);

    return json({ employee: data as Employee }, 201);
  });
}
