import type { Market, MarketSide, OrderBook } from "../types/index.js";
import type { EngineConfig } from "../config.js";
import { LivePriceFeed } from "../feeds/btc-price.js";
import {
  PolymarketGammaClient,
  getNextBtcMarket,
} from "../market/polymarket-api.js";
import { PolymarketOrderBookFeed } from "../market/polymarket-ws.js";
import { TradeJournal, type TradeJournalEntry } from "../logging/trade-journal.js";
import { createLogger, setGlobalLogLevel } from "../logging/logger.js";

const log = createLogger("Shadow");

/** 5-minute window in milliseconds */
const WINDOW_MS = 5 * 60 * 1000;

/** Max time we'll wait for a market to start (6 minutes) */
const MAX_WAIT_MS = 6 * 60 * 1000;

/**
 * Shadow mode configuration for the Oracle-OBI strategy.
 * Mirrors the real strategy config so results are comparable.
 */
const STRATEGY_CONFIG = {
  minPriceDeviationPct: 0.05,
  obiThreshold: 0.15,
  maxSharePrice: 0.75,
  minSharePrice: 0.30,
  profitTargetSpread: 0.10,
  maxLossPerShare: 0.06,
  riskPerRound: 0.02,
  obiDepth: 3,
  /** How many seconds into the window to observe before signaling */
  observeSeconds: 15,
};

interface ShadowStats {
  totalRounds: number;
  tradesEntered: number;
  virtualWins: number;
  virtualLosses: number;
  skipped: number;
  totalVirtualPnl: number;
}

/**
 * Shadow Engine — watches real Polymarket 5-minute BTC markets in real time,
 * runs the Oracle-OBI strategy logic, and logs what it WOULD have done.
 * Never places real orders.
 *
 * This is the critical validation step before going live.
 */
export class ShadowEngine {
  private config: EngineConfig;
  private priceFeed: LivePriceFeed;
  private gammaClient: PolymarketGammaClient;
  private orderBookFeed: PolymarketOrderBookFeed;
  private journal: TradeJournal;
  private running = false;
  private stats: ShadowStats = {
    totalRounds: 0,
    tradesEntered: 0,
    virtualWins: 0,
    virtualLosses: 0,
    skipped: 0,
    totalVirtualPnl: 0,
  };

  constructor(config: EngineConfig) {
    this.config = config;
    setGlobalLogLevel(config.logLevel);
    this.priceFeed = new LivePriceFeed();
    this.gammaClient = new PolymarketGammaClient();
    this.orderBookFeed = new PolymarketOrderBookFeed();
    this.journal = new TradeJournal("./logs");
  }

  async start(): Promise<void> {
    this.running = true;

    console.log("\n" + "=".repeat(50));
    console.log("  SHADOW MODE — Polymarket BTC Engine");
    console.log("  Watching real markets, logging virtual trades");
    console.log("  NO real orders will be placed");
    console.log("=".repeat(50));
    console.log(`  Rounds:     ${this.config.rounds}`);
    console.log(`  Strategy:   oracle-obi-hybrid (shadow)`);
    console.log(`  Journal:    ${this.journal.getFilePath()}`);
    console.log("=".repeat(50) + "\n");

    // Step 1: Connect to live BTC price feed
    log.info("Connecting to live BTC price feed...");
    try {
      await this.priceFeed.start();
    } catch (err) {
      log.error("Failed to connect to price feed", { error: String(err) });
      log.info("Shadow mode requires a live BTC price feed. Exiting.");
      return;
    }

    // Wait a moment for price to populate
    await sleep(2000);
    const initialPrice = this.priceFeed.getPrice();
    if (initialPrice === 0) {
      log.error("No BTC price received after 2s. Check your internet connection.");
      this.priceFeed.stop();
      return;
    }
    log.info(`Live BTC price: $${initialPrice.toLocaleString()}`);

    // Step 2: Run the shadow loop
    for (let round = 1; round <= this.config.rounds; round++) {
      if (!this.running) break;

      log.info(`\n--- Shadow Round ${round}/${this.config.rounds} ---`);

      try {
        await this.runRound(round);
      } catch (err) {
        log.error("Round failed", { round, error: String(err) });
      }

      this.stats.totalRounds++;
    }

    // Cleanup
    this.priceFeed.stop();
    this.journal.close();
    this.printSummary();
    this.running = false;
  }

