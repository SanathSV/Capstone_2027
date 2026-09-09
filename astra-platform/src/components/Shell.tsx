"use client";

import { usePathname } from "next/navigation";
import { SignOutButton } from "./SignOutButton";
import { ThemeToggle } from "./ThemeToggle";
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
        <header className="sticky top-0 z-20 border-b border-ink-800/80 bg-ink-950/70 backdrop-blur-xl">
          <div className="mx-auto flex h-16 max-w-7xl items-center gap-8 px-6">
            <ProgressLink
              href="/dashboard"
              spinner={false}
              className="flex shrink-0 items-center gap-2.5 pressable"
            >
              <AstraMark className="h-7 w-7" />
              <span className="text-[15px] font-semibold tracking-tight text-slate-50">Astra</span>
            </ProgressLink>

            <NavLinks />

            <div className="ml-auto flex items-center gap-3">
              <span className="hidden max-w-[18ch] truncate text-xs text-slate-400 lg:block">
                {email}
              </span>
              <ThemeToggle />
              <Avatar email={email} />
              <SignOutButton />
            </div>
          </div>
          <NavigationProgress />
        </header>

        <main className="mx-auto max-w-7xl px-6 py-10">{children}</main>
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
            // Material's navigation pill: the active item sits in a tonal
            // container of the accent rather than a grey box, which is what
            // makes "where am I" answerable at a glance instead of by
            // comparing two shades of dark.
            className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-sm transition duration-200 ease-emphasized ${
              active
                ? "bg-astra-500/15 font-medium text-astra-300"
                : "text-slate-400 hover:bg-ink-800 hover:text-slate-100"
            }`}
          >
            {item.label}
          </ProgressLink>
        );
      })}
    </nav>
  );
}

/**
 * The signed-in account, as an initial.
 *
 * Google puts one in the top right of every product, and it does real work
 * beyond decoration: on a shared machine it is the fastest possible answer to
 * "whose session is this?", which matters here because the whole app is scoped
 * to the person holding it.
 */
function Avatar({ email }: { email: string }) {
  const initial = (email.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      title={email}
      aria-hidden="true"
      className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-astra-500/20
                 text-xs font-semibold text-astra-200 ring-1 ring-inset ring-astra-300/25"
    >
      {initial}
    </span>
  );
}

/** A small mark rather than a logo file — one less asset to serve. */
export function AstraMark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="astra-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#8ab4f8" />
          <stop offset="55%" stopColor="#4285f4" />
          <stop offset="100%" stopColor="#d0bcff" />
        </linearGradient>
      </defs>
      <defs>
        <linearGradient id="astra-mark-2" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="#4285f4" />
          <stop offset="100%" stopColor="#8ab4f8" />
        </linearGradient>
      </defs>
      {/* A four-point spark, the shape Google uses across its AI surfaces. The
          second, smaller one gives it the asymmetry that keeps it from reading
          as a plain star. */}
      <path
        d="M12 2 14.4 9.6 22 12 14.4 14.4 12 22 9.6 14.4 2 12 9.6 9.6Z"
        fill="url(#astra-mark)"
      />
      <path d="M19 3 19.9 5.6 22.5 6.5 19.9 7.4 19 10 18.1 7.4 15.5 6.5 18.1 5.6Z" fill="url(#astra-mark-2)" opacity="0.9" />
    </svg>
  );
}
