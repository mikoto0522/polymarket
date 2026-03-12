# Polybot Lead-Lag

An independent Polymarket short-term crypto bot that watches:

- Polymarket orderbooks
- Binance RTDS prices
- Chainlink RTDS prices

It targets `5m` and `15m` `Up/Down` crypto markets and uses a
`Binance lead / Chainlink anchor` model:

- capture the opening Chainlink baseline
- treat Binance as the primary trigger
- use the gap between Binance and Chainlink as the lead signal
- buy the lagging Polymarket side late in the window

## Modes

- `--dry-run`: logs signals only
- `--paper`: simulated balance and settlement
- `--live`: real orders + on-chain redemption
- default: dry-run

## Quick start

```bash
npm install
npm run dry-run
npm run paper -- --budget=5
npm run live -- --budget=5
```

## Notes

- The bot captures the `baseline` from the Chainlink RTDS feed at market start. If it starts too late and misses the baseline, it skips that market.
- Signal quality depends heavily on `BINANCE_TRIGGER_BPS`, `MIN_LEAD_GAP_BPS`, `MIN_EDGE`, and `MAX_ASK`.
- Replay logs are written as `jsonl` under `.leadlag-state/replay/` by default.
- Replay logging is enabled for `dry-run`, `paper`, and `live`. You can change it with `REPLAY_ENABLED=false`.
- This standalone build does not depend on `poly-sdk`.
- `--live` requires `POLYMARKET_PRIVATE_KEY`. You can optionally set `POLYGON_RPC_URL`.