  stop() {
    this.running = false;
    this.priceFeed.stop();
    this.orderBookFeed.disconnect();
    this.journal.close();
    log.info("Shadow engine stopped");
  }

  /**
   * Run a single shadow round:
   * 1. Wait for the next 5-minute window to start
   * 2. Capture BTC price at window open = PTB
   * 3. Discover the market for this window
   * 4. Connect to order book
   * 5. Run strategy
   * 6. Wait for resolution
   */
  private async runRound(round: number): Promise<void> {
    // --- Phase 1: Wait for the next window boundary ---
    const now = Date.now();
    const currentWindowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const nextWindowStart = currentWindowStart + WINDOW_MS;
    const waitUntilStart = nextWindowStart - now;

    // If we're within the first 30s of the current window, use this window
    const timeIntoCurrentWindow = now - currentWindowStart;
    let targetWindowStart: number;

    if (timeIntoCurrentWindow < 30_000) {
      // We're early enough in the current window — use it
      targetWindowStart = currentWindowStart;
      log.info("Using current window (within first 30s)", {
        windowStart: new Date(targetWindowStart).toISOString(),
        timeInto: `${Math.round(timeIntoCurrentWindow / 1000)}s`,
      });
    } else {
      // Wait for the next window
      targetWindowStart = nextWindowStart;
      log.info(`Waiting ${Math.round(waitUntilStart / 1000)}s for next window...`, {
        nextWindow: new Date(targetWindowStart).toISOString(),
      });

      if (waitUntilStart > MAX_WAIT_MS) {
        log.error("Wait time exceeds maximum, skipping");
        return;
      }

      // Wait until ~1 second before the window starts
      const sleepTime = Math.max(0, waitUntilStart - 1000);
      await sleep(sleepTime);

      // Spin-wait for precision
      while (Date.now() < targetWindowStart && this.running) {
        await sleep(50);
      }
    }

    if (!this.running) return;

    // --- Phase 2: Capture PTB = BTC price at window open ---
    const ptb = this.priceFeed.getPrice();
    const windowEndTime = targetWindowStart + WINDOW_MS;

    log.info("Window opened — captured PTB", {
      ptb: `$${ptb.toLocaleString()}`,
      windowEnd: new Date(windowEndTime).toISOString(),
    });

    // --- Phase 3: Discover the market for this window ---
    // Retry up to 5 times with 3s delays — the Gamma API can be slow to index new windows.
    // With 5 slug windows checked per attempt, this is very thorough.
    this.gammaClient.setLiveBtcPrice(ptb);
    let market: Market | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      market = await getNextBtcMarket(this.gammaClient);
      if (market) break;
      if (attempt < 5) {
        log.debug(`Market not found (attempt ${attempt}/5), retrying in 3s...`);
        await sleep(3000);
      }
    }

    if (!market) {
      log.warn("No market found for this window after 5 attempts");
      this.recordSkip(
        { id: "unknown", priceTobeat: ptb, startTime: targetWindowStart, endTime: windowEndTime, tokens: { up: "", down: "" }, status: "active" },
        round, ptb, 0, 0, 0, "no_market_found"
      );
      // Wait for window to end before next round
      const remaining = windowEndTime - Date.now();
      if (remaining > 0) await sleep(remaining);
      return;
    }

    // Override the PTB with our captured price (more accurate than API fallback)
    market.priceTobeat = ptb;

    // --- Phase 4: Connect to order book ---
    try {
      await this.orderBookFeed.connect(market.tokens);
    } catch (err) {
      log.debug("Initial order book connect failed, waiting for reconnect...", {
        error: String(err),
      });
    }

