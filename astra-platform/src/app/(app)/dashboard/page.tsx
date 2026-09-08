import { redirect } from "next/navigation";
import { Empty } from "@/components/Empty";
import { ProgressLink } from "@/components/Navigation";
import { TeamCard } from "@/components/TeamCard";
import { getDashboardTeams } from "@/lib/db/queries";
import { getSessionUser } from "@/lib/supabase/server";

/**
 * Teams overview.
 *
 * The two sections are a partition of what RLS returned, so a team appears in
 * exactly one of them: you either lead it or you are on it.
 *
 * A server component: the query runs on the server and only rows the policies
 * allow ever reach the browser. The cards are client components purely for
 * their pending state, and receive plain data.
 */

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login");

  const { lead, member } = await getDashboardTeams(user.id);

  return (
    <>
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">Teams</h1>
          <p className="mt-1 text-sm text-slate-500">
            Every team you lead or belong to. Open one to configure its integrations
            and generate the bot&rsquo;s pre-context.
          </p>
        </div>
        <ProgressLink href="/teams/new" className="btn-primary" spinnerClassName="h-4 w-4">
          <PlusIcon />
          New team
        </ProgressLink>
      </div>

      <section className="mb-10">
        <SectionHeading
          title="Teams I Lead"
          count={lead.length}
          hint="You own the roster, the credentials, and the pre-context button."
        />
        {lead.length === 0 ? (
          <Empty
            title="You do not lead a team yet"
            body="Create one and you are registered as its Leader automatically. You will be able to pick people out of the resource pool and give each of them a sprint role."
            action={{ href: "/teams/new", label: "Create a team" }}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {lead.map((team) => (
              <TeamCard key={team.id} team={team} />
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading
          title="Teams I am In"
          count={member.length}
          hint="Teams where someone else holds the credentials."
        />
        {member.length === 0 ? (
          <Empty
            title="You are not on anyone else's team"
            body="When a leader adds your work email to the resource pool and puts you on their roster, that team shows up here."
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {member.map((team) => (
              <TeamCard key={team.id} team={team} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function SectionHeading({
  title,
  count,
  hint,
}: {
  title: string;
  count: number;
  hint: string;
}) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-300">
          {title}
        </h2>
        <span className="rounded-full bg-ink-800 px-2 py-0.5 text-[11px] text-slate-400">
          {count}
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-600">{hint}</p>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  );
}
