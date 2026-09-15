# V2 REAL REPLAY PROTOCOL

**Pre-registration. Written BEFORE any TEST metric was computed.**

This document fixes every choice that could otherwise be made after seeing
results. Anything not written here was not decided in advance and must be
reported as exploratory.

Run ID: `v2-real-20260915-080338`
Created: 2026-09-15T08:17:00.955Z

---

## 1. Frozen strategy

| item | value |
|---|---|
| frozen V2 strategy commit | `4839074` (`48390748ff1ed1f08b104206c3430142059d7430`) |
| HEAD at run time | `f766b516617af71f262054a80cb211c842d577b2` |
| trading logic changed since freeze | **NO** — verified by `git diff 4839074 -- src/strategy src/outcome src/replay` |

Research tooling lives in `scripts/real-data/` and `tests/real-data-tooling.test.ts`.
It generates and measures; it does not decide trades.

## 2. Dataset provenance

| item | value |
|---|---|
| repository | https://github.com/nub36/svechnoy-suslik-binance-data.git |
| dataset commit | `c3c1dcecfe2784a147f591f2b5b4526cbf99df9f` |
| original source | https://data.binance.vision/data/spot/monthly/klines/ |
| exchange / market / quote | Binance / Spot / USDT |
| archives | 2016 original monthly ZIPs (6 symbols × 7 timeframes × 48 months) |
| period | 2022-01-01 .. 2025-12-31 inclusive |
| total candles | 16,681,073 |
| dataset-manifest.json SHA-256 | `e31d739fc21d82331a45b366512c87ea9b296d2ae32f41933303ea7877cee39e` |
| zip-checksums.json SHA-256 | `7c36e62ec8e028daed311fa2683efccb81c0b5d73c2d9d42f065bd587af748fc` |

Timestamps: the archives mix **milliseconds** (early files) and **microseconds**
(later files). The unit is detected per file from magnitude and normalised to
milliseconds. See §4 of this protocol and the spot checks in the manifest.

### Per-series integrity

