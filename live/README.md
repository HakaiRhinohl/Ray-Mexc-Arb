# Live Mode Scaffold

This folder is the staging area for real-money SPYx execution. It is intentionally separated from the scanner and paper trader.

Nothing here should move funds until all three gates are open:

- `LIVE_MODE=execute`
- `LIVE_EXECUTION_ENABLED=true`
- `LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY`

The risk policy must also set `enabled=true` and explicitly allow the actions needed for the route.

## Commands

```bash
cp .env.example .env
npm run live:check
npm run live:dry-run
npm run live:probe-dry-run
npm run live:transfer-to-mexc
npm run live:sell-mexc-spyx
npm run live:pnl-report
```

Edit only the repository root `.env`. The `live/` folder does not use a separate `.env`.

Do not run execute mode until dry-run, balances, transfers, and reconciliation are working.

The active risk file is `live/risk-policy.json`; `live/risk-policy.example.json` is the safe template.

## Probe Mode

The first real-money path is intentionally narrow:

```text
RAYDIUM_TO_MEXC
```

SPYx is a Token-2022 mint with `scaledUiAmountConfig`. MEXC credits the raw token amount, while a Solana wallet may display the scaled UI amount. Live economics must compare Raydium raw output against MEXC quantity.

`live:probe-dry-run`:

- reads the current MEXC book
- requests a Raydium `USDC -> SPYx` quote
- checks the instant spread
- writes a plan to `live/state/journal.jsonl`
- stops before signing anything

`live:probe` in execute mode:

- swaps a small amount of USDC into SPYx on Raydium
- writes the swap signature and balance delta to `live/state/journal.jsonl`
- stops unless `LIVE_PROBE_AUTO_TRANSFER_TO_MEXC=true`
- if auto-transfer is enabled, sends the received SPYx to `MEXC_SOLANA_DEPOSIT_ADDRESS`
- if MEXC API credentials are present, polls deposit history for the transfer

Execution requires all of:

```env
LIVE_MODE=execute
LIVE_EXECUTION_ENABLED=true
LIVE_CONFIRMATION=I_UNDERSTAND_REAL_MONEY
```

For the first probe, keep:

```env
LIVE_PROBE_NOTIONAL_USD=25
LIVE_PROBE_MIN_NET_SPREAD_BPS=25
LIVE_PROBE_AUTO_TRANSFER_TO_MEXC=false
```

Only enable `LIVE_PROBE_AUTO_TRANSFER_TO_MEXC=true` after confirming the swap lands in your wallet as expected.

If a probe swap already succeeded but transfer to MEXC was blocked by policy, do not run another probe. Enable deposits in the policy and resume with:

```bash
npm run live:transfer-to-mexc
```

By default it transfers the full SPYx wallet balance. To transfer a specific amount:

```env
LIVE_TRANSFER_SPYX_AMOUNT=0.03468074
```

After the deposit reaches MEXC, sell the credited SPYx with a market sell:

```bash
npm run live:sell-mexc-spyx
```

This requires:

```json
"allowMexcOrders": true
```

By default it sells the full free SPYx balance on MEXC, rounded down to the MEXC symbol precision. To sell a specific amount:

```env
LIVE_SELL_SPYX_AMOUNT=0.034
```

After selling, calculate realized PnL and exact MEXC commissions:

```bash
npm run live:pnl-report
```

## Route Plan

### `RAYDIUM_TO_MEXC`

1. Preflight balances: USDC in Solana wallet, SPYx deposit enabled on MEXC Solana.
2. Quote Raydium `USDC -> SPYx`.
3. Build Raydium swap transaction.
4. Sign and send transaction from the Solana wallet.
5. Transfer or deposit SPYx to the MEXC Solana deposit address.
6. Poll Solana and MEXC deposit history until MEXC credits SPYx.
7. Sell SPYx on MEXC.
8. Reconcile balances and write an immutable state event.

### `MEXC_TO_RAYDIUM`

1. Preflight balances: USDT on MEXC, withdrawal enabled for SPYx on Solana.
2. Buy SPYx on MEXC.
3. Withdraw SPYx to the Solana wallet using MEXC `POST /api/v3/capital/withdraw`.
4. Poll withdrawal history and Solana transaction confirmation.
5. Sell SPYx on Raydium for USDC.
6. Reconcile balances and write an immutable state event.

## Required Modules

- MEXC signed REST client:
  - account balances
  - place spot order
  - query order status
  - query coin/network config
  - query deposit/withdraw history
  - create withdrawal
- Raydium swap executor:
  - compute quote
  - build serialized transaction
  - sign transaction
  - send and confirm transaction
- Solana wallet and token helpers:
  - load keypair
  - detect Token-2022 scaled UI multiplier
  - transfer SPYx SPL/Token-2022 to MEXC deposit address
- Risk engine:
  - max trade size
  - daily loss limit
  - max open transfer count
  - min net spread
  - slippage cap
  - pause on failed reconciliation
- State journal:
  - append-only JSONL
  - every order id, tx id, quote, fill, transfer, deposit event
  - restart-safe recovery

## Official API References

- MEXC Spot API v3: https://mexcdevelop.github.io/apidocs/spot_v3_en/
- Raydium Trade API: https://docs.raydium.io/raydium/build/developer-guides/overview

MEXC withdrawals use `POST /api/v3/capital/withdraw` and require the `SPOT_WITHDRAW_WRITE` permission. The exact Solana `netWork` value must be confirmed from `GET /api/v3/capital/config/getall` before enabling withdrawals.
