import type { StrategyDefinition, StrategyContext, MarketSide } from "../types/index.js";

/**
 * Oracle-OBI Hybrid Strategy
 *
 * Combines two validated signals for Polymarket 5-minute BTC prediction markets:
 *
 * 1. Oracle Lead Detection — Compares real-time BTC price movement against the
 *    Polymarket order book's implied probability. When BTC has moved significantly
 *    but the order book hasn't repriced, shares are mispriced.
 *
 * 2. Order Book Imbalance (OBI) Confirmation — Calculates the bid/ask volume ratio
 *    to confirm directional pressure before entering a position.
 *
 * The strategy enters only when BOTH signals agree, applies strict risk management,
 * and exits via profit target or holds to resolution.
 *
 * Based on research showing:
 * - Oracle latency creates a ~55 second repricing window (61.4% backtest win rate)
 * - OBI has a near-linear relationship with short-horizon price changes
 * - Combined signals filter out false positives from either signal alone
 */

// --- Configuration ---
const CONFIG = {
  /** Minimum BTC price deviation from PTB to consider a signal (as % of PTB) */
  minPriceDeviationPct: 0.05,
  /** OBI threshold — must exceed this to confirm direction (-1 to 1 scale) */
  obiThreshold: 0.15,
  /** Maximum share price to pay (caps downside risk) */
  maxSharePrice: 0.62,
  /** Minimum share price — avoid buying near certainty (low upside) */
  minSharePrice: 0.30,
  /** Profit target: sell when shares are worth this much more than entry */
  profitTargetSpread: 0.10,
  /** Maximum loss per share before stop-loss exits. MUST be <= profitTargetSpread
   *  to maintain a favorable risk/reward ratio. */
  maxLossPerShare: 0.06,
  /** Fraction of balance to risk per round */
  riskPerRound: 0.02,
  /** Observation period before entering (ms) */
  observationPeriod: 3000,
  /** Price sampling interval during observation (ms) */
  sampleInterval: 200,
  /** Minimum time remaining to enter a trade (ms) */
  minTimeToEnter: 5000,
  /** Time remaining at which we stop trying to sell and just hold to resolution (ms) */
  holdToResolutionThreshold: 3000,
  /** Number of order book levels to consider for OBI calculation */
  obiDepth: 3,
};

