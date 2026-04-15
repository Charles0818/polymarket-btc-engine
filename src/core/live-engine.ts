/**
 * Live Trading Engine
 *
 * Runs the Oracle-OBI strategy against real Polymarket 5-minute BTC markets,
 * placing actual orders via the CLOB API. Based on the shadow engine with
 * real order placement replacing virtual trade logging.
 *
 * CAUTION: This engine places REAL orders with REAL money.
 */

import type { Market, MarketSide } from "../types/index.js";
import type { EngineConfig } from "../config.js";
import { LivePriceFeed } from "../feeds/btc-price.js";
import {
  PolymarketGammaClient,
  getNextBtcMarket,
} from "../market/polymarket-api.js";
import { PolymarketOrderBookFeed } from "../market/polymarket-ws.js";
import {
  PolymarketClobClient,
  loadClobConfig,
  type PlaceOrderResult,
} from "../market/polymarket-clob.js";
import {
  TradeJournal,
  type TradeJournalEntry,
} from "../logging/trade-journal.js";
import { createLogger, setGlobalLogLevel } from "../logging/logger.js";

const log = createLogger("Live");

/** 5-minute window in milliseconds */
const WINDOW_MS = 5 * 60 * 1000;

/** Max time we'll wait for a market to start (6 minutes) */
const MAX_WAIT_MS = 6 * 60 * 1000;

/**
 * Strategy config — mirrors the shadow engine exactly so live results
 * are directly comparable to shadow validation runs.
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

interface LiveStats {
  totalRounds: number;
  tradesEntered: number;
  wins: number;
  losses: number;
  skipped: number;
  totalPnl: number;
  totalUsdcSpent: number;
}

/**
 * Live Engine — watches real Polymarket 5-minute BTC markets, runs the
 * Oracle-OBI strategy, and places REAL orders via the CLOB API.
 */
export class LiveEngine {
  private config: EngineConfig;
  private priceFeed: LivePriceFeed;
  private gammaClient: PolymarketGammaClient;
  private orderBookFeed: PolymarketOrderBookFeed;
  private clobClient: PolymarketClobClient;
  private journal: TradeJournal;
  private running = false;
  private killSwitch = false;
  private stats: LiveStats = {
    totalRounds: 0,
    tradesEntered: 0,
    wins: 0,
    losses: 0,
    skipped: 0,
    totalPnl: 0,
    totalUsdcSpent: 0,
  };

  constructor(config: EngineConfig) {
    this.config = config;
    setGlobalLogLevel(config.logLevel);
    this.priceFeed = new LivePriceFeed();
    this.gammaClient = new PolymarketGammaClient();
    this.orderBookFeed = new PolymarketOrderBookFeed();
    this.journal = new TradeJournal("./logs");

    // Load CLOB config from env
    const clobConfig = loadClobConfig();
    this.clobClient = new PolymarketClobClient(clobConfig);

    // Check kill switch
    if (process.env.KILL_SWITCH === "true") {
      this.killSwitch = true;
    }
  }

