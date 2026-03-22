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
- Replay logging (`jsonl`) with compact defaults for `paper`/`live`
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

## Recorder Config

Optional overrides:

```bash
REPLAY_TICKS_ENABLED=false
```

Or via CLI:

```bash
```

## Notes

- `live` currently targets the international CLOB API, not Polymarket US.
- Region restrictions still apply in `live` mode.
- For Safe/funder accounts, keep `POLYMARKET_SIGNATURE_TYPE` and `POLYMARKET_FUNDER_ADDRESS` aligned with the account that actually holds balance.
