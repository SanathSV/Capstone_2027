"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
} from "react";

/**
 * Navigation with visible pending state.
 *
 * A plain `<Link>` in the App Router gives no feedback between the click and
 * the new page arriving — and because every page here is `force-dynamic`, that
 * gap is a real server round trip. `loading.tsx` eventually covers it, but only
 * once the transition commits; the first few hundred milliseconds are silent,
 * which is exactly the window where someone clicks again.
 *
 * So navigation is routed through `startTransition`, whose `isPending` flag is
 * true for precisely that gap. Two things consume it: the link itself (a
 * spinner on the card you actually clicked) and a bar across the top of the
 * app (so the answer to "is anything happening" is always in the same place).
 */

interface NavState {
  /** The href currently being navigated to, or null when idle. */
  pendingHref: string | null;
  navigate: (href: string) => void;
}

const NavigationContext = createContext<NavState>({
  pendingHref: null,
  navigate: () => {},
});

export function NavigationProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [target, setTarget] = useState<string | null>(null);

  const navigate = useCallback(
    (href: string) => {
      setTarget(href);
      startTransition(() => router.push(href));
    },
    [router],
  );

  const value = useMemo(
    // `target` outlives the transition by a frame or two, so gate it on
    // isPending rather than clearing it — clearing races the re-render and
    // leaves the bar stuck on.
    () => ({ pendingHref: isPending ? target : null, navigate }),
    [isPending, target, navigate],
  );

  return (
    <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>
  );
}

export function useNavigation() {
  return useContext(NavigationContext);
}

/**
 * The bar at the top of the app during a navigation.
 *
 * Indeterminate on purpose: we cannot know how long a dynamic page will take,
 * and a bar that pretends to know is a lie people learn to distrust. It also
 * only appears while something is pending, so an instant navigation does not
 * produce a distracting flash.
 */
export function NavigationProgress() {
  const { pendingHref } = useNavigation();

  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden"
      aria-hidden={!pendingHref}
    >
      {pendingHref && (
        <div className="h-full w-1/3 animate-route-progress rounded-full bg-astra-500" />
      )}
    </div>
  );
}

/**
 * A `<Link>` that reports its own pending state.
 *
 * `children` is a plain ReactNode, deliberately. An earlier version took a
 * render prop — `children={({ pending }) => ...}` — which reads nicely but
 * cannot be used from a Server Component: functions are not serialisable across
 * the RSC boundary, and React rejects them with "Functions are not valid as a
 * child of Client Components". Since most callers here *are* server components,
 * the pending affordance is built in instead: a spinner is appended while the
 * navigation is in flight. A client component that needs finer control can call
 * `useNavigation()` directly.
 *
 * It stays a real anchor — middle-click, ctrl-click and "open in new tab" all
 * still work, because those go through the browser rather than the handler.
 * Only an ordinary left-click is intercepted.
 */
export function ProgressLink({
  href,
  className = "",
  activeClassName = "",
  children,
  prefetch,
  spinner = true,
  spinnerClassName = "h-3.5 w-3.5",
}: {
  href: string;
  className?: string;
  /** Applied while this particular link is the one being navigated to. */
  activeClassName?: string;
  children: React.ReactNode;
  /** Passed straight through to next/link; `false` opts a link out of prefetch. */
  prefetch?: boolean;
  /** Set false where the pending state is shown some other way. */
  spinner?: boolean;
  spinnerClassName?: string;
}) {
  const { pendingHref, navigate } = useNavigation();
  const pending = pendingHref === href;

  return (
    <Link
      href={href}
      prefetch={prefetch}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return; // let the browser do its thing
        }
        event.preventDefault();
        navigate(href);
      }}
      aria-busy={pending || undefined}
      className={`${className} ${pending ? activeClassName : ""}`}
    >
      {children}
      {spinner && pending && <InlineSpinner className={spinnerClassName} />}
    </Link>
  );
}

/** The small spinner links use to show they were clicked. */
export function InlineSpinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`${className} animate-spin`} fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
