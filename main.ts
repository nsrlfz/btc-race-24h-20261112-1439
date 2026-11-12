// BTC momentum bot — agent-fun/bars-replay/v1
// Enters when 15-bar momentum exceeds ENTRY_BPS; exits on trailing stop,
// take-profit, or momentum reversal. All arithmetic is bigint; no I/O side-effects.

import { runBars } from './vendor/makefun-bars.ts';

// ── constants ────────────────────────────────────────────────────────────────
const LOOKBACK    = 15;
const MIN_HISTORY = 16;
const ENTRY_BPS   = 45n;
const EXIT_TRAIL  = 30n;
const EXIT_PROFIT = 200n;
const EXIT_MOM    = -60n;
const SLIPPAGE    = 100;

// ── module-level state ───────────────────────────────────────────────────────
const closes: bigint[] = [];
let peak = 0n;   // peak position value (quote units) while in a trade
let cost = 0n;   // cost basis (quote units) of the current position

// ── momentum helper ──────────────────────────────────────────────────────────
function momentum(): bigint | null {
  if (closes.length < MIN_HISTORY) return null;
  const latest = closes[closes.length - 1];
  const prior  = closes[closes.length - 1 - LOOKBACK];
  return (latest - prior) * 10000n / prior;
}

// ── main ─────────────────────────────────────────────────────────────────────
await runBars({
  onBatch(state, batch) {
    // Identify the single symbol (BTC) from the hello message.
    const sym = state.hello.symbols[0].symbol;

    // Record close history from the batch bars directly — not state.close(),
    // which repeats the previous close when no bar arrives for our symbol,
    // corrupting the momentum window.
    let closePrice: bigint | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol === sym) {
        closePrice = BigInt(bar.c);
        closes.push(closePrice);
      }
    }
    if (closePrice === null) return [];   // no bar for our symbol this batch

    const mom = momentum();
    const pos = state.positions.get(sym);
    const qty = pos?.qty ?? 0n;

    if (qty > 0n) {
      // ── in position ──────────────────────────────────────────────────────
      const value = state.value(sym, qty);

      // Update peak.
      if (value > peak) peak = value;

      // Take cost from the position object recorded by the fill.
      cost = pos!.cost;

      // Unrealised PnL in basis points.
      const pnlBps = ((value - cost) * 10000n) / cost;

      // Exit conditions.
      const trailingStop = value <= (peak * (10000n - EXIT_TRAIL)) / 10000n;
      const takeProfit   = pnlBps >= EXIT_PROFIT;
      const momReversal  = mom !== null && mom <= EXIT_MOM;

      if (trailingStop || takeProfit || momReversal) {
        peak = 0n;
        return [{ side: 'sell', symbol: sym, qty, max_slippage_bps: SLIPPAGE }];
      }
      return [];
    }

    // ── not in position ──────────────────────────────────────────────────────
    if (!state.warmingUp && mom !== null && mom >= ENTRY_BPS && state.cash >= 1_000_000n) {
      const buyQty = (state.cash * 10n ** BigInt(state.hello.symbols[0].price_scale)) / closePrice;
      if (buyQty > 0n) {
        return [{ side: 'buy', symbol: sym, notional_quote_units: state.cash, max_slippage_bps: SLIPPAGE }];
      }
    }
    return [];
  },
});
// Revision note: position value uses state.value (qty_scale aware); peak resets to zero on every sell.
// Entry note: buy only when momentum is at least 45 bps, cash is at least 1 USDC, and the state is not warming up.
// Trailing stop fires when position value drops below peak × (10000 − EXIT_TRAIL) / 10000; peak is cleared to zero on each sell.
// A buy is only placed when momentum meets or exceeds the entry threshold, available cash is at least 1 USDC, and the state is not warming up.
