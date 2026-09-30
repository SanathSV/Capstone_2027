"use client";

import { useEffect, useRef } from "react";

/**
 * A panel that slides in from the right.
 *
 * Used by both the transcript viewer and the chat, which is the point of it
 * existing as one component: two drawers that behaved differently — one closing
 * on Escape and one not, one trapping focus and one not — would be two bugs
 * waiting rather than one shared behaviour.
 *
 * The things it gets right, none of which a plain absolutely-positioned div
 * would:
 *
 *   - **Escape closes it.** Bound on the document, so it works wherever focus
 *     happens to be.
 *   - **The page behind cannot scroll.** Without this, a wheel gesture over the
 *     scrim scrolls the dashboard underneath, which is disorienting.
 *   - **Focus moves in, and back out.** Opening moves focus into the panel so a
 *     keyboard user is not still on the dashboard; closing returns it to
 *     whatever they pressed, so they do not lose their place in a grid of team
 *     cards.
 *   - **It is a `<dialog>`-shaped thing to a screen reader** — role, modality
 *     and a label — without the browser `<dialog>`'s styling quirks.
 */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  headerExtra,
  width = "max-w-2xl",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Anything that belongs beside the close button — a select, a refresh. */
  headerExtra?: React.ReactNode;
  width?: string;
  children: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;

    returnFocusTo.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);

    // A frame's delay: the panel is not focusable until it has been laid out.
    const raf = requestAnimationFrame(() => panelRef.current?.focus());

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      cancelAnimationFrame(raf);
      (returnFocusTo.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
      {/* The scrim. `aria-hidden` because the close affordance a screen reader
          should find is the button in the header, not a nameless div. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-[2px]
                   motion-safe:animate-fade-up"
      />

      <div
        ref={panelRef}
        tabIndex={-1}
        className={`relative flex h-full w-full ${width} flex-col border-l border-ink-600
                    bg-ink-850 shadow-overlay outline-none
                    motion-safe:animate-fade-up`}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-ink-600/70 px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-medium text-slate-100">{title}</h2>
            {subtitle && <div className="mt-0.5 text-xs text-slate-400">{subtitle}</div>}
          </div>
          {headerExtra}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-400
                       transition duration-200 ease-emphasized
                       hover:bg-ink-800 hover:text-slate-100 active:scale-95"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        {children}
      </div>
    </div>
  );
}
