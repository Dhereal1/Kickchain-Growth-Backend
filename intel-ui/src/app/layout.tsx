import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import { ApiKeyBar } from "@/components/api-key-bar";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Kickchain Intel",
  description: "Internal multi-tenant intel UI for Kickchain growth ops.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">
        <header className="border-b border-zinc-800/80 bg-zinc-950/80 backdrop-blur">
          <div className="mx-auto w-full max-w-5xl px-4 py-3 flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs text-zinc-400">Kickchain</div>
                <div className="text-sm font-semibold tracking-tight truncate">Intel Console</div>
              </div>
              <nav className="flex items-center gap-1 text-sm">
                <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-900" href="/config">
                  Config
                </Link>
                <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-900" href="/run">
                  Run
                </Link>
                <Link className="rounded-md px-3 py-1.5 hover:bg-zinc-900" href="/results">
                  Results
                </Link>
              </nav>
            </div>
            <ApiKeyBar />
          </div>
        </header>

        <main className="flex-1">
          <div className="mx-auto w-full max-w-5xl px-4 py-8">{children}</div>
        </main>

        <footer className="border-t border-zinc-800/80">
          <div className="mx-auto w-full max-w-5xl px-4 py-4 text-xs text-zinc-400">
            Uses your existing backend endpoints. No scraping automation or messaging is performed from this UI.
          </div>
        </footer>
      </body>
    </html>
  );
}