| symbol | tf | candles | first open (UTC) | last open (UTC) | gaps |
|---|---|---|---|---|---|
| BTCUSDT | 1m | 2,103,760 | 2022-01-01T00:00:00Z | 2025-12-31T23:59:00Z | 1 |
| BTCUSDT | 5m | 420,752 | 2022-01-01T00:00:00Z | 2025-12-31T23:55:00Z | 1 |
| BTCUSDT | 15m | 140,251 | 2022-01-01T00:00:00Z | 2025-12-31T23:45:00Z | 1 |
| BTCUSDT | 30m | 70,126 | 2022-01-01T00:00:00Z | 2025-12-31T23:30:00Z | 1 |
| BTCUSDT | 1h | 35,063 | 2022-01-01T00:00:00Z | 2025-12-31T23:00:00Z | 1 |
| BTCUSDT | 4h | 8,766 | 2022-01-01T00:00:00Z | 2025-12-31T20:00:00Z | 0 |
| BTCUSDT | 1d | 1,461 | 2022-01-01T00:00:00Z | 2025-12-31T00:00:00Z | 0 |
| ETHUSDT | 1m | 2,103,760 | 2022-01-01T00:00:00Z | 2025-12-31T23:59:00Z | 1 |
| ETHUSDT | 5m | 420,752 | 2022-01-01T00:00:00Z | 2025-12-31T23:55:00Z | 1 |
| ETHUSDT | 15m | 140,251 | 2022-01-01T00:00:00Z | 2025-12-31T23:45:00Z | 1 |
| ETHUSDT | 30m | 70,126 | 2022-01-01T00:00:00Z | 2025-12-31T23:30:00Z | 1 |
| ETHUSDT | 1h | 35,063 | 2022-01-01T00:00:00Z | 2025-12-31T23:00:00Z | 1 |
| ETHUSDT | 4h | 8,766 | 2022-01-01T00:00:00Z | 2025-12-31T20:00:00Z | 0 |
| ETHUSDT | 1d | 1,461 | 2022-01-01T00:00:00Z | 2025-12-31T00:00:00Z | 0 |
| BNBUSDT | 1m | 2,103,760 | 2022-01-01T00:00:00Z | 2025-12-31T23:59:00Z | 1 |
| BNBUSDT | 5m | 420,752 | 2022-01-01T00:00:00Z | 2025-12-31T23:55:00Z | 1 |
| BNBUSDT | 15m | 140,251 | 2022-01-01T00:00:00Z | 2025-12-31T23:45:00Z | 1 |
| BNBUSDT | 30m | 70,126 | 2022-01-01T00:00:00Z | 2025-12-31T23:30:00Z | 1 |
| BNBUSDT | 1h | 35,063 | 2022-01-01T00:00:00Z | 2025-12-31T23:00:00Z | 1 |
| BNBUSDT | 4h | 8,766 | 2022-01-01T00:00:00Z | 2025-12-31T20:00:00Z | 0 |
| BNBUSDT | 1d | 1,461 | 2022-01-01T00:00:00Z | 2025-12-31T00:00:00Z | 0 |
| SOLUSDT | 1m | 2,103,759 | 2022-01-01T00:00:00Z | 2025-12-31T23:59:00Z | 2 |
| SOLUSDT | 5m | 420,752 | 2022-01-01T00:00:00Z | 2025-12-31T23:55:00Z | 1 |
| SOLUSDT | 15m | 140,251 | 2022-01-01T00:00:00Z | 2025-12-31T23:45:00Z | 1 |
| SOLUSDT | 30m | 70,126 | 2022-01-01T00:00:00Z | 2025-12-31T23:30:00Z | 1 |
| SOLUSDT | 1h | 35,063 | 2022-01-01T00:00:00Z | 2025-12-31T23:00:00Z | 1 |
| SOLUSDT | 4h | 8,766 | 2022-01-01T00:00:00Z | 2025-12-31T20:00:00Z | 0 |
| SOLUSDT | 1d | 1,461 | 2022-01-01T00:00:00Z | 2025-12-31T00:00:00Z | 0 |
| XRPUSDT | 1m | 2,103,760 | 2022-01-01T00:00:00Z | 2025-12-31T23:59:00Z | 1 |
| XRPUSDT | 5m | 420,752 | 2022-01-01T00:00:00Z | 2025-12-31T23:55:00Z | 1 |
| XRPUSDT | 15m | 140,251 | 2022-01-01T00:00:00Z | 2025-12-31T23:45:00Z | 1 |
| XRPUSDT | 30m | 70,126 | 2022-01-01T00:00:00Z | 2025-12-31T23:30:00Z | 1 |
| XRPUSDT | 1h | 35,063 | 2022-01-01T00:00:00Z | 2025-12-31T23:00:00Z | 1 |
| XRPUSDT | 4h | 8,766 | 2022-01-01T00:00:00Z | 2025-12-31T20:00:00Z | 0 |
| XRPUSDT | 1d | 1,461 | 2022-01-01T00:00:00Z | 2025-12-31T00:00:00Z | 0 |
| DOGEUSDT | 1m | 2,103,760 | 2022-01-01T00:00:00Z | 2025-12-31T23:59:00Z | 1 |
| DOGEUSDT | 5m | 420,752 | 2022-01-01T00:00:00Z | 2025-12-31T23:55:00Z | 1 |
| DOGEUSDT | 15m | 140,251 | 2022-01-01T00:00:00Z | 2025-12-31T23:45:00Z | 1 |
| DOGEUSDT | 30m | 70,126 | 2022-01-01T00:00:00Z | 2025-12-31T23:30:00Z | 1 |
| DOGEUSDT | 1h | 35,063 | 2022-01-01T00:00:00Z | 2025-12-31T23:00:00Z | 1 |
| DOGEUSDT | 4h | 8,766 | 2022-01-01T00:00:00Z | 2025-12-31T20:00:00Z | 0 |
| DOGEUSDT | 1d | 1,461 | 2022-01-01T00:00:00Z | 2025-12-31T00:00:00Z | 0 |

Gaps are **never** filled with synthesised candles.

## 3. Settings snapshot

