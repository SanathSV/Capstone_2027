import type { LucideIcon } from "lucide-react";
import { Activity, Plug, Users } from "lucide-react";

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
}

export const navItems: NavItem[] = [
  {
    label: "Sessions",
    href: "/dashboard/sessions",
    icon: Activity,
    description: "Live and past meeting captures",
  },
  {
    label: "Team",
    href: "/dashboard/team",
    icon: Users,
    description: "Roster and identity mapping",
  },
  {
    label: "Integrations",
    href: "/dashboard/integrations",
    icon: Plug,
    description: "Jira, GitHub and Google Workspace",
  },
];

/** Maps a pathname to its breadcrumb trail, e.g. Dashboard / Team. */
export function breadcrumbsFor(pathname: string): string[] {
  const match = navItems.find((item) => pathname.startsWith(item.href));
  return match ? ["Dashboard", match.label] : ["Dashboard"];
}
