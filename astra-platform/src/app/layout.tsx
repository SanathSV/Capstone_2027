import type { Metadata, Viewport } from "next";
import { Inter, Roboto_Mono } from "next/font/google";
import { NO_FLASH_SCRIPT } from "@/components/ThemeToggle";
import "./globals.css";

/**
 * Typography.
 *
 * Google Sans is not licensed for third-party use, so the question is what
 * comes closest to it. Inter does: the same humanist-geometric skeleton, a tall
 * x-height, and — the part that actually matters at 30px — open apertures that
 * hold up when the tracking is pulled tight, which is what globals.css does to
 * headings. Roboto Mono is Google's own and pairs with it without argument.
 *
 * `next/font` self-hosts both at build time. No render-blocking request to
 * fonts.googleapis.com, no layout shift, and the app still works offline.
 */
const sans = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

const mono = Roboto_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Astra — Sprint Context Console",
  description:
    "Teams, the company resource pool, and the pre-context engine that briefs the meeting bot.",
};

export const viewport: Viewport = {
  // Matches the page background so the mobile browser chrome does not sit as a
  // contrasting band above the app. Two entries, because the page background is
  // no longer one colour.
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0e0e0f" },
    { media: "(prefers-color-scheme: light)", color: "#f8fafd" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        {/*
          Runs before the first paint and sets data-theme from localStorage.
          It has to be blocking and inline: the preference is client-side, so a
          server render cannot know it, and applying the theme in a React effect
          would show every light-theme user a dark page for the length of
          hydration. `suppressHydrationWarning` above is because this script
          mutates <html> before React sees it — which is the intent.
        */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
