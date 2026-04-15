import type { Market, RoundPnl } from "../types/index.js";
import type { StrategyFn } from "../types/strategy.js";
import type { EngineConfig } from "../config.js";
import type { PriceFeed } from "../feeds/btc-price.js";
import { SimulatedPriceFeed } from "../feeds/btc-price.js";
import { SimulatedOrderBook } from "../simulation/sim-order-book.js";
import { SimulatedExchange } from "../simulation/sim-exchange.js";
import { MarketLifecycle } from "./market-lifecycle.js";
import { PnlTracker } from "../logging/pnl-tracker.js";
import { createLogger, setGlobalLogLevel } from "../logging/logger.js";

const log = createLogger("Engine");

let marketCounter = 0;

/**
 * The main engine orchestrator.
 * Discovers market slots, creates lifecycles, runs strategies, and tracks PnL.
 */
export class Engine {
  private config: EngineConfig;
  private priceFeed: PriceFeed;
  private pnlTracker: PnlTracker;
  private running = false;

  constructor(config: EngineConfig) {
    this.config = config;
    setGlobalLogLevel(config.logLevel);

    // For now, always use simulated price feed in simulation mode
    this.priceFeed = new SimulatedPriceFeed();
    this.pnlTracker = new PnlTracker(config.simBalance);
  }

  /**
   * Start the engine. Runs the specified number of rounds sequentially.
   */
  async start(strategyFn: StrategyFn): Promise<void> {
    this.running = true;

    console.log("\n" + "=".repeat(50));
    console.log("  POLYMARKET BTC TRADING ENGINE");
    console.log("=".repeat(50));
    console.log(`  Mode:       ${this.config.mode}`);
    console.log(`  Strategy:   ${this.config.strategy}`);
    console.log(`  Rounds:     ${this.config.rounds}`);
    console.log(`  Balance:    ${this.config.simBalance} USDC`);
    console.log("=".repeat(50) + "\n");

    await this.priceFeed.start();

    for (let round = 1; round <= this.config.rounds; round++) {
      if (!this.running) break;

      log.info(`\n--- Round ${round}/${this.config.rounds} ---`);

      // Create a market slot for this round
      const market = this.createMarketSlot(round);

      // Create the simulation components for this round
      const orderBook = new SimulatedOrderBook(market, this.priceFeed);
      const exchange = new SimulatedExchange(
        this.pnlTracker.currentBalance,
        orderBook
      );

      // Create and run the lifecycle
      const lifecycle = new MarketLifecycle(
        market,
        exchange,
        orderBook,
        this.priceFeed,
        strategyFn
      );

      const result = await lifecycle.run();

      if (result.pnl) {
        this.pnlTracker.recordRound(result.pnl);
      } else {
        log.info("No position taken this round");
      }

      // Brief pause between rounds
      if (round < this.config.rounds) {
        await sleep(500);
      }
    }

    this.priceFeed.stop();
    this.pnlTracker.printSummary();
    this.running = false;
  }

  stop() {
    this.running = false;
    this.priceFeed.stop();
    log.info("Engine stopped");
  }

  /**
   * Create a simulated market slot.
   * In simulation mode, we use compressed time windows (10 seconds instead of 5 minutes)
   * to speed up testing.
   */
  private createMarketSlot(round: number): Market {
    const now = Date.now();
    const btcPrice = this.priceFeed.getPrice();

    // In simulation, use 10-second windows for fast iteration
    const slotDuration =
      this.config.mode === "simulation" ? 10_000 : this.config.slotDuration;

    // Price to Beat = current BTC price with random offset
    // In real markets, PTB is set at the start of the window and BTC drifts from it.
    // We simulate this by setting PTB slightly stale (based on a recent but not current price).
    const offset = (Math.random() - 0.5) * 100; // ±$50
    const priceTobeat = Math.round((btcPrice + offset) * 100) / 100;

    const market: Market = {
      id: `sim-market-${++marketCounter}-r${round}`,
      priceTobeat,
      startTime: now,
      endTime: now + slotDuration,
      tokens: {
        up: `token-up-${marketCounter}`,
        down: `token-down-${marketCounter}`,
      },
      status: "active",
    };

    log.info("Market created", {
      id: market.id,
      ptb: priceTobeat,
      btcPrice,
      windowSec: slotDuration / 1000,
    });

    return market;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
