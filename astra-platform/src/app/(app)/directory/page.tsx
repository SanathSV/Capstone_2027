import { redirect } from "next/navigation";
import { DirectoryManager } from "@/components/DirectoryManager";
import { getEmployees, getMyProfile } from "@/lib/db/queries";
import { getSessionUser } from "@/lib/supabase/server";

/**
 * The resource pool: one shared company directory that every team draws from.
 * Deliberately not scoped per team — the same engineer sits on two squads and
 * should carry one set of handles, not two that drift apart.
 */

export const dynamic = "force-dynamic";

export default async function DirectoryPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const [employees, profile] = await Promise.all([
    getEmployees(),
    getMyProfile(user.id),
  ]);
  const isAdmin = profile?.role === "admin";

  return (
    <>
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Resource Pool
          </h1>
          {isAdmin ? (
            <span className="chip border-astra-500/30 bg-astra-500/10 text-astra-300">
              Admin
            </span>
          ) : (
            <span className="chip">Read only</span>
          )}
        </div>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          The company directory. Every person here can be pulled onto any team, and the
          handles you record are what the context engine uses to work out who did what
          in GitHub, Jira and Slack.
        </p>
      </div>

      <DirectoryManager employees={employees} isAdmin={isAdmin} />
    </>
  );
}
