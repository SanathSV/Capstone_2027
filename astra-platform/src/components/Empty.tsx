import Link from "next/link";

/** The shared empty state. Every one of them tells you what to do next. */
export function Empty({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div className="rounded-full border border-ink-600 bg-ink-800 p-3">
        <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-500" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 7h16M4 12h10M4 17h7" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="text-sm font-medium text-slate-200">{title}</h3>
      <p className="max-w-md text-sm text-slate-500">{body}</p>
      {action && (
        <Link href={action.href} className="btn-primary mt-2">
          {action.label}
        </Link>
      )}
    </div>
  );
}
