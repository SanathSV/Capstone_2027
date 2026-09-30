import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { getDashboardTeams } from "@/lib/db/queries";
import { getSessionUser } from "@/lib/supabase/server";

/**
 * The shell for every signed-in page.
 *
 * Living in a layout rather than inside each page is what makes navigation feel
 * instant: React keeps this subtree mounted across a route change, so the
 * header, the nav and the progress bar survive while only the content below
 * them is replaced. Rendered per-page, as it was before, every click tore down
 * the entire chrome and rebuilt it — which is why a fast navigation still
 * looked like a full page load.
 *
 * The auth check lives here too, so each page can assume a user and the
 * redirect happens once for the whole group rather than in five places.
 *
 * `(app)` is a route group: it organises the tree without appearing in any URL,
 * so /dashboard is still /dashboard.
 */

export const dynamic = "force-dynamic";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSessionUser();
  // The middleware already redirects signed-out visitors; this is the
  // belt-and-braces case where a session expires between the two.
  if (!user) redirect("/login");

  // Loaded here rather than per-page so the chat panel's team switcher is
  // populated on every screen — including Settings, where there is no other
  // reason to know what teams exist. It is one query the dashboard was making
  // anyway, and the layout is not re-rendered on navigation.
  //
  // TEAMS YOU LEAD ONLY. Astra answers from the team's sprint context, and
  // assembling that reads the team's stored GitHub/Jira credentials — which RLS
  // restricts to the leader. A member could only ever have been served a cached
  // briefing they could not refresh, so the feature was quietly worse for them
  // than for anybody else. Better to scope it honestly than to ship a degraded
  // version and explain it in a tooltip.
  const { lead } = await getDashboardTeams(user.id);
  const chatTeams = lead.map((t) => ({ id: t.id, name: t.name, i_lead: true }));

  return (
    <Shell email={user.email ?? ""} chatTeams={chatTeams}>
      {children}
    </Shell>
  );
}
