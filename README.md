# Polybot Lead-Lag

A standalone Polymarket short-term crypto bot for `BTC` and `ETH` `5m/15m` up/down markets.

## Modes

- `dry-run`: signal logging only
- `paper`: simulated fills, positions, and settlement
- `live`: real CLOB order submission for the international Polymarket platform

## Features

- Binance lead / Chainlink anchor signal model
- Separate strategy profiles for `5m` and `15m`
- Separate thresholds for `UP` and `DOWN`
- Delayed paper-fill simulation
- Per-mode state files: `paper.state.json` and `live.state.json`
- Replay logging (`jsonl`)
- Polyrec-style market data recorder (`csv` per market)
- Latency and source-health diagnostics

## Commands

```bash
npm install
npm run build
npm run dry-run
npm run paper -- --budget=5 --paper-balance=100
npm run live -- --budget=1 --coins=BTC,ETH --durations=5m
```

## Data Outputs

State and logs are stored under `.leadlag-state/` by default:

- `paper.state.json`
- `live.state.json`
- `replay/` for event replay logs
- `market-data/` for per-market CSV snapshots

Each market-data run creates one folder such as:

```text
.leadlag-state/market-data/run-2026-03-21T12-00-00-000Z/
```

Inside it, each tracked market gets its own CSV file with:

- timestamps and seconds to expiry
- baseline, Binance, and Chainlink prices
- delta / gap / pulse metrics
- top-of-book for `UP` and `DOWN`
- `sum_asks`, `sum_bids`, and mid-gap
- preferred side, ask, edge, and lag

## Recorder Config

Optional overrides:

```bash
MARKET_RECORDER_ENABLED=true
MARKET_RECORDER_DIR=market-data
MARKET_RECORDER_MIN_MS=1000
```

Or via CLI:

```bash
--market-recorder-enabled=true
--market-recorder-dir=market-data
--market-recorder-min-ms=1000
```

## Notes

- `live` currently targets the international CLOB API, not Polymarket US.
- Region restrictions still apply in `live` mode.
- For Safe/funder accounts, keep `POLYMARKET_SIGNATURE_TYPE` and `POLYMARKET_FUNDER_ADDRESS` aligned with the account that actually holds balance.
