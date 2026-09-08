import { redirect } from "next/navigation";
import { ProgressLink } from "@/components/Navigation";
import { CreateTeamWizard } from "@/components/CreateTeamWizard";
import { getEmployees } from "@/lib/db/queries";
import { getSessionUser } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function NewTeamPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const employees = await getEmployees();

  return (
    <>
      <div className="mb-6">
        <ProgressLink href="/dashboard" className="text-xs text-slate-500 hover:text-slate-300">
          ← Teams
        </ProgressLink>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-white">
          New team
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          You are registered as the Leader of whatever you create here.
        </p>
      </div>

      <CreateTeamWizard employees={employees} />
    </>
  );
}
