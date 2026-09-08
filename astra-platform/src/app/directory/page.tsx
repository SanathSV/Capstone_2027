import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { DirectoryManager } from "@/components/DirectoryManager";
import { getEmployees } from "@/lib/db/queries";
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

  const employees = await getEmployees();

  return (
    <Shell email={user.email ?? ""}>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-white">Resource Pool</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-500">
          The company directory. Every person here can be pulled onto any team, and the
          handles you record are what the context engine uses to work out who did what
          in GitHub, Jira and Slack.
        </p>
      </div>

      <DirectoryManager employees={employees} currentUserId={user.id} />
    </Shell>
  );
}
