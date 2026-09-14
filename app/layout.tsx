import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Svechnoy Suslik v2 — Smart Money',
  description: 'Binance Spot USDT Smart Money signal engine (DRY_RUN / FORWARD_TEST)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <div className="brand">
            <span className="logo">🐿️</span>
            <span>
              Svechnoy Suslik <b>v2</b>
            </span>
            <span className="badge badge-exchange">BINANCE SPOT · USDT</span>
            <span className="badge badge-locked" title="LIVE trading is permanently disabled">
              LIVE LOCKED
            </span>
          </div>
          <nav>
            <Link href="/">Markets</Link>
            <Link href="/signals">Signals</Link>
            <Link href="/monitoring">Monitoring</Link>
            <Link href="/replay">Replay</Link>
            <Link href="/admin">Admin</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
