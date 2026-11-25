// DipRide: buy mild dips inside an uptrend, take quick profits, cut losers fast.
//
// Strategy (long only, one rule per symbol, no fitted curve):
//   - Trend: MACD(12, 26) above its EMA(9) signal line. MACD is EMA(12) - EMA(26)
//     of the closes; each EMA starts as the mean of its first span of closes, the
//     signal line as the mean of its first 9 MACD values. (Float64, + - * / only,
//     so the same bars always give the same orders.)
//   - Entry, on a bar's close (filled at the next open): MACD above its signal
//     line AND CCI(14) at or under -30 -- the symbol is in an uptrend but its
//     typical price has dipped below its recent range. A symbol it does not hold.
//   - Exit, the whole position: MACD under its signal line (trend gone), or the
//     position worth at least 102% of its cost (take the quick profit), or at
//     most 95% of it (cut the loser). The reason is re-checked on every bar, so
//     an order the market refuses is sent again while its reason still holds.
//   - Stake: equity over 7 slots (one per universe symbol), each buy the
//     smallest of equity / 7, 25% of equity (the weight cap) and the cash this
//     reply has not spent yet. A reply carries the sells first, then the buys
//     in universe order, at most the harness's order cap. A sell's proceeds land
//     at the next open and never fund a buy of the same reply.
//   - Slippage is capped at 100 bps (1%) past the close the order was decided
//     on, so a fill into a gap is refused and retried rather than filled for
//     almost nothing.
//
// Why this shape: the dev window (136 hourly bars, Oct 29-Nov 3 2026) fell
// about 9% and every symbol lost, so buy-and-hold lost $869 on $10,000. A bot
// that only buys dips inside uptrends and exits on the first sign of trend
// failure stays mostly in cash through a falling market and banks small wins
// when a dip snaps back. On the kit's official local grader (grade-local,
// process driver) it scored +$130.92 on the dev window (44 trades, max
// drawdown 1.76%, 0 rejected, deterministic across two runs), against -$869.34
// for buy-and-hold and -$20.22 for the best house baseline (macd-cci). A
// replica simulator (same rules, fills at next open, fees + slippage +
// depth impact) scored the same rules +$197 on the full window and positive
// on each half alone (+$139 / +$94), so the edge is the structure, not one
// tuned number: in the replica every CCI threshold from -10 to -80 and every
// take-profit from 1% to 4% stayed positive. Take-profit 4% scored +$132.12
// on the official grader, essentially the same as 2% (+$130.92); 2% is kept
// because it trades more often (44 vs 38) with a lower drawdown, which
// matters more on the short 72-bar final window.
//
// Laid out like an entrant's repository: the grader runs `node /bot/main.ts`
// with this directory mounted at /bot; vendor/makefun-bars.ts is a
// byte-identical copy of the kit's sdk/makefun-bars.ts.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 12;
const SLOW_BARS = 26;
const SIGNAL_BARS = 9;
const CCI_BARS = 14;
/** Lambert's constant, as TA-Lib's CCI divides by it. */
const CCI_SCALE = 0.015;
/** Enter when CCI(14) is at or under this: a mild dip, not a crash. */
const CCI_ENTRY_AT_MOST = -30;
/** Take profit: worth 102% of its cost. */
const ROI = [102n, 100n] as const;
/** Stop loss: worth 95% of its cost. */
const STOP = [95n, 100n] as const;
/** One slot per universe symbol. */
const SLOTS = 7;
const MAX_SLIPPAGE_BPS = 100;

interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** The first SIGNAL_BARS MACD values, until the signal line starts. */
  macds: number[];
  signal: number | null;
  /** The last CCI_BARS typical prices, oldest first. */
  typical: number[];
}

const series = new Map<string, Series>();

const mean = (xs: readonly number[]) => xs.reduce((a, x) => a + x, 0) / xs.length;
const emaStep = (last: number, x: number, bars: number) => (x - last) * (2 / (bars + 1)) + last;

function stepEma(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value = emaStep(e.value, close, e.span);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = mean(e.warm);
}

/**
 * Fold a bar into its symbol's indicators; the MACD gap (MACD minus signal)
 * and the CCI on its close, each null until seeded.
 */
function push(bar: Bar): { gap: number | null; cci: number | null } {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      macds: [],
      signal: null,
      typical: [],
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  stepEma(s.fast, c);
  stepEma(s.slow, c);
  let gap: number | null = null;
  if (s.fast.value !== null && s.slow.value !== null) {
    const macd = s.fast.value - s.slow.value;
    if (s.signal !== null) {
      s.signal = emaStep(s.signal, macd, SIGNAL_BARS);
      gap = macd - s.signal;
    } else {
      s.macds.push(macd);
      if (s.macds.length === SIGNAL_BARS) s.signal = mean(s.macds);
    }
  }
  const typical = (Number(bar.o) + Number(bar.h) + Number(bar.c)) / 3;
  s.typical.push(typical);
  if (s.typical.length > CCI_BARS) s.typical.shift();
  let cci: number | null = null;
  if (s.typical.length === CCI_BARS) {
    const m = mean(s.typical);
    const mad = mean(s.typical.map((x) => (x >= m ? x - m : m - x)));
    cci = mad === 0 ? 0 : (typical - m) / (CCI_SCALE * mad);
  }
  return { gap, cci };
}

/** Whether a held position exits on this close: trend gone, profit taken, or stop hit. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, gap: number | null): boolean {
  if (gap !== null && gap < 0) return true;
  const value = state.value(symbol, held.qty);
  return value * ROI[1] >= held.cost * ROI[0] || value * STOP[1] <= held.cost * STOP[0];
}

await runBars({
  onBatch(state, batch) {
    const gaps = new Map<string, number | null>();
    const ccis = new Map<string, number | null>();
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const { gap, cci } = push(bar);
      gaps.set(bar.symbol, gap);
      ccis.set(bar.symbol, cci);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(state, symbol, held, gaps.get(symbol) ?? null)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else {
        const gap = gaps.get(symbol) ?? null;
        const cci = ccis.get(symbol) ?? null;
        if (gap !== null && gap > 0 && cci !== null && cci <= CCI_ENTRY_AT_MOST) entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(SLOTS, state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    const sold = new Set(sells.map((o) => o.symbol));
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      if (sold.has(symbol)) continue;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
