"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { BrandMark } from "@/components/dashboard/brand-mark";
import { navItems } from "@/lib/navigation";
import { cn } from "@/lib/utils";

export interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-r border-slate-800/80 bg-slate-900/40 backdrop-blur-xl",
        "transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
        collapsed ? "w-[68px]" : "w-64",
      )}
    >
      <div className="flex h-14 items-center gap-3 border-b border-slate-800/80 px-4">
        <BrandMark />
        {!collapsed ? (
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-semibold tracking-[0.2em] text-white">
              ASTRA
            </span>
            <span className="truncate text-[10px] uppercase tracking-wider text-slate-600">
              Meeting Intelligence
            </span>
          </div>
        ) : null}
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-3">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              title={collapsed ? item.label : undefined}
              aria-current={active ? "page" : undefined}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                collapsed && "justify-center px-0",
                active
                  ? "bg-indigo/10 text-white"
                  : "text-slate-400 hover:bg-slate-800/50 hover:text-slate-100",
              )}
            >
              {active ? (
                <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-indigo shadow-glow" />
              ) : null}
              <Icon
                className={cn("h-4 w-4 shrink-0", active ? "text-indigo" : "text-slate-500")}
                aria-hidden
              />
              {!collapsed ? <span className="truncate font-medium">{item.label}</span> : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-slate-800/80 p-3">
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-500",
            "transition-colors hover:bg-slate-800/50 hover:text-slate-200",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="h-4 w-4" aria-hidden />
          ) : (
            <PanelLeftClose className="h-4 w-4" aria-hidden />
          )}
          {!collapsed ? <span>Collapse</span> : null}
        </button>
      </div>

      <ProfilePreview collapsed={collapsed} />
    </aside>
  );
}

function ProfilePreview({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-slate-800/80 px-3 py-3",
        collapsed && "justify-center px-0",
      )}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-700/70 bg-slate-800 text-xs font-semibold text-slate-200">
        SV
      </span>
      {!collapsed ? (
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium text-slate-200">Sanath V.</span>
          <span className="truncate text-[11px] text-slate-600">Workspace owner</span>
        </div>
      ) : null}
    </div>
  );
}
