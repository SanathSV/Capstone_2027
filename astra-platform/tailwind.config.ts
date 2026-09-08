import type { Config } from "tailwindcss";

// Astra is dark-mode only for now, so the palette is defined directly rather
// than through a light/dark pair. Every surface is a step on the same ramp,
// which is what keeps a dense dashboard readable.
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#08090c",
          900: "#0c0e13",
          850: "#11141b",
          800: "#161a23",
          700: "#1e2330",
          600: "#2a3040",
          500: "#3a4255",
        },
        astra: {
          300: "#8ab4ff",
          400: "#6b9bff",
          500: "#4f7dfb",
          600: "#3d63d8",
        },
        signal: {
          green: "#3ecf8e",
          amber: "#f5b74e",
          red: "#f2555a",
          violet: "#a78bfa",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.8)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
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
        "fade-up": "fade-up 200ms ease-out both",
        "route-progress": "route-progress 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
