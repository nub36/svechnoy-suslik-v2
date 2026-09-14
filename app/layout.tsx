import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Svechnoy Suslik v2 — Smart Money',
  description:
    'Движок Smart Money сигналов на Binance Spot USDT (режимы DRY_RUN / FORWARD_TEST, LIVE заблокирован)',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <header className="topbar">
          <div className="brand">
            <span className="logo">🐿️</span>
            <span>
              Svechnoy Suslik <b>v2</b>
            </span>
            <span className="badge badge-exchange">BINANCE SPOT · USDT</span>
            <span className="badge badge-locked" title="Реальная торговля LIVE полностью отключена">
              LIVE ЗАБЛОКИРОВАН
            </span>
          </div>
          <nav>
            <Link href="/">Рынок</Link>
            <Link href="/signals">Сигналы</Link>
            <Link href="/monitoring">Мониторинг</Link>
            <Link href="/replay">История</Link>
            <Link href="/admin">Админка</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
