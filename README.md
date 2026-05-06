# SPYx Venue Arbitrage Scanner

Scanner, paper trader, and guarded live-execution scaffold for SPYx arbitrage between:

- MEXC spot `SPYx/USDT`
- Raydium CLMM pools on Solana, using mint `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`

The scanner and paper trader are read-only. Live mode is available behind explicit safety gates and should only be used after dry-runs, balance checks, and reconciliation are verified.

## Setup

```bash
npm install
cp .env.example .env
npm run scan
```

Edit only the repository root `.env`. Live mode reads the same file; do not create a separate `live/.env`.

Run one scan:

```bash
npm run scan:once
```

Run paper trading with simulated settlement:

```bash
npm run paper
```

Run a scan speed stress test:

```bash
npm run scan:stress
```

## What It Measures

For each size in `TRADE_SIZES_USD`, the scanner compares the configured routes:

- `MEXC_TO_RAYDIUM`: buy SPYx on MEXC, withdraw over Solana, and sell on Raydium for USDC.
- `RAYDIUM_TO_MEXC`: buy SPYx on Raydium with USDC, deposit to MEXC, and sell on MEXC for USDT.

Raydium quotes are computed locally with Raydium SDK v2 from Solana RPC pool state. The scanner does not depend on Raydium Trade API for quotes.

The result accounts for:

- MEXC taker fee
- configured Raydium slippage
- settlement risk buffer
- estimated Solana transaction cost
- optional MEXC withdrawal fee in SPYx
- SPYx Token-2022 `scaledUiAmountConfig`
- MEXC SPYx base precision truncation

SPYx uses Token-2022 `scaledUiAmountConfig`. For `RAYDIUM_TO_MEXC`, the sellable amount on MEXC is modeled as:

```text
sellable = floor((on-chain amount / scaledUiAmount multiplier), MEXC_BASE_PRECISION)
```

The multiplier drag is shown as `scaleDrag`.

## Paper Mode

Paper mode opens simulated positions when `market` exceeds `PAPER_MIN_MARKET_SPREAD_BPS` or when `net` is already positive.

With `PAPER_REALISTIC_MODE=true`, paper mode is closer to live behavior:

- opens only the best opportunity per scan;
- respects available capital through `PAPER_CAPITAL_USD`;
- locks that capital until `PAPER_REALISTIC_SETTLEMENT_DELAY_MS`;
- for `RAYDIUM_TO_MEXC`, sells only the MEXC-creditable SPYx amount;
- floors the MEXC sell quantity to `PAPER_MEXC_BASE_PRECISION`, usually `3` for SPYx;
- subtracts MEXC taker fee, settlement buffer, `SOLANA_TX_COST_USD`, and `PAPER_LIVE_EXTRA_COST_USD`.

With `PAPER_REALISTIC_MODE=false`, paper mode uses the legacy multi-delay model and creates future resolutions from `PAPER_SETTLEMENT_DELAYS_MS`.

## Telegram Alerts

Telegram can send:

- startup notifications;
- immediate opportunity alerts;
- hourly reports with scan count, rate limits, opportunity duration, best spreads, and paper PnL.

Configure:

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_MIN_NET_SPREAD_BPS=25
TELEGRAM_REPORT_INTERVAL_MS=3600000
```

`TELEGRAM_MIN_NET_SPREAD_BPS` can be lower than the trading threshold if you want early warning signals.

## Live Mode

Live mode lives in `live/` and is protected by explicit execution gates:

```env
LIVE_MODE=execute
LIVE_EXECUTION_ENABLED=true
LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY
```

The active risk policy must also set `enabled=true` and explicitly allow the required actions. See [live/README.md](live/README.md).

Useful commands:

```bash
npm run live:check
npm run live:probe-dry-run
npm run live:probe
npm run live:transfer-to-mexc
npm run live:sell-mexc-spyx
npm run live:pnl-report
```

## Important Files

- `src/index.ts`: scanner and paper loop.
- `src/config.ts`: environment configuration.
- `src/opportunity.ts`: route and net-spread calculations.
- `src/clients/mexc.ts`: MEXC order book client.
- `src/clients/raydium.ts`: local Raydium CLMM quotes with SDK v2.
- `src/clients/solana.ts`: token decimals and scaled UI multiplier reads.
- `src/telegram.ts`: Telegram alerts and hourly reports.
- `src/stress-scan.ts`: scan-speed stress test.
- `live/`: guarded real-money execution tools.
- `data/opportunities.csv`: generated scan log.
- `data/paper-trades.csv`: generated paper-trade log.

## Safety Notes

Never commit `.env`, private keys, live state, generated data, or risk-policy files with real settings. These paths are ignored by `.gitignore`.

Recommended workflow before running live:

1. Run `npm run scan` and `npm run paper` for several hours.
2. Confirm `Paper live-adjusted` remains positive after realistic costs.
3. Run `npm run live:check`.
4. Run `npm run live:probe-dry-run`.
5. Only then consider a very small `npm run live:probe` under strict risk caps.
