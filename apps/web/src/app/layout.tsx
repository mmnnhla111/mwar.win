import type { Metadata } from 'next/dist/lib/metadata/types/metadata-interface';
import './globals.css';
import Link from 'next/link';
import { DevMockPanel } from '../components/DevMockPanel';
import { TopResourceHud } from '../components/TopResourceHud';
import {
  FightEmblemIcon,
  NetworkTreeIcon,
  StoryReelIcon,
  GoldCoinIcon,
} from '../components/icons';

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
      <body className="bg-slate-950 text-slate-100 min-h-screen flex flex-col font-sans selection:bg-rose-500 selection:text-white pb-20 md:pb-0">
        {/* Persistent Top Tactical Resource HUD Bar */}
        <TopResourceHud />

        {/* Secondary Desktop / Tablet Navigation Bar */}
        <div className="hidden md:block bg-slate-900/60 border-b border-slate-800/80 backdrop-blur-sm">
          <div className="max-w-7xl mx-auto px-4 h-11 flex items-center justify-between text-xs font-black tracking-wide">
            <nav className="flex items-center space-x-6 text-slate-300">
              <Link href="/" className="hover:text-white transition flex items-center space-x-1.5">
                <span>⚔️</span>
                <span>LOBBY</span>
              </Link>
              <Link href="/game" className="text-rose-400 hover:text-rose-300 transition flex items-center space-x-1.5">
                <span className="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span>
                <span>ARENA COMBAT</span>
              </Link>
              <Link href="/network" className="hover:text-white transition flex items-center space-x-1.5">
                <span>🌐</span>
                <span>5-LEVEL NETWORK</span>
              </Link>
              <Link href="/marketplace" className="hover:text-white transition flex items-center space-x-1.5">
                <span>🛒</span>
                <span>MARKETPLACE</span>
              </Link>
              <Link href="/chat" className="hover:text-white transition flex items-center space-x-1.5">
                <span>💬</span>
                <span>SQUAD CHAT</span>
              </Link>
              <Link href="/wallet" className="hover:text-white transition flex items-center space-x-1.5">
                <span>💳</span>
                <span>CASHOUT</span>
              </Link>
              <Link href="/admin" className="text-amber-400 hover:text-amber-300 transition flex items-center space-x-1.5">
                <span>🛡️</span>
                <span>AUDIT LOGS</span>
              </Link>
            </nav>

            <div className="flex items-center space-x-2 text-[11px] text-slate-400 font-semibold">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
              <span>Colyseus 20Hz RAM Engine</span>
            </div>
          </div>
        </div>

        {/* Main Content Area */}
        <main className="flex-1 max-w-7xl w-full mx-auto p-3 sm:p-5">
          {children}
        </main>

        {/* Mobile Thumb-Friendly Bottom Navigation Dock (375px - 430px) */}
        <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-slate-950/95 border-t border-slate-800 backdrop-blur-xl px-2 py-1.5 flex items-center justify-around shadow-2xl">
          <Link href="/" className="flex flex-col items-center p-1 text-slate-400 hover:text-white text-[10px] font-bold">
            <span className="text-base">🏠</span>
            <span>Lobby</span>
          </Link>
          <Link href="/network" className="flex flex-col items-center p-1 text-slate-400 hover:text-white text-[10px] font-bold">
            <span className="text-base">👥</span>
            <span>Team</span>
          </Link>

          {/* Centerpiece Floating FIGHT CTA */}
          <Link
            href="/game"
            className="flex flex-col items-center -mt-6 bg-gradient-to-tr from-rose-600 via-rose-500 to-amber-500 text-white rounded-full p-3 shadow-lg shadow-rose-600/50 border-2 border-slate-950 active:scale-95 transition"
          >
            <FightEmblemIcon size={24} />
          </Link>

          <Link href="/marketplace" className="flex flex-col items-center p-1 text-slate-400 hover:text-white text-[10px] font-bold">
            <span className="text-base">🛒</span>
            <span>Market</span>
          </Link>
          <Link href="/chat" className="flex flex-col items-center p-1 text-slate-400 hover:text-white text-[10px] font-bold">
            <span className="text-base">💬</span>
            <span>Chat</span>
          </Link>
        </nav>

        {/* Floating Dev Simulation Panel */}
        <DevMockPanel />

        {/* Footer */}
        <footer className="border-t border-slate-900 bg-slate-950/80 py-6 text-center text-xs text-slate-500">
          <p>© 2026 MWAR.WIN Ecosystem. Local-First Serverless Architecture (Cloudflare D1 + Colyseus RAM + PostgreSQL Audit).</p>
        </footer>
      </body>
    </html>
  );
}