  async start(): Promise<void> {
    this.running = true;

    console.log("\n" + "=".repeat(50));
    console.log("  *** LIVE MODE — Polymarket BTC Engine ***");
    console.log("  REAL ORDERS WILL BE PLACED");
    console.log("=".repeat(50));
    console.log(`  Rounds:     ${this.config.rounds}`);
    console.log(`  Strategy:   oracle-obi-hybrid (live)`);
    console.log(`  Journal:    ${this.journal.getFilePath()}`);
    console.log("=".repeat(50) + "\n");

    // --- Kill switch check ---
    if (this.killSwitch) {
      log.error("KILL SWITCH is active. Set KILL_SWITCH=false in .env to trade.");
      return;
    }

    // --- Step 1: Initialize CLOB client (wallet + API creds) ---
    log.info("Initializing CLOB client...");
    try {
      await this.clobClient.initialize();
    } catch (err) {
      log.error("Failed to initialize CLOB client", { error: String(err) });
      log.info("Check your PRIVATE_KEY and network connection.");
      return;
    }

    // Check for closed-only mode (account banned)
    const closedOnly = await this.clobClient.isClosedOnly();
    if (closedOnly) {
      log.error("Account is in CLOSED-ONLY mode. Cannot place new orders.");
      return;
    }

    // Check USDC balance
    const balInfo = await this.clobClient.getUsdcBalance();
    log.info("Account status", {
      address: this.clobClient.address,
      usdcBalance: `$${balInfo.usdcBalance.toFixed(2)}`,
      usdcAllowance: `$${balInfo.usdcAllowance.toFixed(2)}`,
    });

    if (balInfo.usdcBalance < 1) {
      log.error("Insufficient USDC balance. Need at least $1 to trade.");
      return;
    }

    const riskLimits = this.clobClient.riskLimits;
    log.info("Risk limits", {
      maxPerRound: `$${riskLimits.maxRiskPerRound.toFixed(2)}`,
      maxTotalExposure: `$${riskLimits.maxTotalExposure.toFixed(2)}`,
    });

    // --- Step 2: Connect to live BTC price feed ---
    log.info("Connecting to live BTC price feed...");
    try {
      await this.priceFeed.start();
    } catch (err) {
      log.error("Failed to connect to price feed", { error: String(err) });
      return;
    }

    await sleep(2000);
    const initialPrice = this.priceFeed.getPrice();
    if (initialPrice === 0) {
      log.error("No BTC price received after 2s.");
      this.priceFeed.stop();
      return;
    }
    log.info(`Live BTC price: $${initialPrice.toLocaleString()}`);

    // --- Step 3: Cancel any stale open orders ---
    log.info("Cancelling any stale open orders...");
    await this.clobClient.cancelAllOrders();

    // --- Step 4: Run the live loop ---
    for (let round = 1; round <= this.config.rounds; round++) {
      if (!this.running) break;

      // Re-check kill switch each round
      if (process.env.KILL_SWITCH === "true") {
        log.error("KILL SWITCH activated. Stopping.");
        await this.clobClient.cancelAllOrders();
        break;
      }

      // Check exposure limit
      if (this.stats.totalUsdcSpent >= riskLimits.maxTotalExposure) {
        log.error("Max total exposure reached. Stopping.", {
          spent: `$${this.stats.totalUsdcSpent.toFixed(2)}`,
          limit: `$${riskLimits.maxTotalExposure.toFixed(2)}`,
        });
        break;
      }

      log.info(`\n--- Live Round ${round}/${this.config.rounds} ---`);

      try {
        await this.runRound(round);
      } catch (err) {
        log.error("Round failed", { round, error: String(err) });
        // Cancel any orders from this round
        await this.clobClient.cancelAllOrders();
      }

      this.stats.totalRounds++;
    }

    // Cleanup
    await this.clobClient.cancelAllOrders();
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
    // Best-effort cancel all
    this.clobClient.cancelAllOrders().catch(() => {});
    log.info("Live engine stopped");
  }

  // =========================================================================
  // Round lifecycle
  // =========================================================================

  private async runRound(round: number): Promise<void> {
    // --- Phase 1: Wait for the next window boundary ---
    const now = Date.now();
    const currentWindowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
    const nextWindowStart = currentWindowStart + WINDOW_MS;
    const waitUntilStart = nextWindowStart - now;
    const timeIntoCurrentWindow = now - currentWindowStart;
    let targetWindowStart: number;

    if (timeIntoCurrentWindow < 30_000) {
      targetWindowStart = currentWindowStart;
      log.info("Using current window (within first 30s)", {
        windowStart: new Date(targetWindowStart).toISOString(),
        timeInto: `${Math.round(timeIntoCurrentWindow / 1000)}s`,
      });
    } else {
      targetWindowStart = nextWindowStart;
      log.info(
        `Waiting ${Math.round(waitUntilStart / 1000)}s for next window...`,
        { nextWindow: new Date(targetWindowStart).toISOString() },
      );

      if (waitUntilStart > MAX_WAIT_MS) {
        log.error("Wait time exceeds maximum, skipping");
        return;
      }

      const sleepTime = Math.max(0, waitUntilStart - 1000);
      await sleep(sleepTime);

      while (Date.now() < targetWindowStart && this.running) {
        await sleep(50);
      }
    }

    if (!this.running) return;

    // --- Phase 2: Capture PTB ---
    const ptb = this.priceFeed.getPrice();
    const windowEndTime = targetWindowStart + WINDOW_MS;

    log.info("Window opened — captured PTB", {
      ptb: `$${ptb.toLocaleString()}`,
      windowEnd: new Date(windowEndTime).toISOString(),
    });

    // --- Phase 3: Discover market ---
    this.gammaClient.setLiveBtcPrice(ptb);
    let market: Market | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      market = await getNextBtcMarket(this.gammaClient);
      if (market) break;
      if (attempt < 5) {
        log.debug(
          `Market not found (attempt ${attempt}/5), retrying in 3s...`,
        );
        await sleep(3000);
      }
    }

