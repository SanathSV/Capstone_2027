"use client";

import { usePathname } from "next/navigation";
import { SignOutButton } from "./SignOutButton";
import {
  NavigationProgress,
  NavigationProvider,
  ProgressLink,
} from "./Navigation";

/**
 * The frame every signed-in page sits in: brand, nav, and who you are.
 *
 * Rendered once by `(app)/layout.tsx` and kept mounted across navigations, so
 * clicking a link swaps only the content beneath it. The progress bar lives in
 * the header for the same reason — it has to outlive the page it is reporting
 * on.
 */

const NAV = [
  { href: "/dashboard", label: "Teams" },
  { href: "/directory", label: "Resource Pool" },
  { href: "/settings", label: "Settings" },
];

export function Shell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  return (
    <NavigationProvider>
      <div className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
            <ProgressLink href="/dashboard" className="flex items-center gap-2.5">
              <AstraMark />
              <span className="text-sm font-semibold tracking-wide text-white">ASTRA</span>
            </ProgressLink>

            <NavLinks />

            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-xs text-slate-500 sm:block">{email}</span>
              <SignOutButton />
            </div>
          </div>
          <NavigationProgress />
        </header>

        <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
      </div>
    </NavigationProvider>
  );
}

/**
 * The current section is marked, and the one you just clicked shows a spinner.
 * Without the first you lose your place; without the second a slow page looks
 * like a dead link.
 */
function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {NAV.map((item) => {
        const active = pathname.startsWith(item.href);
        return (
          <ProgressLink
            key={item.href}
            href={item.href}
            spinnerClassName="h-3 w-3"
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
              active
                ? "bg-ink-800 text-white"
                : "text-slate-400 hover:bg-ink-800/60 hover:text-white"
            }`}
          >
            {item.label}
          </ProgressLink>
        );
      })}
    </nav>
  );
}

/** A small mark rather than a logo file — one less asset to serve. */
export function AstraMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="astra-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8ab4ff" />
          <stop offset="100%" stopColor="#a78bfa" />
        </linearGradient>
      </defs>
      <path
        d="M12 2.5 14.6 9.4 21.5 12 14.6 14.6 12 21.5 9.4 14.6 2.5 12 9.4 9.4Z"
        fill="url(#astra-mark)"
      />
    </svg>
  );
}
