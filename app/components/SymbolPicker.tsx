'use client';

/**
 * Symbol dropdown for the chart toolbar.
 *
 * The list is whatever the backend currently reports as the Binance TOP-10 —
 * it is never hardcoded here. Prices shown in the list are merged from the
 * live ticker stream when available so the popover does not look frozen.
 */

import { useEffect, useRef, useState } from 'react';
import { fmtPct, fmtUsd, pairName } from '../lib/format';

export interface PickerSymbol {
  symbol: string;
  rank: number;
  lastPrice: number;
  /** Binance tickSize — price precision for this pair. */
  tickSize?: number | null;
  priceChangePct: number;
}

interface Props {
  symbols: PickerSymbol[];
  selected: string;
  onSelect: (symbol: string) => void;
}

export default function SymbolPicker({ symbols, selected, onSelect }: Props): React.ReactElement {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click and on Escape — standard popover behaviour.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (s: string): void => {
    onSelect(s);
    setOpen(false);
  };

  return (
    <div className="sym-picker" ref={boxRef}>
      <button
        type="button"
        className="sym-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Выбор торговой пары"
        data-testid="symbol-picker-trigger"
        onClick={() => setOpen((v) => !v)}
      >
        <b>{selected ? pairName(selected) : 'Пара'}</b>
        <span className="caret" aria-hidden="true">
          ▼
        </span>
      </button>

      {open && (
        <div className="sym-menu" role="listbox" data-testid="symbol-picker-menu">
          {symbols.length === 0 ? (
            <div className="sym-empty">Список пар пока пуст</div>
          ) : (
            symbols.map((s) => (
              <button
                type="button"
                key={s.symbol}
                role="option"
                aria-selected={s.symbol === selected}
                className={`sym-item${s.symbol === selected ? ' active' : ''}`}
                onClick={() => choose(s.symbol)}
              >
                <span className="sym-rank">{s.rank}</span>
                <span className="sym-pair">{pairName(s.symbol)}</span>
                <span className="sym-price">{fmtUsd(s.lastPrice, s.tickSize)}</span>
                <span className={`sym-chg ${s.priceChangePct >= 0 ? 'up' : 'down'}`}>
                  {fmtPct(s.priceChangePct)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