| item | value |
|---|---|
| source | `Settings.fromDefaults()` — the frozen SETTINGS_REGISTRY defaults |
| production DB used | **NO** (operator-editable rows would break reproducibility) |
| settings.json SHA-256 | `92311c4f9a96bc2e6922fc952aacc53ae473ffb22bcb6749b11c2a0cfa0cd3f9` |
| keys captured | 74 |

Both V1 and V2 use this one snapshot for all shared execution/outcome settings
(`risk.min_rr`, `outcome.timeout_bars`, `outcome.sl_priority_on_ambiguous_bar`,
`outcome.fee_pct`).

Key frozen values: `v2.min_evidence=0.45`, `v2.min_net_evidence=0.12`,
`risk.min_rr=1`, `outcome.timeout_bars=48`, `v2.enabled=false`.

## 4. Split policy

Chronological, per (symbol, timeframe) series, **by candle index**:
TRAIN = first 60%, VALIDATION = next 20%, TEST = final 20%. No shuffling, no
random sampling, no selection by outcome.

`splits.json` SHA-256: `a44eed9ae3ad036853f14845113e392c434081301b21647398a4a3af2ab84f0b`

| symbol | tf | TRAIN | VALIDATION | TEST |
|---|---|---|---|---|
| BTCUSDT | 1m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:55:00.000Z (1,262,256) | 2024-05-26T14:56:00.000Z → 2025-03-14T19:27:00.000Z (420,752) | 2025-03-14T19:28:00.000Z → 2025-12-31T23:59:00.000Z (420,752) |
| BTCUSDT | 5m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:50:00.000Z (252,451) | 2024-05-26T14:55:00.000Z → 2025-03-14T19:20:00.000Z (84,150) | 2025-03-14T19:25:00.000Z → 2025-12-31T23:55:00.000Z (84,151) |
| BTCUSDT | 15m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:30:00.000Z (84,150) | 2024-05-26T14:45:00.000Z → 2025-03-14T19:00:00.000Z (28,050) | 2025-03-14T19:15:00.000Z → 2025-12-31T23:45:00.000Z (28,051) |
| BTCUSDT | 30m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:00:00.000Z (42,075) | 2024-05-26T14:30:00.000Z → 2025-03-14T18:30:00.000Z (14,025) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:30:00.000Z (14,026) |
| BTCUSDT | 1h | 2022-01-01T00:00:00.000Z → 2024-05-26T13:00:00.000Z (21,037) | 2024-05-26T14:00:00.000Z → 2025-03-14T18:00:00.000Z (7,013) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:00:00.000Z (7,013) |
| BTCUSDT | 4h | 2022-01-01T00:00:00.000Z → 2024-05-26T08:00:00.000Z (5,259) | 2024-05-26T12:00:00.000Z → 2025-03-14T12:00:00.000Z (1,753) | 2025-03-14T16:00:00.000Z → 2025-12-31T20:00:00.000Z (1,754) |
| BTCUSDT | 1d | 2022-01-01T00:00:00.000Z → 2024-05-25T00:00:00.000Z (876) | 2024-05-26T00:00:00.000Z → 2025-03-13T00:00:00.000Z (292) | 2025-03-14T00:00:00.000Z → 2025-12-31T00:00:00.000Z (293) |
| ETHUSDT | 1m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:55:00.000Z (1,262,256) | 2024-05-26T14:56:00.000Z → 2025-03-14T19:27:00.000Z (420,752) | 2025-03-14T19:28:00.000Z → 2025-12-31T23:59:00.000Z (420,752) |
| ETHUSDT | 5m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:50:00.000Z (252,451) | 2024-05-26T14:55:00.000Z → 2025-03-14T19:20:00.000Z (84,150) | 2025-03-14T19:25:00.000Z → 2025-12-31T23:55:00.000Z (84,151) |
| ETHUSDT | 15m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:30:00.000Z (84,150) | 2024-05-26T14:45:00.000Z → 2025-03-14T19:00:00.000Z (28,050) | 2025-03-14T19:15:00.000Z → 2025-12-31T23:45:00.000Z (28,051) |
| ETHUSDT | 30m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:00:00.000Z (42,075) | 2024-05-26T14:30:00.000Z → 2025-03-14T18:30:00.000Z (14,025) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:30:00.000Z (14,026) |
| ETHUSDT | 1h | 2022-01-01T00:00:00.000Z → 2024-05-26T13:00:00.000Z (21,037) | 2024-05-26T14:00:00.000Z → 2025-03-14T18:00:00.000Z (7,013) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:00:00.000Z (7,013) |
| ETHUSDT | 4h | 2022-01-01T00:00:00.000Z → 2024-05-26T08:00:00.000Z (5,259) | 2024-05-26T12:00:00.000Z → 2025-03-14T12:00:00.000Z (1,753) | 2025-03-14T16:00:00.000Z → 2025-12-31T20:00:00.000Z (1,754) |
| ETHUSDT | 1d | 2022-01-01T00:00:00.000Z → 2024-05-25T00:00:00.000Z (876) | 2024-05-26T00:00:00.000Z → 2025-03-13T00:00:00.000Z (292) | 2025-03-14T00:00:00.000Z → 2025-12-31T00:00:00.000Z (293) |
| BNBUSDT | 1m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:55:00.000Z (1,262,256) | 2024-05-26T14:56:00.000Z → 2025-03-14T19:27:00.000Z (420,752) | 2025-03-14T19:28:00.000Z → 2025-12-31T23:59:00.000Z (420,752) |
| BNBUSDT | 5m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:50:00.000Z (252,451) | 2024-05-26T14:55:00.000Z → 2025-03-14T19:20:00.000Z (84,150) | 2025-03-14T19:25:00.000Z → 2025-12-31T23:55:00.000Z (84,151) |
| BNBUSDT | 15m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:30:00.000Z (84,150) | 2024-05-26T14:45:00.000Z → 2025-03-14T19:00:00.000Z (28,050) | 2025-03-14T19:15:00.000Z → 2025-12-31T23:45:00.000Z (28,051) |
| BNBUSDT | 30m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:00:00.000Z (42,075) | 2024-05-26T14:30:00.000Z → 2025-03-14T18:30:00.000Z (14,025) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:30:00.000Z (14,026) |
| BNBUSDT | 1h | 2022-01-01T00:00:00.000Z → 2024-05-26T13:00:00.000Z (21,037) | 2024-05-26T14:00:00.000Z → 2025-03-14T18:00:00.000Z (7,013) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:00:00.000Z (7,013) |
| BNBUSDT | 4h | 2022-01-01T00:00:00.000Z → 2024-05-26T08:00:00.000Z (5,259) | 2024-05-26T12:00:00.000Z → 2025-03-14T12:00:00.000Z (1,753) | 2025-03-14T16:00:00.000Z → 2025-12-31T20:00:00.000Z (1,754) |
| BNBUSDT | 1d | 2022-01-01T00:00:00.000Z → 2024-05-25T00:00:00.000Z (876) | 2024-05-26T00:00:00.000Z → 2025-03-13T00:00:00.000Z (292) | 2025-03-14T00:00:00.000Z → 2025-12-31T00:00:00.000Z (293) |
| SOLUSDT | 1m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:55:00.000Z (1,262,255) | 2024-05-26T14:56:00.000Z → 2025-03-14T19:27:00.000Z (420,752) | 2025-03-14T19:28:00.000Z → 2025-12-31T23:59:00.000Z (420,752) |
| SOLUSDT | 5m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:50:00.000Z (252,451) | 2024-05-26T14:55:00.000Z → 2025-03-14T19:20:00.000Z (84,150) | 2025-03-14T19:25:00.000Z → 2025-12-31T23:55:00.000Z (84,151) |
| SOLUSDT | 15m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:30:00.000Z (84,150) | 2024-05-26T14:45:00.000Z → 2025-03-14T19:00:00.000Z (28,050) | 2025-03-14T19:15:00.000Z → 2025-12-31T23:45:00.000Z (28,051) |
| SOLUSDT | 30m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:00:00.000Z (42,075) | 2024-05-26T14:30:00.000Z → 2025-03-14T18:30:00.000Z (14,025) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:30:00.000Z (14,026) |
| SOLUSDT | 1h | 2022-01-01T00:00:00.000Z → 2024-05-26T13:00:00.000Z (21,037) | 2024-05-26T14:00:00.000Z → 2025-03-14T18:00:00.000Z (7,013) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:00:00.000Z (7,013) |
| SOLUSDT | 4h | 2022-01-01T00:00:00.000Z → 2024-05-26T08:00:00.000Z (5,259) | 2024-05-26T12:00:00.000Z → 2025-03-14T12:00:00.000Z (1,753) | 2025-03-14T16:00:00.000Z → 2025-12-31T20:00:00.000Z (1,754) |
| SOLUSDT | 1d | 2022-01-01T00:00:00.000Z → 2024-05-25T00:00:00.000Z (876) | 2024-05-26T00:00:00.000Z → 2025-03-13T00:00:00.000Z (292) | 2025-03-14T00:00:00.000Z → 2025-12-31T00:00:00.000Z (293) |
| XRPUSDT | 1m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:55:00.000Z (1,262,256) | 2024-05-26T14:56:00.000Z → 2025-03-14T19:27:00.000Z (420,752) | 2025-03-14T19:28:00.000Z → 2025-12-31T23:59:00.000Z (420,752) |
| XRPUSDT | 5m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:50:00.000Z (252,451) | 2024-05-26T14:55:00.000Z → 2025-03-14T19:20:00.000Z (84,150) | 2025-03-14T19:25:00.000Z → 2025-12-31T23:55:00.000Z (84,151) |
| XRPUSDT | 15m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:30:00.000Z (84,150) | 2024-05-26T14:45:00.000Z → 2025-03-14T19:00:00.000Z (28,050) | 2025-03-14T19:15:00.000Z → 2025-12-31T23:45:00.000Z (28,051) |
| XRPUSDT | 30m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:00:00.000Z (42,075) | 2024-05-26T14:30:00.000Z → 2025-03-14T18:30:00.000Z (14,025) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:30:00.000Z (14,026) |
| XRPUSDT | 1h | 2022-01-01T00:00:00.000Z → 2024-05-26T13:00:00.000Z (21,037) | 2024-05-26T14:00:00.000Z → 2025-03-14T18:00:00.000Z (7,013) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:00:00.000Z (7,013) |
| XRPUSDT | 4h | 2022-01-01T00:00:00.000Z → 2024-05-26T08:00:00.000Z (5,259) | 2024-05-26T12:00:00.000Z → 2025-03-14T12:00:00.000Z (1,753) | 2025-03-14T16:00:00.000Z → 2025-12-31T20:00:00.000Z (1,754) |
| XRPUSDT | 1d | 2022-01-01T00:00:00.000Z → 2024-05-25T00:00:00.000Z (876) | 2024-05-26T00:00:00.000Z → 2025-03-13T00:00:00.000Z (292) | 2025-03-14T00:00:00.000Z → 2025-12-31T00:00:00.000Z (293) |
| DOGEUSDT | 1m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:55:00.000Z (1,262,256) | 2024-05-26T14:56:00.000Z → 2025-03-14T19:27:00.000Z (420,752) | 2025-03-14T19:28:00.000Z → 2025-12-31T23:59:00.000Z (420,752) |
| DOGEUSDT | 5m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:50:00.000Z (252,451) | 2024-05-26T14:55:00.000Z → 2025-03-14T19:20:00.000Z (84,150) | 2025-03-14T19:25:00.000Z → 2025-12-31T23:55:00.000Z (84,151) |
| DOGEUSDT | 15m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:30:00.000Z (84,150) | 2024-05-26T14:45:00.000Z → 2025-03-14T19:00:00.000Z (28,050) | 2025-03-14T19:15:00.000Z → 2025-12-31T23:45:00.000Z (28,051) |
| DOGEUSDT | 30m | 2022-01-01T00:00:00.000Z → 2024-05-26T14:00:00.000Z (42,075) | 2024-05-26T14:30:00.000Z → 2025-03-14T18:30:00.000Z (14,025) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:30:00.000Z (14,026) |
| DOGEUSDT | 1h | 2022-01-01T00:00:00.000Z → 2024-05-26T13:00:00.000Z (21,037) | 2024-05-26T14:00:00.000Z → 2025-03-14T18:00:00.000Z (7,013) | 2025-03-14T19:00:00.000Z → 2025-12-31T23:00:00.000Z (7,013) |
| DOGEUSDT | 4h | 2022-01-01T00:00:00.000Z → 2024-05-26T08:00:00.000Z (5,259) | 2024-05-26T12:00:00.000Z → 2025-03-14T12:00:00.000Z (1,753) | 2025-03-14T16:00:00.000Z → 2025-12-31T20:00:00.000Z (1,754) |
| DOGEUSDT | 1d | 2022-01-01T00:00:00.000Z → 2024-05-25T00:00:00.000Z (876) | 2024-05-26T00:00:00.000Z → 2025-03-13T00:00:00.000Z (292) | 2025-03-14T00:00:00.000Z → 2025-12-31T00:00:00.000Z (293) |

