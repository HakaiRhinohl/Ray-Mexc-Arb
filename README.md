# SPYx Venue Arbitrage Scanner

Scanner inicial para medir oportunidades entre:

- MEXC spot `SPYx/USDT`
- Raydium en Solana, usando el mint `XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`

Esta primera versión es **solo lectura / paper scanner**. No usa API keys, no ejecuta órdenes, no retira fondos y no firma transacciones.

## Setup

```bash
npm install
cp .env.example .env
npm run scan
```

The only environment file you should edit is the root `.env`. Live mode reads the same file; do not create a separate `live/.env`.

Para una sola medición:

```bash
npm run scan:once
```

Para paper trading con simulación de settlement:

```bash
npm run paper
```

## Qué mide

Para cada tamaño en `TRADE_SIZES_USD`, compara dos rutas:

- `MEXC_TO_RAYDIUM`: comprar SPYx en MEXC, retirar por Solana y vender en Raydium por USDC.
- `RAYDIUM_TO_MEXC`: comprar SPYx en Raydium con USDC, depositar en MEXC y vender en MEXC por USDT.

El modo `paper` abre simulaciones cuando `market` supera `PAPER_MIN_MARKET_SPREAD_BPS` o cuando `net` ya es positivo.

Con `PAPER_REALISTIC_MODE=true`, el paper intenta parecerse más a live:

- abre solo una oportunidad por scan, la mejor que quepa en `PAPER_CAPITAL_USD`;
- bloquea ese capital hasta `PAPER_REALISTIC_SETTLEMENT_DELAY_MS`;
- para `RAYDIUM_TO_MEXC`, calcula el SPYx vendible en MEXC como `on-chain amount / scaledUiAmount multiplier`;
- trunca la venta a `PAPER_MEXC_BASE_PRECISION`, que para MEXC SPYx suele ser `3`;
- resta fee taker de MEXC, buffer de settlement, `SOLANA_TX_COST_USD` y `PAPER_LIVE_EXTRA_COST_USD`.

Con `PAPER_REALISTIC_MODE=false`, conserva el modo legacy y crea resoluciones futuras según `PAPER_SETTLEMENT_DELAYS_MS`.

El resultado resta:

- fee taker de MEXC
- slippage configurado para Raydium
- buffer de riesgo de settlement
- coste estimado de transacción Solana
- fee opcional de withdrawal de MEXC en SPYx

SPYx usa `scaledUiAmountConfig` de Token-2022. Para `RAYDIUM_TO_MEXC`, la cantidad vendible en MEXC se modela como `on-chain amount / scaledUiAmount multiplier`, que es el drag que aparece como `scaleDrag`.

## Archivos importantes

- `src/index.ts`: loop principal.
- `src/config.ts`: configuración por variables de entorno.
- `src/opportunity.ts`: cálculo de rutas y spread neto.
- `src/clients/mexc.ts`: order book de MEXC.
- `src/clients/raydium.ts`: quotes locales de Raydium CLMM con SDK v2.
- `src/clients/solana.ts`: lectura de decimales del mint.
- `data/opportunities.csv`: log generado con cada scan.
- `data/paper-trades.csv`: aperturas y resoluciones del paper trader.

## Siguiente paso

Deja `npm run paper` corriendo varias horas. Si el `Paper live-adjusted` sigue positivo de forma repetida, el siguiente módulo debería ser ejecución semi-manual con confirmación antes de enviar órdenes reales.
