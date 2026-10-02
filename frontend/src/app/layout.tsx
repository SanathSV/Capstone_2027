import type { Metadata } from "next";
import "./globals.css";
import { QueryProvider } from "@/lib/query-provider";
import { ToastProvider } from "@/components/toast";

export const metadata: Metadata = {
  title: "Astra | Workforce intelligence",
  description: "Project and workforce intelligence for Astra Labs.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body suppressHydrationWarning><QueryProvider><ToastProvider>{children}</ToastProvider></QueryProvider></body></html>;
}
