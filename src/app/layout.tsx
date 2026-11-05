import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { PhaseProvider } from "@/lib/phase";
import { PLATFORM_PHASE } from "@/lib/env";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: PLATFORM_PHASE === "DEMO"
    ? "Bingo Royale — Real-Money Bingo · Ethiopia (Demo)"
    : "Bingo Royale — Bingo · Ethiopia",
  description:
    PLATFORM_PHASE === "DEMO"
      ? "Provably-fair 75-ball and 90-ball bingo with instant demo deposits, server-side auto-daub and commit-reveal fairness. B2B tenant platform — demo phase."
      : "Provably-fair 75-ball and 90-ball bingo with instant telebirr deposits, server-side auto-daub and commit-reveal fairness. B2B tenant platform.",
  applicationName: "Bingo Royale",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.svg" },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Bingo Royale" },
};

export const viewport: Viewport = {
  themeColor: "#0d1411",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground min-h-screen flex flex-col`}>
        <PhaseProvider phase={PLATFORM_PHASE}>{children}</PhaseProvider>
        <Toaster />
      </body>
    </html>
  );
}
