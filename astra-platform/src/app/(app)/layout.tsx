import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
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

  return <Shell email={user.email ?? ""}>{children}</Shell>;
}
