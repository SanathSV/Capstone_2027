import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Astra — Sprint Context Console",
  description:
    "Teams, the company resource pool, and the pre-context engine that briefs the meeting bot.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
