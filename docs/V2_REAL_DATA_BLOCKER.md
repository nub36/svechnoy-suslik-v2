# REAL BINANCE DATA — ACQUISITION BLOCKED

> **UPDATE (second attempt, user-hosted mirror).** The user supplied the dataset
> over plain HTTP at `http://89.125.24.50:8080/`. That host is **also**
> unreachable, and the diagnosis below proves the cause is *this sandbox's
> egress filter*, not the user's server. See §6.

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


---

## 6. Second attempt — user-hosted HTTP mirror (also blocked)

The user made the data available outside Binance:

| item | value |
|---|---|
| dataset URL | `http://89.125.24.50:8080/binance-data/binance-history-2022-2025.tar` |
| checksum URL | `…/binance-history-2022-2025.tar.sha256` |
| expected SHA-256 | `86f7dca71423f800441de5602421efa9dc20c65417b1856d62cffc522e273bc4` |
| expected size | 717 762 560 bytes |
| contents | 2016 original Binance monthly ZIPs (6 symbols x 7 timeframes x 48 months, 2022-01..2025-12) |

**Result: not downloadable. Zero bytes of payload ever arrive.**

```
$ curl -I http://89.125.24.50:8080/binance-data/binance-history-2022-2025.tar
curl: (56) Recv failure: Connection reset by peer

$ curl -v http://89.125.24.50:8080/binance-data/…tar.sha256
*   Trying 89.125.24.50:8080...
* Connected to 89.125.24.50 (89.125.24.50) port 8080   <- looks fine
> GET /binance-data/…tar.sha256 HTTP/1.1
> Host: 89.125.24.50:8080
* Empty reply from server                              <- reset on payload
curl: (52) Empty reply from server
```

Tried and all `000`: ports 8080, 80, 8000, 443, and HTTPS on 443.

### The TCP "connection" is fake — proof it is a local filter

A bash `/dev/tcp` probe reports the port OPEN. That is misleading: **every**
address reports OPEN, including addresses that cannot exist on the internet.

```
OPEN  89.125.24.50:8080
OPEN  89.125.24.50:22
OPEN  89.125.24.50:9999      <- arbitrary unused port
OPEN  192.0.2.1:8080         <- RFC 5737 TEST-NET-1, non-routable by definition
```

`192.0.2.0/24` is reserved for documentation and is guaranteed unreachable, yet
it "connects" and then resets exactly like the dataset host:

```
$ curl -v http://192.0.2.1:8080/anything
* Connected to 192.0.2.1 (192.0.2.1) port 8080
* Recv failure: Connection reset by peer
```

A transparent middlebox therefore accepts the SYN for **all** destinations and
resets as soon as an HTTP request is written. Identical behaviour for
`203.0.113.77` (TEST-NET-3), `1.1.1.1`, `8.8.8.8`, `example.com`,
`neverssl.com` — all `000`.

**Conclusion: the user's server is almost certainly fine. Nothing reaches it.**
Egress is a strict allowlist; arbitrary IP:port destinations are impossible.

### Current allowlist (measured)

| reachable | blocked |
|---|---|
| `github.com` 200 | `raw.githubusercontent.com` 000 |
| `api.github.com` 200 | `objects.githubusercontent.com` 000 |
| `codeload.github.com` 301 | `deb.debian.org` 000 |
| `registry.npmjs.org` 200 | any bare IP:port 000 |
| `pypi.org`, `files.pythonhosted.org` 200 | all exchange/market-data hosts 000 |

No proxy variables are set, so there is no configured egress path to opt into.

### What would work

The only channel that moves bytes is **git over `github.com:443`** (verified:
`git clone` and `git ls-remote` both succeed). Therefore:

1. **Preferred — push the data to a GitHub repo** (public or one this sandbox's
   token can read) and give the clone URL. For 685 MB, split into <2 GB pushes;
   Git LFS will **not** work because `objects.githubusercontent.com` is blocked,
   so the files must be committed as ordinary blobs, ideally the 2016 ZIPs
   unchanged so their Binance provenance and per-file SHA-256 stay verifiable.
2. **Or** allowlist `89.125.24.50:8080` (or `data.binance.vision:443`) for this
   sandbox.
3. **Or** attach the archive directly into the workspace filesystem.

Nothing was downloaded, so **no integrity check could be performed**: this is
**not** a `DATASET_INTEGRITY_FAILURE` (which would mean a hash mismatch). The
correct status is **dataset unreachable — acquisition blocked**.
