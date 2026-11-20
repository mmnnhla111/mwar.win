import type { Metadata } from 'next/dist/lib/metadata/types/metadata-interface';
import './globals.css';
import Link from 'next/link';
import { DevMockPanel } from '../components/DevMockPanel';

export const metadata: Metadata = {
  title: 'MWAR - 3D Real-Time Combat & 5-Level Affiliate Ecosystem',
  description: 'Serverless Real-Time 3D Multiplayer Shooter with 5-Level MLM Referral Economics & Micro-USD Instant Accounting.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="bg-background text-gray-100 min-h-screen flex flex-col font-sans selection:bg-red-500 selection:text-white">
        {/* Navigation Bar */}
        <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur-md border-b border-gray-800">
          <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
            <Link href="/" className="flex items-center space-x-2">
              <span className="text-2xl font-black tracking-wider text-red-500">M<span className="text-white">WAR</span>.WIN</span>
              <span className="text-[10px] bg-red-600/20 text-red-400 font-bold px-1.5 py-0.5 rounded border border-red-500/30">
                LOCAL DEV
              </span>
            </Link>

            <nav className="hidden md:flex items-center space-x-6 text-sm font-semibold text-gray-300">
              <Link href="/" className="hover:text-white transition">Lobby</Link>
              <Link href="/game" className="text-red-400 hover:text-red-300 font-bold transition flex items-center">
                <span className="w-2 h-2 rounded-full bg-green-500 mr-1.5 animate-pulse"></span>
                Play 3D
              </Link>
              <Link href="/network" className="hover:text-white transition">5-Level Team</Link>
              <Link href="/marketplace" className="hover:text-white transition">Marketplace</Link>
              <Link href="/chat" className="hover:text-white transition">Chat</Link>
              <Link href="/wallet" className="hover:text-white transition">Wallet & Cashout</Link>
              <Link href="/admin" className="text-yellow-400 hover:text-yellow-300 transition">Audit Panel</Link>
            </nav>

            <div className="flex items-center space-x-3">
              <Link
                href="/game"
                className="bg-red-600 hover:bg-red-500 text-white font-bold px-4 py-2 rounded-lg text-sm shadow-md transition transform active:scale-95"
              >
                JOIN MATCH
              </Link>
            </div>
          </div>
        </header>

        {/* Main Content Area */}
        <main className="flex-1 max-w-7xl w-full mx-auto p-4">
          {children}
        </main>

        {/* Floating Dev Simulation Panel */}
        <DevMockPanel />

        {/* Footer */}
        <footer className="border-t border-gray-800 bg-surface/50 py-6 text-center text-xs text-gray-500">
          <p>© 2026 MWAR.WIN Ecosystem. Local-First Serverless Architecture (Cloudflare D1 + Colyseus RAM + PostgreSQL Audit).</p>
        </footer>
      </body>
    </html>
  );
}
