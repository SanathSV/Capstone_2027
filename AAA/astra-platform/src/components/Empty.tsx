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
    // A dashed border rather than a solid card. An empty state is a placeholder
    // for content that is not there yet, and a solid filled panel claims more
    // presence than nothing deserves — it reads as a feature rather than a gap.
    // py-12, not py-20: the old version reserved half a screen for one sentence.
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-ink-600 bg-ink-850/40 px-6 py-10 text-center">
      <div className="grid h-11 w-11 place-items-center rounded-full bg-ink-800 text-slate-500">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 7h16M4 12h10M4 17h7" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="text-[15px] font-medium text-slate-100">{title}</h3>
      <p className="max-w-md text-[13px] leading-relaxed text-slate-400">{body}</p>
      {action && (
        <Link href={action.href} className="btn-primary mt-3">
          {action.label}
        </Link>
      )}
    </div>
  );
}