    // Wait for order book to be connected with data (up to 15s)
    const obConnected = await this.orderBookFeed.waitForConnection(15_000);
    if (obConnected) {
      log.info("Order book ready");
    } else {
      log.warn("Order book not available — OBI signals will be zero");
    }

    // --- Phase 5: Run strategy ---
    await this.runShadowStrategy(market, round, windowEndTime);

    // --- Phase 6: Disconnect and wait for window end ---
    this.orderBookFeed.disconnect();

    const remaining = windowEndTime - Date.now();
    if (remaining > 0) {
      log.info(`Waiting ${Math.round(remaining / 1000)}s for market to resolve...`);
      await sleep(remaining + 2000); // +2s buffer for resolution
    }
  }

  /**
   * Run the Oracle-OBI strategy in shadow mode against a live market.
   *
   * Continuously monitors BTC price vs PTB throughout the window, looking
   * for an entry opportunity. This mirrors how a real trader would watch
   * the market — the signal can fire at any point during the window,
   * not just at the start.
   */
  private async runShadowStrategy(market: Market, round: number, windowEndTime: number) {
    const ptb = market.priceTobeat;
    const cfg = STRATEGY_CONFIG;

    log.info("Monitoring market for entry opportunity...", {
      ptb: `$${ptb.toLocaleString()}`,
      btcPrice: `$${this.priceFeed.getPrice().toLocaleString()}`,
      endsIn: `${Math.round((windowEndTime - Date.now()) / 1000)}s`,
    });

    // --- Continuous monitoring phase ---
    // Watch for an entry signal throughout the window.
    // Stop looking when there's <60s left (need time for resolution).
    const minTimeToKeep = 60_000; // keep at least 60s for the trade to play out
    const checkIntervalMs = 1_000; // check every 1 second — speed matters vs CLOB repricing
    const priceSamples: number[] = [];

    let entrySignal: {
      price: number;
      deviation: number;
      direction: MarketSide;
      obi: number;
      momentum: number;
    } | null = null;

    let oracleFirstDetected = false;
    let lastLoggedDeviation = 0;

    while (Date.now() < windowEndTime - minTimeToKeep && !entrySignal && this.running) {
      const currentPrice = this.priceFeed.getPrice();
      priceSamples.push(currentPrice);

      const priceDeviation = (currentPrice - ptb) / ptb;
      const absDeviation = Math.abs(priceDeviation);
      const direction: MarketSide = priceDeviation > 0 ? "UP" : "DOWN";

      // Check oracle signal
      const oracleActive = absDeviation >= cfg.minPriceDeviationPct / 100;

      if (oracleActive) {
        // Oracle triggered! Check share pricing and momentum
        const hasDepth = this.orderBookFeed.hasDepthData;
        const obi = hasDepth ? this.calculateOBI(direction) : 0;
        const shareAsk = this.orderBookFeed.getBestAsk(direction);
        const shareBid = this.orderBookFeed.getBestBid(direction);

        // Only log on first detection or significant deviation change (>0.01%)
        const deviationChanged = Math.abs(absDeviation - lastLoggedDeviation) > 0.0001;
        if (!oracleFirstDetected || deviationChanged) {
          const label = !oracleFirstDetected ? "Oracle signal detected!" : "Oracle signal update";
          oracleFirstDetected = true;
          lastLoggedDeviation = absDeviation;
          log.info(label, {
            price: `$${currentPrice.toLocaleString()}`,
            deviation: `${(priceDeviation * 100).toFixed(4)}%`,
            direction,
            shareAsk,
            shareBid,
          });
        }

        // Check momentum (use last 5 samples if available)
        const recentSamples = priceSamples.slice(-5);
        const momentum = recentSamples.length >= 2
          ? recentSamples[recentSamples.length - 1] - recentSamples[0]
          : 0;
        const momentumConfirms =
          (direction === "UP" && momentum >= 0) ||
          (direction === "DOWN" && momentum <= 0);

        // Entry conditions (without full order book depth):
        // 1. Oracle signal is active (already checked above)
        // 2. Momentum confirms direction (or is neutral)
        // 3. Share price is within acceptable range
        // 4. If we have OBI depth data, it must confirm too
        const obiOk = !hasDepth || obi >= cfg.obiThreshold;
        const priceOk = shareAsk >= cfg.minSharePrice && shareAsk <= cfg.maxSharePrice;

        if (momentumConfirms && obiOk && priceOk) {
          entrySignal = {
            price: currentPrice,
            deviation: priceDeviation,
            direction,
            obi,
            momentum,
          };
          break;
        }
      } else {
        // Reset oracle detection state when signal drops below threshold
        if (oracleFirstDetected) {
          oracleFirstDetected = false;
          lastLoggedDeviation = 0;
        }
      }

      // Log periodic status every 30 seconds
      if (priceSamples.length % 30 === 0) {
        const timeLeft = Math.round((windowEndTime - Date.now()) / 1000);
        log.info("Monitoring...", {
          price: `$${currentPrice.toLocaleString()}`,
          deviation: `${(priceDeviation * 100).toFixed(4)}%`,
          timeLeft: `${timeLeft}s`,
        });
      }

      await sleep(checkIntervalMs);
    }

    // --- No entry signal found ---
    if (!entrySignal) {
      const lastPrice = this.priceFeed.getPrice();
      const lastDeviation = (lastPrice - ptb) / ptb;
      log.info("No entry signal during monitoring window", {
        finalDeviation: `${(lastDeviation * 100).toFixed(4)}%`,
        samplesCollected: priceSamples.length,
        maxDeviation: `${(Math.max(...priceSamples.map(p => Math.abs((p - ptb) / ptb))) * 100).toFixed(4)}%`,
      });
      this.recordSkip(market, round, lastPrice, lastDeviation, 0, 0, "no_signal_during_window");
      return;
    }

    // --- Entry signal found! ---
    const { price: signalPrice, deviation, direction: targetSide, obi, momentum } = entrySignal;
    const absDeviation = Math.abs(deviation);

    // Get the latest share price (may have updated since signal)
    const entryPrice = this.orderBookFeed.getBestAsk(targetSide);

    // Double-check price is still acceptable
    if (entryPrice > cfg.maxSharePrice || entryPrice < cfg.minSharePrice) {
      this.recordSkip(market, round, signalPrice, deviation, obi, momentum, `price_moved_${entryPrice}`);
      return;
    }
    const shares = Math.floor((1000 * cfg.riskPerRound) / entryPrice);
    const timeRemaining = windowEndTime - Date.now();
    const confidence = this.calculateConfidence(absDeviation, obi, momentum !== 0);

    log.info(`VIRTUAL ENTRY: ${shares}x ${targetSide} @ ${entryPrice}`, {
      confidence,
      spend: `$${(shares * entryPrice).toFixed(2)}`,
      timeRemaining: `${Math.round(timeRemaining / 1000)}s`,
    });

    // --- Wait for market resolution ---
    // Two stop-loss mechanisms:
    // 1. REVERSAL: BTC sustains a move past PTB in the wrong direction
    //    (0.03%+ counter-deviation for 3 seconds)
    // 2. EVAPORATION: Oracle signal fades — deviation in our direction drops below 0.02%
    //    for 20 consecutive checks (10 seconds). This prevents the slow drift-back scenario
    //    where BTC gradually returns to PTB without ever crossing hard enough to trigger #1,
    //    but still loses at expiry.
    let stopLossWouldTrigger = false;
    let stopLossReason = "";
    const stopLossPrice = Math.round(Math.max(0.01, entryPrice - cfg.maxLossPerShare) * 100) / 100;

    // Reversal params
    const stopLossConsecutiveChecks = 6;        // 6 × 500ms = 3 seconds sustained
    const stopLossMinCounterDevPct = 0.0003;    // 0.03% counter-deviation required
    let consecutiveWeakChecks = 0;

    // Evaporation params — intentionally lenient to avoid false exits during
    // normal BTC micro-consolidation. Only fires when signal is truly dead.
    const evaporationThreshold = 0.0002;        // signal below 0.02% = evaporated
    const evaporationConsecutiveChecks = 90;     // 90 × 500ms = 45 seconds sustained
    let consecutiveEvaporationChecks = 0;

    const monitorInterval = setInterval(() => {
      if (stopLossWouldTrigger) return;
      const btc = this.priceFeed.getPrice();
      const dev = (btc - ptb) / ptb;
      const weakening =
        (targetSide === "UP" && dev < 0) ||
        (targetSide === "DOWN" && dev > 0);
      const counterDev = Math.abs(dev);

      // Check #1: Sustained reversal past PTB
      if (weakening && counterDev >= stopLossMinCounterDevPct) {
        consecutiveWeakChecks++;
        if (consecutiveWeakChecks >= stopLossConsecutiveChecks) {
          stopLossWouldTrigger = true;
          stopLossReason = "reversal";
          log.warn("Sustained signal reversal — stop-loss WOULD trigger", {
            btcPrice: `$${btc.toLocaleString()}`,
            deviation: `${(dev * 100).toFixed(4)}%`,
            sustainedChecks: consecutiveWeakChecks,
            stopPrice: stopLossPrice,
          });
        }
      } else {
        consecutiveWeakChecks = 0;
      }

      // Check #2: Signal evaporation — deviation in our direction has faded to near-zero
      const signalInOurDirection =
        (targetSide === "UP" && dev > 0) ||
        (targetSide === "DOWN" && dev < 0);
      const signalStrong = signalInOurDirection && counterDev >= evaporationThreshold;

      if (!signalStrong) {
        consecutiveEvaporationChecks++;
        if (consecutiveEvaporationChecks >= evaporationConsecutiveChecks) {
          stopLossWouldTrigger = true;
          stopLossReason = "evaporation";
          log.warn("Signal evaporated — stop-loss WOULD trigger", {
            btcPrice: `$${btc.toLocaleString()}`,
            deviation: `${(dev * 100).toFixed(4)}%`,
            sustainedChecks: consecutiveEvaporationChecks,
            stopPrice: stopLossPrice,
          });
        }
      } else {
        consecutiveEvaporationChecks = 0;
      }
    }, 500);

    // Wait for market to end
    const remaining = windowEndTime - Date.now();
    if (remaining > 0) {
      await sleep(remaining);
    }
    clearInterval(monitorInterval);

    // --- Compute virtual PnL ---
    const btcAtResolution = this.priceFeed.getPrice();
    const outcome: "UP" | "DOWN" = btcAtResolution >= ptb ? "UP" : "DOWN";
    const won = targetSide === outcome;

    let virtualPnl: number;
    let action: TradeJournalEntry["action"];
    let exitPrice: number;

    if (stopLossWouldTrigger) {
      exitPrice = stopLossPrice;
      virtualPnl = (exitPrice - entryPrice) * shares;
      action = "STOP_LOSS";
      log.info(`Virtual STOP-LOSS: exited @ ${exitPrice}`, {
        pnl: `${virtualPnl >= 0 ? "+" : ""}${virtualPnl.toFixed(4)} USDC`,
      });
    } else if (won) {
      const profitTarget = Math.round((entryPrice + cfg.profitTargetSpread) * 100) / 100;
      exitPrice = profitTarget;
      virtualPnl = (exitPrice - entryPrice) * shares;
      action = "SELL";
      log.info(`Virtual PROFIT TARGET: sold @ ${exitPrice}`, {
        pnl: `+${virtualPnl.toFixed(4)} USDC`,
      });
    } else {
      exitPrice = 0;
      virtualPnl = -entryPrice * shares;
      action = "HOLD_TO_EXPIRY";
      log.warn(`Virtual LOSS at expiry: ${targetSide} was wrong, outcome=${outcome}`, {
        pnl: `${virtualPnl.toFixed(4)} USDC`,
      });
    }

    // Update stats
    if (virtualPnl > 0) {
      this.stats.virtualWins++;
    } else {
      this.stats.virtualLosses++;
    }
    this.stats.tradesEntered++;
    this.stats.totalVirtualPnl += virtualPnl;

    // Log to journal
    this.journal.record({
      timestamp: new Date().toISOString(),
      round,
      marketId: market.id,
      priceTobeat: ptb,
      btcPriceAtSignal: signalPrice,
      oracleDeviation: deviation,
      obi,
      momentum,
      confidence,
      action,
      side: targetSide,
      entryPrice,
      exitPrice,
      shares,
      virtualPnl,
      outcome,
      skipReason: "",
      btcPriceAtResolution: btcAtResolution,
      timeRemainingAtEntry: timeRemaining,
    });

    log.info(`Market resolved: ${outcome}`, {
      btcAtOpen: `$${ptb.toLocaleString()}`,
      btcAtClose: `$${btcAtResolution.toLocaleString()}`,
      virtualPnl: `${virtualPnl >= 0 ? "+" : ""}${virtualPnl.toFixed(4)} USDC`,
      runningPnl: `${this.stats.totalVirtualPnl >= 0 ? "+" : ""}${this.stats.totalVirtualPnl.toFixed(4)} USDC`,
    });
  }

  private recordSkip(
    market: Market,
    round: number,
    btcPrice: number,
    deviation: number,
    obi: number,
    momentum: number,
    reason: string
  ) {
    this.stats.skipped++;

    this.journal.record({
      timestamp: new Date().toISOString(),
      round,
      marketId: market.id,
      priceTobeat: market.priceTobeat,
      btcPriceAtSignal: btcPrice,
      oracleDeviation: deviation,
      obi,
      momentum,
      confidence: "0%",
      action: "SKIP",
      side: "NONE",
      entryPrice: 0,
      exitPrice: 0,
      shares: 0,
      virtualPnl: 0,
      outcome: "PENDING",
      skipReason: reason,
      btcPriceAtResolution: 0,
      timeRemainingAtEntry: 0,
    });

    log.info(`Skipped: ${reason}`);
  }

  private calculateOBI(side: MarketSide): number {
    const book = this.orderBookFeed.getOrderBook(side);
    let totalBidVol = 0;
    let totalAskVol = 0;
    const depth = Math.min(STRATEGY_CONFIG.obiDepth, book.bids.length, book.asks.length);

    for (let i = 0; i < depth; i++) {
      const weight = depth - i;
      totalBidVol += (book.bids[i]?.size ?? 0) * weight;
      totalAskVol += (book.asks[i]?.size ?? 0) * weight;
    }

    const total = totalBidVol + totalAskVol;
    return total === 0 ? 0 : (totalBidVol - totalAskVol) / total;
  }

  private calculateConfidence(
    absDeviation: number,
    obi: number,
    momentumConfirms: boolean
  ): string {
    let score = 0;
    score += Math.min(0.4, absDeviation * 200);
    score += Math.min(0.35, obi * 0.35);
    if (momentumConfirms) score += 0.25;
    return `${(score * 100).toFixed(0)}%`;
  }

  private printSummary() {
    const s = this.stats;
    const winRate = s.tradesEntered > 0
      ? ((s.virtualWins / s.tradesEntered) * 100).toFixed(1)
      : "0.0";

    console.log("\n" + "=".repeat(50));
    console.log("  SHADOW MODE SUMMARY");
    console.log("=".repeat(50));
    console.log(`  Rounds watched:  ${s.totalRounds}`);
    console.log(`  Trades entered:  ${s.tradesEntered}`);
    console.log(`  Skipped:         ${s.skipped}`);
    console.log(`  Virtual wins:    ${s.virtualWins}`);
    console.log(`  Virtual losses:  ${s.virtualLosses}`);
    console.log(`  Win rate:        ${winRate}%`);
    console.log(`  Virtual PnL:     ${s.totalVirtualPnl >= 0 ? "+" : ""}${s.totalVirtualPnl.toFixed(4)} USDC`);
    console.log(`  Journal file:    ${this.journal.getFilePath()}`);
    console.log("=".repeat(50) + "\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
