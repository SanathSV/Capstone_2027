import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Shared plumbing for the route handlers: uniform errors, an auth guard, and a
 * leader guard. Keeping them in one file is what lets every route be four lines
 * of actual logic.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function json<T>(body: T, status = 200) {
  return NextResponse.json(body, { status });
}

/**
 * Wraps a handler so a thrown ApiError becomes its status and anything else
 * becomes a 500 — with the real message logged server-side but never leaked to
 * the client, since these messages can quote database internals.
 */
export function route<T>(handler: () => Promise<NextResponse<T>>) {
  return handler().catch((error: unknown) => {
    if (error instanceof ApiError) {
      return NextResponse.json(
        { error: error.message, detail: error.detail ?? null },
        { status: error.status },
      );
    }
    console.error("[astra:api] unhandled error:", error);
    return NextResponse.json(
      { error: "Something went wrong on the server." },
      { status: 500 },
    );
  });
}

/** The signed-in user, or a 401. */
export async function requireUser(): Promise<User> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) throw new ApiError(401, "Not signed in.");
  return user;
}

/**
 * Proves the caller leads `teamId`, using their own session so RLS does the
 * checking. Everything that touches credentials or triggers an outbound API
 * call goes through here first.
 */
export async function requireTeamLeader(teamId: string): Promise<User> {
  const user = await requireUser();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("teams")
    .select("id, leader_id")
    .eq("id", teamId)
    .maybeSingle();

  const problem = dbError("check team leadership", "authenticated", error);
  if (problem) throw problem;
  // RLS already hid teams the user cannot see, so "not found" and "not yours"
  // are deliberately the same answer: no team-id oracle.
  if (!data) throw new ApiError(404, "Team not found.");
  if (data.leader_id !== user.id) {
    throw new ApiError(403, "Only the team leader can do that.");
  }
  return user;
}

/** Proves the caller can at least see `teamId`. */
export async function requireTeamAccess(teamId: string): Promise<User> {
  const user = await requireUser();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("teams")
    .select("id")
    .eq("id", teamId)
    .maybeSingle();

  if (error) throw new ApiError(500, error.message);
  if (!data) throw new ApiError(404, "Team not found.");
  return user;
}

/**
 * Proves the caller is an admin.
 *
 * The RLS policies enforce this independently, so this guard is not what
 * makes the app safe — it is what makes the refusal legible. Without it a
 * non-admin POST returns a bare policy violation from PostgREST; with it they
 * get a sentence naming the reason and who can fix it.
 */
export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const problem = dbError("read your profile", "authenticated", error);
  if (problem) throw problem;

  if (data?.role !== "admin") {
    throw new ApiError(
      403,
      "Only an admin can change the resource pool. Ask whoever administers " +
        "Astra to add this person, or to make you an admin.",
    );
  }
  return user;
}

/** Body parsing that fails loudly instead of yielding `undefined` fields. */
export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, "Request body must be valid JSON.");
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assertUuid(value: string, field = "id"): string {
  if (!UUID_RE.test(value)) throw new ApiError(400, `${field} is not a valid id.`);
  return value;
}

/** Trim, collapse empty strings to null, and enforce a length ceiling. */
export function cleanString(
  value: unknown,
  { field, max, required = false }: { field: string; max: number; required?: boolean },
): string | null {
  if (value === null || value === undefined) {
    if (required) throw new ApiError(400, `${field} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new ApiError(400, `${field} must be text.`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (required) throw new ApiError(400, `${field} is required.`);
    return null;
  }
  if (trimmed.length > max) {
    throw new ApiError(400, `${field} must be ${max} characters or fewer.`);
  }
  return trimmed;
}

/**
 * Turns a Supabase/PostgREST error into something the person reading it can
 * act on, tagged with which database role was being used.
 *
 * `permission denied for schema public` is the motivating case: it is a GRANT
 * problem, it says nothing about which of the three roles lacked the grant, and
 * it looks identical whether it came from the user's own session or from the
 * service-role client. Naming the role turns a ten-minute hunt into a one-line
 * answer.
 */
export function dbError(
  step: string,
  role: "authenticated" | "service_role",
  error: { message: string; code?: string } | null,
): ApiError | null {
  if (!error) return null;

  // 42501 = insufficient_privilege. 3F000 = invalid_schema_name, which PostgREST
  // also returns when the role cannot see the schema at all.
  if (error.code === "42501" || /permission denied/i.test(error.message)) {
    return new ApiError(
      500,
      `The database refused the "${step}" step for the ${role} role ` +
        `(${error.message}). This is a missing GRANT, not a policy problem — ` +
        "run supabase/fix-grants.sql in the Supabase SQL Editor.",
      { step, role, code: error.code ?? null },
    );
  }

  return new ApiError(500, `${step} failed: ${error.message}`, {
    step,
    role,
    code: error.code ?? null,
  });
}
