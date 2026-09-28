import type { Config } from "tailwindcss";

/**
 * Astra's design tokens — Google Material 3, dark and light.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TOKEN NAMES DID NOT CHANGE
 * ---------------------------------------------------------------------------
 * `ink-*`, `astra-*`, `signal-*` and `slate-*` are used inline across every
 * page and component. Retuning their VALUES restyles the whole application
 * coherently in one move; renaming them would have meant touching two dozen
 * files and risking a page nobody looked at. So the names are the same and the
 * colours behind them are now Google's.
 *
 * ---------------------------------------------------------------------------
 * THE PALETTE
 * ---------------------------------------------------------------------------
 * These are Material 3's dark surface roles as Google actually ships them in
 * Gemini and Chrome's dark UI, not an approximation. The important idea is that
 * **elevation is tonal, not shadowed**: a card is not a dark rectangle with a
 * drop shadow, it is a *lighter surface*. Each `ink` step is one level of
 * elevation, which is what stops a dense dashboard reading as one flat sheet —
 * the failure the previous palette had, where card and page differed by three
 * hex points and the eye could not find an edge.
 *
 * `slate` is deliberately overridden. Tailwind's slate is blue-tinted; Google's
 * greys are neutral, and mixing the two makes a blue accent look muddy. Every
 * existing `text-slate-400` in the codebase now resolves to Material's
 * on-surface-variant, which is also simply more legible: the old value sat at
 * about 4.2:1 on the page background, under the 4.5:1 minimum.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Every colour is a CSS custom property holding space-separated RGB
      // channels, so `bg-ink-800/60` still works — an alpha cannot be applied
      // to a var holding a hex string, but it can to one holding "30 31 32".
      // The values live in globals.css, once per theme; see the note at the top
      // of that file for why the names are semantic rather than literal.
      colors: {
        ink: {
          950: "rgb(var(--ink-950) / <alpha-value>)",
          900: "rgb(var(--ink-900) / <alpha-value>)",
          850: "rgb(var(--ink-850) / <alpha-value>)",
          800: "rgb(var(--ink-800) / <alpha-value>)",
          700: "rgb(var(--ink-700) / <alpha-value>)",
          600: "rgb(var(--ink-600) / <alpha-value>)",
          500: "rgb(var(--ink-500) / <alpha-value>)",
        },
        astra: {
          200: "rgb(var(--astra-200) / <alpha-value>)",
          300: "rgb(var(--astra-300) / <alpha-value>)",
          400: "rgb(var(--astra-400) / <alpha-value>)",
          500: "rgb(var(--astra-500) / <alpha-value>)",
          600: "rgb(var(--astra-600) / <alpha-value>)",
          700: "rgb(var(--astra-700) / <alpha-value>)",
        },
        signal: {
          green: "rgb(var(--signal-green) / <alpha-value>)",
          amber: "rgb(var(--signal-amber) / <alpha-value>)",
          red: "rgb(var(--signal-red) / <alpha-value>)",
          violet: "rgb(var(--signal-violet) / <alpha-value>)",
        },
        // An EMPHASIS ladder, not a lightness one: slate-50 is the highest
        // emphasis text in whichever theme is active, which is white on dark
        // and near-black on light.
        slate: {
          50: "rgb(var(--slate-50) / <alpha-value>)",
          100: "rgb(var(--slate-100) / <alpha-value>)",
          200: "rgb(var(--slate-200) / <alpha-value>)",
          300: "rgb(var(--slate-300) / <alpha-value>)",
          400: "rgb(var(--slate-400) / <alpha-value>)",
          500: "rgb(var(--slate-500) / <alpha-value>)",
          600: "rgb(var(--slate-600) / <alpha-value>)",
          700: "rgb(var(--slate-700) / <alpha-value>)",
          800: "rgb(var(--slate-800) / <alpha-value>)",
          900: "rgb(var(--slate-900) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Roboto", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "Roboto Mono", "ui-monospace", "monospace"],
      },
      borderRadius: {
        // Material 3's shape scale. The jump from Tailwind's default 8px to
        // 16-28px is most of what makes an interface read as Google's.
        xl: "16px",
        "2xl": "20px",
        "3xl": "28px",
      },
      boxShadow: {
        // Material's elevation, softer than a typical web shadow — most of the
        // separation comes from the tonal surface, so the shadow only hints at
        // a lift. Var-driven because a shadow tuned for a black page looks like
        // soot on a white one.
        card: "var(--shadow-1)",
        raised: "var(--shadow-2)",
        overlay: "var(--shadow-3)",
      },
      transitionTimingFunction: {
        // Material's "emphasized" curve: a fast start and a long settle, which
        // is why Google's UI feels responsive rather than merely animated.
        emphasized: "cubic-bezier(0.2, 0, 0, 1)",
        standard: "cubic-bezier(0.2, 0, 0, 1)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        // An indeterminate bar: it sweeps rather than fills, because we have no
        // idea how long a route or a three-API harvest is going to take, and a
        // progress bar that claims to know is a lie the user notices.
        "route-progress": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(400%)" },
        },
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
      },
      animation: {
        "fade-up": "fade-up 260ms cubic-bezier(0.2, 0, 0, 1) both",
        "route-progress": "route-progress 1.1s cubic-bezier(0.2, 0, 0, 1) infinite",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
