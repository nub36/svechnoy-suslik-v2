# REAL BINANCE DATA — ACQUISITION BLOCKED

**Status:** the real-historical-data stage **cannot start** from this
environment. This document records the exact technical cause, the evidence, and
what would unblock it. No synthetic substitute was used, and none will be.

Frozen strategy commit: **`4839074`** (see `docs/V2_RESEARCH_FREEZE.md`).
Stage 1 (push the freeze) is **complete**. Stages 2–20 are **blocked at Stage 2**.

---

## 1. Verdict

`data.binance.vision` and every Binance API host are **network-unreachable from
this sandbox**. DNS resolves and the TCP socket opens, but the TLS handshake is
terminated by the network immediately after the Client Hello. General internet
egress works, so this is selective filtering, not a broken sandbox.

## 2. Evidence

### Binance hosts — all fail

| endpoint | result |
|---|---|
| `https://data.binance.vision/...BTCUSDT-1h-2024-01.zip` | curl `000` |
| `https://data.binance.vision/?prefix=data/spot/monthly/klines/BTCUSDT/1h/` | curl `000` |
| `https://api.binance.com/api/v3/ping` | curl `000` |
| `https://api1/2/3/4.binance.com/api/v3/ping` | curl `000` |
| `https://api-gcp.binance.com/api/v3/ping` | curl `000` |
| `https://data-api.binance.vision/api/v3/ping` | curl `000` |
| `https://fapi.binance.com/fapi/v1/ping` | curl `000` |
| `https://www.binance.com` | curl `000` |

### Control — general internet works

| endpoint | result |
|---|---|
| `https://registry.npmjs.org/` | **200** |
| `https://github.com` | **200** |
| `https://api.github.com` | **200** |
| `git clone https://github.com/...` | **works** |

### Failure layer — TLS, not DNS or routing

```
$ getent hosts data.binance.vision
18.238.238.96                         <- DNS resolves fine

$ curl -v https://data.binance.vision/
*   Trying 18.238.238.16:443...
* Connected to data.binance.vision (18.238.238.16) port 443   <- TCP opens
* TLSv1.3 (OUT), TLS handshake, Client hello (1):
* OpenSSL SSL_connect: SSL_ERROR_SYSCALL                       <- killed here
curl: (35) OpenSSL SSL_connect: SSL_ERROR_SYSCALL
```

A raw TCP connect to `18.238.238.96:443` succeeds, so the port is reachable.
Requesting that same IP with an unrelated SNI (`--resolve example.com:443:<ip>`)
also fails, and port 80 fails too — so the filter is keyed on the **destination
IP range**, not on the hostname/SNI. No proxy variables are set in the
environment.

### Every other market-data source is blocked too

`api.bybit.com`, `api.kraken.com`, `api.coinbase.com`, `api.kucoin.com`,
`api.okx.com`, `api.gateio.ws`, `api.mexc.com`, `api.coingecko.com`,
`min-api.cryptocompare.com`, `api.tiingo.com`, `query1.finance.yahoo.com`,
`www.cryptodatadownload.com`, `huggingface.co` — **all curl `000`**.

(These were probed only to characterise the filter. Per the task, another
exchange's data would **not** be an acceptable substitute for Binance Spot.)

### The official Binance GitHub repo does not contain candles

GitHub is reachable, so `binance/binance-public-data` was cloned and inspected
directly. It contains **downloader scripts and changelogs only**. Its single
`*_kline_updates.zip` is a checksum manifest:

```
File Path,Original File Checksum,New File Checksum
data/spot/daily/klines/1INCHBTC/1m/1INCHBTC-1m-2021-03-28.zip,38103fbe...,65d8c1cc...
```

— filenames and SHA-256 values, **zero OHLCV rows**. Its README confirms the
data itself lives only at `https://data.binance.vision/`, which is blocked.

## 3. Why no workaround was used

* **Synthetic fixtures are not a substitute.** Explicitly forbidden, and
  correctly so: `fixtures/` is a mulberry32 PRNG and says nothing about markets.
* **Another exchange is not a substitute.** Explicitly forbidden; and they are
  blocked anyway.
* **Third-party GitHub CSVs were rejected.** GitHub code search does surface
  vendored `BTCUSDT.csv` files, and they are technically downloadable. They were
  **not** used: provenance is unverifiable (unknown exchange/market/quote,
  unknown adjustments, unknown gap handling, no download-time attestation), so
  they cannot satisfy the required provenance fields — `exchange = Binance`,
  `market = Spot`, source URL, download timestamp — nor support an honest
  dataset manifest. Passing them off as "real Binance data" would be worse than
  reporting the blocker, because every downstream statistic would inherit
  silent, unquantifiable contamination.

## 4. What would unblock this

Any one of:

1. **Allowlist Binance egress** in the sandbox: `data.binance.vision` (and
   ideally `api.binance.com`) on TCP/443. The archive alone is sufficient — it
   serves monthly/daily kline ZIPs and needs no API key.
2. **Provide an HTTP(S) proxy** that can reach those hosts, exposed via
   `HTTPS_PROXY`.
3. **Attach the data out-of-band** — e.g. upload the
   `data.binance.vision` ZIPs (or their extracted CSVs) into the workspace.
   The expected layout is the archive's own:
   `data/spot/monthly/klines/{SYMBOL}/{INTERVAL}/{SYMBOL}-{INTERVAL}-{YYYY-MM}.zip`

Required coverage per the task: `BTCUSDT ETHUSDT BNBUSDT SOLUSDT XRPUSDT
DOGEUSDT` at `5m 15m 30m 1h 4h 1d` (1m optional), from 2022-01-01 (intraday) /
2020-01-01 (1h+), to the last fully closed day.

## 5. State when blocked

| item | state |
|---|---|
| Stage 1 — push freeze | **done** — `4839074` on `arena/01a09fa1-svechnoy-suslik-v2` |
| Stage 2 — acquire real data | **BLOCKED** (this document) |
| Stages 3–20 | not started; all depend on Stage 2 |
| Strategy logic | **unchanged** since the freeze |
| `v2.enabled` | `false` |
| V2 in production workers | absent |
| `LIVE_TRADING_ENABLED` | `false` |
| FORWARD_TEST history | untouched |

No data tooling was written speculatively: a downloader that cannot reach its
source, and a pipeline with nothing to validate, would be untested code
pretending to be progress.
