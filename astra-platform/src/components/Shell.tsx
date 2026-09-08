import Link from "next/link";
import { SignOutButton } from "./SignOutButton";

/**
 * The frame every signed-in page sits in: brand, primary nav, and who you are.
 * A server component — nothing here needs interactivity except sign-out.
 */

const NAV = [
  { href: "/dashboard", label: "Teams" },
  { href: "/directory", label: "Resource Pool" },
];

export function Shell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-6 px-6">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <AstraMark />
            <span className="text-sm font-semibold tracking-wide text-white">ASTRA</span>
          </Link>

          <nav className="flex items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-1.5 text-sm text-slate-400 transition hover:bg-ink-800 hover:text-white"
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:block">{email}</span>
            <SignOutButton />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">{children}</main>
    </div>
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