const oracleObiHybrid: StrategyDefinition = {
  name: "oracle-obi-hybrid",
  description:
    "Hybrid strategy combining oracle lead detection with order book imbalance confirmation",

  run: async (ctx: StrategyContext) => {
    const { market } = ctx;
    const ptb = market.priceTobeat;

    ctx.log.info("Oracle-OBI Hybrid strategy started", {
      ptb,
      btcPrice: ctx.getBtcPrice(),
      timeWindow: `${(market.endTime - market.startTime) / 1000}s`,
    });

    // --- Phase 1: Observe and collect data ---
    const priceSamples: { price: number; timestamp: number }[] = [];
    let observing = true;

    const sampleInterval = setInterval(() => {
      if (!observing) return;
      priceSamples.push({
        price: ctx.getBtcPrice(),
        timestamp: Date.now(),
      });
    }, CONFIG.sampleInterval);

    await sleep(CONFIG.observationPeriod);
    observing = false;

    if (priceSamples.length < 5) {
      ctx.log.warn("Insufficient price data, skipping round");
      clearInterval(sampleInterval);
      return;
    }

    // --- Phase 2: Signal generation ---
    const currentPrice = ctx.getBtcPrice();
    const priceDeviation = (currentPrice - ptb) / ptb;
    const absDeviation = Math.abs(priceDeviation);

    // Check minimum time remaining
    if (ctx.timeRemaining() < CONFIG.minTimeToEnter) {
      ctx.log.info("Not enough time remaining, skipping");
      clearInterval(sampleInterval);
      return;
    }

    // Signal 1: Oracle Lead — is BTC price diverging from PTB?
    const oracleSignal = absDeviation >= CONFIG.minPriceDeviationPct / 100;
    const oracleDirection: MarketSide = priceDeviation > 0 ? "UP" : "DOWN";

    ctx.log.info("Oracle signal", {
      deviation: `${(priceDeviation * 100).toFixed(4)}%`,
      direction: oracleDirection,
      active: oracleSignal,
    });

    if (!oracleSignal) {
      ctx.log.info("Price too close to PTB, no clear oracle signal — skipping");
      clearInterval(sampleInterval);
      return;
    }

    // Signal 2: Order Book Imbalance on the signaled side
    const targetSide = oracleDirection;
    const obi = calculateOBI(ctx, targetSide);

    ctx.log.info("OBI signal", {
      obi: obi.toFixed(4),
      threshold: CONFIG.obiThreshold,
      confirms: obi > CONFIG.obiThreshold,
    });

    // OBI must confirm the oracle direction
    // Positive OBI = more bid volume than ask volume = buying pressure
    if (obi < CONFIG.obiThreshold) {
      ctx.log.info("OBI does not confirm oracle direction — skipping");
      clearInterval(sampleInterval);
      return;
    }

    // Signal 3: Momentum confirmation — is price trending in the right direction?
    const firstPrice = priceSamples[0].price;
    const lastPrice = priceSamples[priceSamples.length - 1].price;
    const momentum = lastPrice - firstPrice;
    const momentumConfirms =
      (targetSide === "UP" && momentum > 0) ||
      (targetSide === "DOWN" && momentum < 0);

    ctx.log.info("Momentum signal", {
      trend: momentum.toFixed(2),
      confirms: momentumConfirms,
    });

    // Require at least 2 of 3 signals (oracle is always required)
    if (!momentumConfirms && obi < CONFIG.obiThreshold * 1.5) {
      ctx.log.info("Momentum contradicts and OBI is marginal — skipping");
      clearInterval(sampleInterval);
      return;
    }

    // --- Phase 3: Entry ---
    const book = ctx.getOrderBook(targetSide);
    const bestAsk = book.asks[0]?.price ?? 0.55;

    // Price sanity checks
    if (bestAsk > CONFIG.maxSharePrice) {
      ctx.log.info(`Best ask ${bestAsk} exceeds max ${CONFIG.maxSharePrice} — skipping`);
      clearInterval(sampleInterval);
      return;
    }
    if (bestAsk < CONFIG.minSharePrice) {
      ctx.log.info(`Best ask ${bestAsk} below min ${CONFIG.minSharePrice} — skipping`);
      clearInterval(sampleInterval);
      return;
    }

    const buyPrice = bestAsk;
    const maxSpend = 1000 * CONFIG.riskPerRound; // Using approximate balance
    const buySize = Math.floor(maxSpend / buyPrice);

    if (buySize <= 0) {
      ctx.log.warn("Calculated buy size is 0 — skipping");
      clearInterval(sampleInterval);
      return;
    }

    ctx.log.info(`ENTERING: ${buySize}x ${targetSide} @ ${buyPrice}`, {
      confidence: calculateConfidence(absDeviation, obi, momentumConfirms),
      spend: (buySize * buyPrice).toFixed(2),
    });

    // Set up fill handler for profit target
    ctx.onFill(async (fill, order) => {
      if (order.action !== "buy") return;

      ctx.log.info(`Buy filled: ${fill.size}x ${targetSide} @ ${fill.price}`);

      // Set profit target
      const profitTarget =
        Math.round((fill.price + CONFIG.profitTargetSpread) * 100) / 100;

      if (ctx.timeRemaining() > CONFIG.holdToResolutionThreshold) {
        ctx.log.info(`Profit target set @ ${profitTarget}`);
        try {
          await ctx.placeOrder({
            side: targetSide,
            action: "sell",
            price: profitTarget,
            size: fill.size,
            type: "GTD",
            expireAt: market.endTime - 1000,
          });
        } catch (err) {
          ctx.log.warn("Failed to set profit target", { error: String(err) });
        }
      } else {
        ctx.log.info("Too close to resolution for profit target — holding to expiry");
      }
    });

    // Set up sell fill handler for logging
    ctx.onFill((fill, order) => {
      if (order.action !== "sell") return;
      const entryPrice = buyPrice;
      const profit = (fill.price - entryPrice) * fill.size;
      ctx.log.info(`Profit target hit! Sold ${fill.size}x @ ${fill.price}`, {
        profit: profit.toFixed(4),
      });
    });

    // Monitor for signal weakening (stop loss logic)
    // Instead of emergency selling at whatever the bid is (which causes huge losses),
    // we place a limit stop-loss sell at entry - maxLossPerShare.
    // We also trigger earlier: when price crosses back to PTB (not past it).
    let stopLossPlaced = false;
    const monitorInterval = setInterval(async () => {
      if (stopLossPlaced) return;

      const timeLeft = ctx.timeRemaining();
      if (timeLeft < CONFIG.holdToResolutionThreshold) {
        clearInterval(monitorInterval);
        return;
      }

      const currentBtc = ctx.getBtcPrice();
      const currentDeviation = (currentBtc - ptb) / ptb;

      // Trigger stop-loss when price crosses back toward PTB (signal weakening),
      // NOT when it fully reverses past PTB (by then it's too late)
      const signalWeakening =
        (targetSide === "UP" && currentDeviation < 0) ||
        (targetSide === "DOWN" && currentDeviation > 0);

      if (signalWeakening) {
        stopLossPlaced = true;
        clearInterval(monitorInterval);

        // Cancel the profit target order first
        try {
          await ctx.cancelAllOrders();
        } catch { /* ignore */ }

        // Place a stop-loss sell at a capped price (entry - maxLoss), NOT at best bid
        const stopPrice = Math.round(
          Math.max(0.01, buyPrice - CONFIG.maxLossPerShare) * 100
        ) / 100;

        ctx.log.warn("Signal weakening — placing stop-loss sell", {
          currentBtc,
          deviation: `${(currentDeviation * 100).toFixed(4)}%`,
          stopPrice,
          maxLoss: (CONFIG.maxLossPerShare * buySize).toFixed(2),
        });

        const pos = ctx.getPosition();
        if (pos && pos.shares > 0) {
          try {
            await ctx.placeOrder({
              side: targetSide,
              action: "sell",
              price: stopPrice,
              size: pos.shares,
            });
          } catch (err) {
            ctx.log.error("Stop-loss sell failed", { error: String(err) });
          }
        }
      }
    }, 500);

    // Place the buy order
    try {
      await ctx.placeOrder({
        side: targetSide,
        action: "buy",
        price: buyPrice,
        size: buySize,
      });
    } catch (err) {
      ctx.log.error("Failed to place buy order", { error: String(err) });
    }

    // Return cleanup
    return () => {
      clearInterval(sampleInterval);
      clearInterval(monitorInterval);
    };
  },
};

