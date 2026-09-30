"use client";

import { useEffect, useState } from "react";

/**
 * Dark / light, with the system as the default.
 *
 * ---------------------------------------------------------------------------
 * THREE STATES, NOT TWO
 * ---------------------------------------------------------------------------
 * "System" is a real state and not a synonym for whichever theme happens to be
 * active. Someone whose laptop switches at sunset wants Astra to switch with
 * it; a two-state toggle silently opts them out of that the first time they
 * touch it, and there is then no way back. So the cycle is
 * system → light → dark → system, and the button's tooltip says which one it
 * is currently on.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PAINT DOES NOT FLASH
 * ---------------------------------------------------------------------------
 * The preference lives in localStorage, which a server component cannot read —
 * so the first HTML the browser gets is theme-less, and a React effect applying
 * the class after hydration would show a dark page to a light-theme user for a
 * few hundred milliseconds. The blocking script in `layout.tsx` sets the
 * attribute before the first paint; this component only *reads* what that
 * script decided, and takes over from there.
 */

export const THEME_KEY = "astra.theme";
type Choice = "system" | "light" | "dark";

/**
 * The script that runs before first paint. Kept here, next to the component
 * that depends on it, so the two cannot drift apart — the storage key and the
 * attribute name are the whole contract between them.
 */
export const NO_FLASH_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_KEY)});
    var dark = stored === "dark" ||
      (stored !== "light" && !window.matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
`;

function systemPrefersLight() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches;
}

function apply(choice: Choice) {
  const light = choice === "light" || (choice === "system" && systemPrefersLight());
  const root = document.documentElement;

  // Colours cross-fade rather than snapping. The class is added only around a
  // deliberate change and removed a beat later, so an ordinary hover is never
  // slowed down by a global transition rule.
  root.classList.add("theme-transition");
  root.setAttribute("data-theme", light ? "light" : "dark");
  window.setTimeout(() => root.classList.remove("theme-transition"), 260);
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>("system");
  // The button renders a moon or a sun; before hydration we do not know which,
  // and guessing produces a visible swap. Nothing is drawn until we do.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY) as Choice | null;
    setChoice(stored === "light" || stored === "dark" ? stored : "system");
    setReady(true);
  }, []);

  // Follow the OS while the choice is "system" — the point of that state.
  useEffect(() => {
    if (choice !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => apply("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [choice]);

  function cycle() {
    const next: Choice =
      choice === "system" ? "light" : choice === "light" ? "dark" : "system";
    setChoice(next);
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
    apply(next);
  }

  const label =
    choice === "system"
      ? "Theme: following your system"
      : choice === "light"
        ? "Theme: light"
        : "Theme: dark";

  return (
    <button
      type="button"
      onClick={cycle}
      title={`${label} — click to change`}
      aria-label={`${label}. Click to change.`}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-slate-400
                 transition duration-200 ease-emphasized
                 hover:bg-ink-800 hover:text-slate-100 active:scale-95"
    >
      {/* `ready` gates only the ICON, never the button: reserving the space up
          front means the header does not reflow when hydration lands. */}
      <span className={ready ? "" : "opacity-0"}>
        {choice === "system" ? <SystemIcon /> : choice === "light" ? <SunIcon /> : <MoonIcon />}
      </span>
    </button>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M20 13.5A8.5 8.5 0 0 1 10.5 4a8.5 8.5 0 1 0 9.5 9.5Z" strokeLinejoin="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path
        d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M9 21h6M12 17v4" strokeLinecap="round" />
    </svg>
  );
}
