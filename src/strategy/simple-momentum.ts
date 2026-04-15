import type { StrategyDefinition, StrategyContext } from "../types/index.js";

/**
 * Simple Momentum Strategy
 *
 * This is an example/demo strategy that shows how to use the engine's Strategy API.
 * It works like this:
 *
 * 1. Observe BTC price for the first ~2 seconds
 * 2. If price is trending UP vs the Price to Beat, buy UP shares
 * 3. If price is trending DOWN, buy DOWN shares
 * 4. Set a profit target and stop loss via the onFill callback
 * 5. Try to sell for profit; if market resolves while holding, accept the outcome
 *
 * This is NOT a profitable strategy — it's meant to demonstrate the API.
 */
const simpleMomentum: StrategyDefinition = {
  name: "simple-momentum",
  description: "Demo strategy: observe momentum then buy the trending side",

  run: async (ctx: StrategyContext) => {
    const { market } = ctx;
    const ptb = market.priceTobeat;

    ctx.log.info("Simple momentum strategy started", {
      ptb,
      btcPrice: ctx.getBtcPrice(),
    });

    // Phase 1: Observe price for a bit
    const priceHistory: number[] = [];
    const observeInterval = setInterval(() => {
      priceHistory.push(ctx.getBtcPrice());
    }, 200);

    // Wait 2 seconds to gather observations
    await sleep(2000);
    clearInterval(observeInterval);

    if (priceHistory.length < 3) {
      ctx.log.warn("Not enough price data, skipping this round");
      return;
    }

    // Phase 2: Determine direction
    const firstPrice = priceHistory[0];
    const lastPrice = priceHistory[priceHistory.length - 1];
    const trend = lastPrice - firstPrice;
    const currentPrice = ctx.getBtcPrice();

    // Decide side based on momentum + position relative to PTB
    const abovePtb = currentPrice > ptb;
    const trendingUp = trend > 0;
    const side = abovePtb && trendingUp ? "UP" : !abovePtb && !trendingUp ? "DOWN" : null;

    if (!side) {
      ctx.log.info("No clear signal, sitting this round out", {
        trend: trend.toFixed(2),
        abovePtb,
      });
      return;
    }

    ctx.log.info(`Signal: ${side}`, {
      trend: trend.toFixed(2),
      btcPrice: currentPrice,
      ptb,
    });

    // Phase 3: Place buy order
    const book = ctx.getOrderBook(side);
    const bestAsk = book.asks[0]?.price ?? 0.55;
    const buyPrice = Math.min(0.65, bestAsk); // cap at 65 cents
    const buySize = Math.floor(20 / buyPrice); // spend ~$20 per round

    if (buySize <= 0) {
      ctx.log.warn("Buy size too small, skipping");
      return;
    }

    // Register fill handler before placing order
    ctx.onFill(async (fill, order) => {
      if (order.action !== "buy") return;

      ctx.log.info(`Buy filled! ${fill.size} ${side} shares @ ${fill.price}`, {
        totalCost: (fill.size * fill.price).toFixed(2),
      });

      // Set profit target: sell for 15% profit
      const profitTarget = Math.round((fill.price + 0.08) * 100) / 100;
      const timeLeft = ctx.timeRemaining();

      if (timeLeft > 3000) {
        // Try to sell at profit target
        ctx.log.info(`Setting profit target @ ${profitTarget}`);

        try {
          await ctx.placeOrder({
            side,
            action: "sell",
            price: profitTarget,
            size: fill.size,
            type: "GTD",
            expireAt: market.endTime - 1000, // expire 1s before market ends
          });
        } catch (err) {
          ctx.log.warn("Failed to place profit target", {
            error: String(err),
          });
        }
      }
    });

    try {
      await ctx.placeOrder({
        side,
        action: "buy",
        price: buyPrice,
        size: buySize,
      });

      ctx.log.info(`Buy order placed: ${buySize}x ${side} @ ${buyPrice}`);
    } catch (err) {
      ctx.log.error("Failed to place buy order", { error: String(err) });
    }

    // Return cleanup function
    return () => {
      clearInterval(observeInterval);
    };
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default simpleMomentum;