/**
 * Calculate Order Book Imbalance across multiple depth levels.
 *
 * OBI = (totalBidVolume - totalAskVolume) / (totalBidVolume + totalAskVolume)
 *
 * Returns value between -1 (heavy selling pressure) and +1 (heavy buying pressure).
 * Uses volume-weighted levels where closer levels carry more weight.
 */
function calculateOBI(ctx: StrategyContext, side: MarketSide): number {
  const book = ctx.getOrderBook(side);

  let totalBidVol = 0;
  let totalAskVol = 0;

  const depth = Math.min(CONFIG.obiDepth, book.bids.length, book.asks.length);

  for (let i = 0; i < depth; i++) {
    // Weight closer levels more heavily (level 0 = 3x, level 1 = 2x, level 2 = 1x)
    const weight = depth - i;
    totalBidVol += (book.bids[i]?.size ?? 0) * weight;
    totalAskVol += (book.asks[i]?.size ?? 0) * weight;
  }

  const totalVol = totalBidVol + totalAskVol;
  if (totalVol === 0) return 0;

  return (totalBidVol - totalAskVol) / totalVol;
}

/**
 * Calculate a confidence score (0–1) based on signal strength.
 */
function calculateConfidence(
  absDeviation: number,
  obi: number,
  momentumConfirms: boolean
): string {
  let score = 0;

  // Oracle strength (0-0.4)
  score += Math.min(0.4, absDeviation * 200);

  // OBI strength (0-0.35)
  score += Math.min(0.35, obi * 0.35);

  // Momentum (0-0.25)
  if (momentumConfirms) score += 0.25;

  return `${(score * 100).toFixed(0)}%`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default oracleObiHybrid;