## 5. Execution semantics (frozen, unchanged)

- Setup is evaluated on **CLOSED candle N** only.
- Entry is the **OPEN of candle N+1**, via the production `resolveEntry`.
- Outcome via the production `trackOutcome`: TP = final rung reached,
  SL = stop touched, TIMEOUT = forced exit at the CLOSE of the timeout bar
  (`outcome.timeout_bars = 48`).
- Ambiguous bar (both SL and TP touched): SL wins
  (`outcome.sl_priority_on_ambiguous_bar = true`).
- Dataset boundary before an exit ⇒ **OPEN**, never TIMEOUT. OPEN trades are
  excluded from every closed-trade statistic.
- One position at a time per series.
- HTF context uses only CLOSED higher-timeframe candles with
  `closeTime <= evaluated LTF closeTime` (no look-ahead), per the frozen
  `HTF_MAP`.

## 6. Metric definitions (fixed here, not after the fact)

- **tpExitRate** = TP exits / closed trades. Never called "win rate".
- **positiveRRate** = trades with R > 0 / closed trades (includes profitable TIMEOUTs).
- **expectancy** = mean R over CLOSED trades.
- **profit factor** = gross positive R / |gross negative R|.
- **max drawdown R** = largest peak-to-trough decline of the cumulative R curve.
- **expectancy excluding TIMEOUT** = DIAGNOSTIC SENSITIVITY ONLY; never the headline.
- OPEN trades are excluded from all of the above.