    if (!market) {
      log.warn("No market found for this window after 5 attempts");
      this.recordSkip(
        {
          id: "unknown",
          priceTobeat: ptb,
          startTime: targetWindowStart,
          endTime: windowEndTime,
          tokens: { up: "", down: "" },
          status: "active",
        },
        round,
        ptb,
        0,
        0,
        0,
        "no_market_found",
      );
      const remaining = windowEndTime - Date.now();
      if (remaining > 0) await sleep(remaining);
      return;
    }

    market.priceTobeat = ptb;

    // --- Phase 4: Connect to order book ---
    try {
      await this.orderBookFeed.connect(market.tokens);
    } catch (err) {
      log.debug("Initial order book connect failed", {
        error: String(err),
      });
    }

    const obConnected = await this.orderBookFeed.waitForConnection(15_000);
    if (obConnected) {
      log.info("Order book ready");
    } else {
      log.warn("Order book not available — OBI signals will be zero");
    }

    // --- Phase 5: Run strategy ---
    await this.runLiveStrategy(market, round, windowEndTime);

    // --- Phase 6: Disconnect ---
    this.orderBookFeed.disconnect();

    const remaining = windowEndTime - Date.now();
    if (remaining > 0) {
      log.info(
        `Waiting ${Math.round(remaining / 1000)}s for market to resolve...`,
      );
      await sleep(remaining + 2000);
    }
  }

  // =========================================================================
  // Strategy execution (with real orders)
  // =========================================================================

  private async runLiveStrategy(
    market: Market,
    round: number,
    windowEndTime: number,
  ) {
    const ptb = market.priceTobeat;
    const cfg = STRATEGY_CONFIG;

    log.info("Monitoring market for entry opportunity...", {
      ptb: `$${ptb.toLocaleString()}`,
      btcPrice: `$${this.priceFeed.getPrice().toLocaleString()}`,
      endsIn: `${Math.round((windowEndTime - Date.now()) / 1000)}s`,
    });

    // --- Continuous monitoring phase (identical to shadow) ---
    const minTimeToKeep = 60_000;
    const checkIntervalMs = 1_000;
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

    while (
      Date.now() < windowEndTime - minTimeToKeep &&
      !entrySignal &&
      this.running
    ) {
      const currentPrice = this.priceFeed.getPrice();
      priceSamples.push(currentPrice);

      const priceDeviation = (currentPrice - ptb) / ptb;
      const absDeviation = Math.abs(priceDeviation);
      const direction: MarketSide = priceDeviation > 0 ? "UP" : "DOWN";

      const oracleActive = absDeviation >= cfg.minPriceDeviationPct / 100;

      if (oracleActive) {
        const hasDepth = this.orderBookFeed.hasDepthData;
        const obi = hasDepth ? this.calculateOBI(direction) : 0;
        const shareAsk = this.orderBookFeed.getBestAsk(direction);
        const shareBid = this.orderBookFeed.getBestBid(direction);

        const deviationChanged =
          Math.abs(absDeviation - lastLoggedDeviation) > 0.0001;
        if (!oracleFirstDetected || deviationChanged) {
          const label = !oracleFirstDetected
            ? "Oracle signal detected!"
            : "Oracle signal update";
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

        const recentSamples = priceSamples.slice(-5);
        const momentum =
          recentSamples.length >= 2
            ? recentSamples[recentSamples.length - 1] - recentSamples[0]
            : 0;
        const momentumConfirms =
          (direction === "UP" && momentum >= 0) ||
          (direction === "DOWN" && momentum <= 0);

        const obiOk = !hasDepth || obi >= cfg.obiThreshold;
        const priceOk =
          shareAsk >= cfg.minSharePrice && shareAsk <= cfg.maxSharePrice;

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
        if (oracleFirstDetected) {
          oracleFirstDetected = false;
          lastLoggedDeviation = 0;
        }
      }

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

    // --- No entry signal ---
    if (!entrySignal) {
      const lastPrice = this.priceFeed.getPrice();
      const lastDeviation = (lastPrice - ptb) / ptb;
      log.info("No entry signal during monitoring window", {
        finalDeviation: `${(lastDeviation * 100).toFixed(4)}%`,
        samplesCollected: priceSamples.length,
        maxDeviation: `${(Math.max(...priceSamples.map((p) => Math.abs((p - ptb) / ptb))) * 100).toFixed(4)}%`,
      });
      this.recordSkip(
        market,
        round,
        lastPrice,
        lastDeviation,
        0,
        0,
        "no_signal_during_window",
      );
      return;
    }

    // --- Entry signal found — place REAL order ---
    const {
      price: signalPrice,
      deviation,
      direction: targetSide,
      obi,
      momentum,
    } = entrySignal;
    const absDeviation = Math.abs(deviation);

    const entryPrice = this.orderBookFeed.getBestAsk(targetSide);

    if (entryPrice > cfg.maxSharePrice || entryPrice < cfg.minSharePrice) {
      this.recordSkip(
        market,
        round,
        signalPrice,
        deviation,
        obi,
        momentum,
        `price_moved_${entryPrice}`,
      );
      return;
    }

    // Calculate position size (respecting risk limits)
    const riskLimits = this.clobClient.riskLimits;
    const maxSpend = Math.min(
      1000 * cfg.riskPerRound,
      riskLimits.maxRiskPerRound,
    );
    const shares = Math.floor(maxSpend / entryPrice);

    if (shares < 1) {
      this.recordSkip(
        market,
        round,
        signalPrice,
        deviation,
        obi,
        momentum,
        "position_too_small",
      );
      return;
    }

    const usdcCost = shares * entryPrice;
    const timeRemaining = windowEndTime - Date.now();
    const confidence = this.calculateConfidence(
      absDeviation,
      obi,
      momentum !== 0,
    );

    // Select the right token ID
    const tokenId =
      targetSide === "UP" ? market.tokens.up : market.tokens.down;

    if (!tokenId) {
      this.recordSkip(
        market,
        round,
        signalPrice,
        deviation,
        obi,
        momentum,
        `no_token_id_for_${targetSide}`,
      );
      return;
    }

    log.info(`PLACING ORDER: BUY ${shares}x ${targetSide} @ ${entryPrice}`, {
      confidence,
      spend: `$${usdcCost.toFixed(2)}`,
      tokenId: tokenId.slice(0, 12) + "...",
      timeRemaining: `${Math.round(timeRemaining / 1000)}s`,
    });

    // --- Place the buy order ---
    const buyResult = await this.clobClient.buyShares(
      tokenId,
      entryPrice,
      shares,
    );

    if (!buyResult.success) {
      log.error("BUY order failed — skipping round", {
        error: buyResult.errorMsg,
      });
      this.recordSkip(
        market,
        round,
        signalPrice,
        deviation,
        obi,
        momentum,
        `order_failed: ${buyResult.errorMsg}`,
      );
      return;
    }

    log.info("BUY order accepted", {
      orderId: buyResult.orderId?.slice(0, 12),
    });

    this.stats.tradesEntered++;
    this.stats.totalUsdcSpent += usdcCost;

    // --- Monitor for stop-loss (same dual mechanism as shadow) ---
    let stopLossTriggered = false;
    let stopLossReason = "";
    const stopLossPrice =
      Math.round(Math.max(0.01, entryPrice - cfg.maxLossPerShare) * 100) /
      100;

    // Reversal params
    const stopLossConsecutiveChecks = 6;
    const stopLossMinCounterDevPct = 0.0003;
    let consecutiveWeakChecks = 0;

    // Evaporation params
    const evaporationThreshold = 0.0002;
    const evaporationConsecutiveChecks = 90;
    let consecutiveEvaporationChecks = 0;

    const monitorInterval = setInterval(() => {
      if (stopLossTriggered) return;
      const btc = this.priceFeed.getPrice();
      const dev = (btc - ptb) / ptb;
      const weakening =
        (targetSide === "UP" && dev < 0) ||
        (targetSide === "DOWN" && dev > 0);
      const counterDev = Math.abs(dev);

      // Check #1: Sustained reversal
      if (weakening && counterDev >= stopLossMinCounterDevPct) {
        consecutiveWeakChecks++;
        if (consecutiveWeakChecks >= stopLossConsecutiveChecks) {
          stopLossTriggered = true;
          stopLossReason = "reversal";
          log.warn("STOP-LOSS TRIGGERED — sustained reversal", {
            btcPrice: `$${btc.toLocaleString()}`,
            deviation: `${(dev * 100).toFixed(4)}%`,
            sustainedChecks: consecutiveWeakChecks,
          });
        }
      } else {
        consecutiveWeakChecks = 0;
      }

      // Check #2: Signal evaporation
      const signalInOurDirection =
        (targetSide === "UP" && dev > 0) ||
        (targetSide === "DOWN" && dev < 0);
      const signalStrong =
        signalInOurDirection && counterDev >= evaporationThreshold;

      if (!signalStrong) {
        consecutiveEvaporationChecks++;
        if (
          consecutiveEvaporationChecks >= evaporationConsecutiveChecks
        ) {
          stopLossTriggered = true;
          stopLossReason = "evaporation";
          log.warn("STOP-LOSS TRIGGERED — signal evaporated", {
            btcPrice: `$${btc.toLocaleString()}`,
            deviation: `${(dev * 100).toFixed(4)}%`,
            sustainedChecks: consecutiveEvaporationChecks,
          });
        }
      } else {
        consecutiveEvaporationChecks = 0;
      }
    }, 500);

    // --- If stop-loss fires, try to sell immediately ---
    const stopLossWatcher = new Promise<void>((resolve) => {
      const check = setInterval(async () => {
        if (stopLossTriggered) {
          clearInterval(check);
          log.info("Executing stop-loss sell...", {
            reason: stopLossReason,
            price: stopLossPrice,
          });
          await this.clobClient.sellShares(
            tokenId,
            stopLossPrice,
            shares,
          );
          resolve();
        }
      }, 250);

      // Also resolve when window ends
      const timeout = setTimeout(() => {
        clearInterval(check);
        resolve();
      }, Math.max(0, windowEndTime - Date.now()));

      // Cleanup timeout if check fires first
      check[Symbol.dispose] = () => clearTimeout(timeout);
    });

    // Wait for either stop-loss exit or window end
    await stopLossWatcher;
    clearInterval(monitorInterval);

    // --- If no stop-loss, try profit-target sell ---
    if (!stopLossTriggered) {
      const profitTarget =
        Math.round((entryPrice + cfg.profitTargetSpread) * 100) / 100;

      // Check outcome — is the price still in our favor?
      const btcAtEnd = this.priceFeed.getPrice();
      const outcome: "UP" | "DOWN" = btcAtEnd >= ptb ? "UP" : "DOWN";
      const won = targetSide === outcome;

      if (won) {
        // Try to sell at profit target (may not fill if market is thin)
        log.info("Market resolving in our favor — placing profit sell", {
          profitTarget,
        });
        await this.clobClient.sellShares(tokenId, profitTarget, shares);
      } else {
        // Lost at expiry — shares resolve to 0
        log.warn(
          `LOSS at expiry: ${targetSide} was wrong, outcome=${outcome}`,
        );
      }
    }

    // Wait a bit for any sell orders to fill
    await sleep(3000);

    // Cancel any remaining open orders from this round
    await this.clobClient.cancelAllOrders();

    // --- Compute PnL ---
    const btcAtResolution = this.priceFeed.getPrice();
    const finalOutcome: "UP" | "DOWN" =
      btcAtResolution >= ptb ? "UP" : "DOWN";
    const won = targetSide === finalOutcome;

    let pnl: number;
    let action: TradeJournalEntry["action"];
    let exitPrice: number;

    if (stopLossTriggered) {
      exitPrice = stopLossPrice;
      pnl = (exitPrice - entryPrice) * shares;
      action = "STOP_LOSS";
    } else if (won) {
      const profitTarget =
        Math.round((entryPrice + cfg.profitTargetSpread) * 100) / 100;
      exitPrice = profitTarget;
      pnl = (exitPrice - entryPrice) * shares;
      action = "SELL";
    } else {
      exitPrice = 0;
      pnl = -entryPrice * shares;
      action = "HOLD_TO_EXPIRY";
    }

    if (pnl > 0) {
      this.stats.wins++;
      log.info(`WIN: ${action} @ ${exitPrice}`, {
        pnl: `+${pnl.toFixed(4)} USDC`,
      });
    } else {
      this.stats.losses++;
      log.warn(`LOSS: ${action} @ ${exitPrice}`, {
        pnl: `${pnl.toFixed(4)} USDC`,
      });
    }

    this.stats.totalPnl += pnl;

    // Journal
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
      virtualPnl: pnl,
      outcome: finalOutcome,
      skipReason: "",
      btcPriceAtResolution: btcAtResolution,
      timeRemainingAtEntry: timeRemaining,
    });

    log.info(`Round ${round} resolved: ${finalOutcome}`, {
      btcAtOpen: `$${ptb.toLocaleString()}`,
      btcAtClose: `$${btcAtResolution.toLocaleString()}`,
      pnl: `${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} USDC`,
      runningPnl: `${this.stats.totalPnl >= 0 ? "+" : ""}${this.stats.totalPnl.toFixed(4)} USDC`,
    });
  }

  // =========================================================================
  // Helpers (same as shadow engine)
  // =========================================================================

  private recordSkip(
    market: Market,
    round: number,
    btcPrice: number,
    deviation: number,
    obi: number,
    momentum: number,
    reason: string,
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
    const depth = Math.min(
      STRATEGY_CONFIG.obiDepth,
      book.bids.length,
      book.asks.length,
    );

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
    momentumConfirms: boolean,
  ): string {
    let score = 0;
    score += Math.min(0.4, absDeviation * 200);
    score += Math.min(0.35, obi * 0.35);
    if (momentumConfirms) score += 0.25;
    return `${(score * 100).toFixed(0)}%`;
  }

  private printSummary() {
    const s = this.stats;
    const winRate =
      s.tradesEntered > 0
        ? ((s.wins / s.tradesEntered) * 100).toFixed(1)
        : "0.0";

    console.log("\n" + "=".repeat(50));
    console.log("  *** LIVE MODE SUMMARY ***");
    console.log("=".repeat(50));
    console.log(`  Rounds:       ${s.totalRounds}`);
    console.log(`  Trades:       ${s.tradesEntered}`);
    console.log(`  Skipped:      ${s.skipped}`);
    console.log(`  Wins:         ${s.wins}`);
    console.log(`  Losses:       ${s.losses}`);
    console.log(`  Win rate:     ${winRate}%`);
    console.log(
      `  Total PnL:    ${s.totalPnl >= 0 ? "+" : ""}${s.totalPnl.toFixed(4)} USDC`,
    );
    console.log(`  USDC spent:   $${s.totalUsdcSpent.toFixed(2)}`);
    console.log(`  Journal:      ${this.journal.getFilePath()}`);
    console.log("=".repeat(50) + "\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
