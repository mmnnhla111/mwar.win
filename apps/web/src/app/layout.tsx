import type { Metadata, Viewport } from 'next';
import './globals.css';
import { AppShell } from '../components/shell/AppShell';

export const metadata: Metadata = {
  title: 'mwar.win — play, post & earn with friends',
  description: 'A cute social & gaming hub: share moments, follow friends and jump into MWAR Tactical FPS rooms.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#FAF9F5',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="th">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Prompt:wght@400;500;600;700&display=swap"
        />
      </head>
      <body className="bg-[#FAF9F5] text-stone-900 min-h-screen font-sans antialiased">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