Evidence buckets, fixed in advance: **0.45–0.50, 0.50–0.60, 0.60–0.70,
0.70–0.80, 0.80–1.00**.

V1 availableWeight buckets: **<30, 30–50, >50**. V1 score buckets: **<70, 70–90, 90–100**.

Evidence is **not** a probability. Only association is reported (bucket means and
Spearman correlation). No calibration is performed.

## 7. Rules that bind the analyst

1. TEST metrics may be computed only after this protocol, the dataset manifest,
   the ZIP checksums, the settings snapshot and the split boundaries all exist
   and are hashed.
2. The moment TEST is first viewed, `TEST_FIRST_VIEW_AT` is recorded in
   `run-metadata.json` and TEST is **USED**.
3. After that: no changes to V2 parameters, evidence weights, thresholds, the
   target ladder, liquidity lifecycle, `risk.min_rr` or `outcome.timeout_bars`.
4. If a correctness bug is found, statistical interpretation **stops**; the bug
   is described and NOT fixed in this run; the run is marked
   `INVALIDATED_BY_CORRECTNESS_BUG`.
5. Permitted final statuses: `INSUFFICIENT_EVIDENCE`, `V2_NOT_BETTER`,
   `V2_PROMISING_BUT_NOT_PRODUCTION_READY`, or
   `INVALIDATED_BY_CORRECTNESS_BUG`. **`PRODUCTION_READY` is forbidden.**
6. V2 stays research-only: `v2.enabled=false`, not wired to workers, LIVE locked.

## 8. Correctness invariant checked during the run

A liquidity pool in state **SWEPT** or **CONSUMED** must never be used as a
future target. This is audited on every evaluation by re-deriving the pools with
the same frozen detector and comparing them against the emitted ladder. Any
violation invalidates the run.
