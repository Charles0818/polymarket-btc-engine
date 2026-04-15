import type {
  Market,
  MarketSide,
  Order,
  OrderBook,
  Position,
  RoundPnl,
} from "../types/index.js";
import type {
  StrategyContext,
  StrategyFn,
  CleanupFn,
  PlaceOrderOpts,
  OnFillCallback,
  OnCancelCallback,
} from "../types/strategy.js";
import type { SimulatedExchange } from "../simulation/sim-exchange.js";
import type { SimulatedOrderBook } from "../simulation/sim-order-book.js";
import type { PriceFeed } from "../feeds/btc-price.js";
import { createLogger, type Logger } from "../logging/logger.js";

export type LifecycleState = "INIT" | "RUNNING" | "STOPPING" | "DONE";

export interface MarketLifecycleResult {
  market: Market;
  pnl: RoundPnl | null;
  state: LifecycleState;
}

/**
 * Manages the lifecycle of a single market round.
 * INIT → RUNNING → STOPPING → DONE
 *
 * During RUNNING, the strategy executes and can place/cancel orders.
 * STOPPING begins when the market window nears its end.
 * DONE means the market has resolved and PnL is calculated.
 */
export class MarketLifecycle {
  private state: LifecycleState = "INIT";
  private market: Market;
  private exchange: SimulatedExchange;
  private orderBook: SimulatedOrderBook;
  private priceFeed: PriceFeed;
  private strategyFn: StrategyFn;
  private cleanup: CleanupFn | null = null;
  private held = false;
  private log: Logger;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    market: Market,
    exchange: SimulatedExchange,
    orderBook: SimulatedOrderBook,
    priceFeed: PriceFeed,
    strategyFn: StrategyFn
  ) {
    this.market = market;
    this.exchange = exchange;
    this.orderBook = orderBook;
    this.priceFeed = priceFeed;
    this.strategyFn = strategyFn;
    this.log = createLogger(`Market:${market.id.slice(-6)}`);
  }

  getState(): LifecycleState {
    return this.state;
  }

  /**
   * Run the full market lifecycle. Returns when the market is DONE.
   */
  async run(): Promise<MarketLifecycleResult> {
    // INIT
    this.state = "INIT";
    this.log.info("Market lifecycle starting", {
      ptb: this.market.priceTobeat,
      duration: `${(this.market.endTime - this.market.startTime) / 1000}s`,
    });

    this.orderBook.start();

    // Build the strategy context
    const ctx = this.buildContext();

    // RUNNING — execute the strategy
    this.state = "RUNNING";
    this.log.info("Strategy executing...");

    try {
      const result = await this.strategyFn(ctx);
      if (typeof result === "function") {
        this.cleanup = result;
      }
    } catch (err) {
      this.log.error("Strategy threw an error", {
        error: String(err),
      });
    }

    // Wait for the market window to end
    await this.waitForMarketEnd();

    // STOPPING — cancel remaining orders, sell if needed
    this.state = "STOPPING";
    this.log.info("Market ending, cleaning up...");

    if (this.cleanup) {
      try {
        await this.cleanup();
      } catch {
        // cleanup errors are non-fatal
      }
    }

    await this.exchange.cancelAllOrders();
    this.orderBook.stop();

    // DONE — resolve the market and compute PnL
    this.state = "DONE";

    const outcome = this.resolveOutcome();
    this.market.outcome = outcome;
    this.market.status = "resolved";
    this.exchange.resolveMarket(outcome);

    const pnl = this.computePnl(outcome);
    this.log.info(`Market resolved: ${outcome}`, {
      pnl: pnl?.pnl ?? 0,
    });

    return { market: this.market, pnl, state: this.state };
  }

  private buildContext(): StrategyContext {
    const self = this;

    return {
      market: this.market,

      async placeOrder(opts: PlaceOrderOpts): Promise<Order> {
        return self.exchange.placeOrder(opts);
      },

      async cancelOrder(orderId: string): Promise<void> {
        return self.exchange.cancelOrder(orderId);
      },

      async cancelAllOrders(): Promise<void> {
        return self.exchange.cancelAllOrders();
      },

      getPosition(): Position | null {
        return self.exchange.getPosition();
      },

      getActiveOrders(): Order[] {
        return self.exchange.getActiveOrders();
      },

      getOrderBook(side: MarketSide): OrderBook {
        return self.orderBook.getOrderBook(side);
      },

      getBtcPrice(): number {
        return self.priceFeed.getPrice();
      },

      hold(): void {
        self.held = true;
      },

      release(): void {
        self.held = false;
      },

      async emergencySell(): Promise<void> {
        const pos = self.exchange.getPosition();
        if (pos && pos.shares > 0) {
          await self.exchange.emergencySell(pos.side);
        }
      },

      blockBuys(): void {
        self.exchange.blockBuys();
      },

      blockSells(): void {
        self.exchange.blockSells();
      },

      onFill(callback: OnFillCallback): void {
        self.exchange.onFill(callback);
      },

      onCancel(callback: OnCancelCallback): void {
        self.exchange.onCancel(callback);
      },

      timeRemaining(): number {
        return Math.max(0, self.market.endTime - Date.now());
      },

      log: {
        info: (msg, data) => self.log.info(msg, data),
        warn: (msg, data) => self.log.warn(msg, data),
        error: (msg, data) => self.log.error(msg, data),
        debug: (msg, data) => self.log.debug(msg, data),
      },
    };
  }

  private waitForMarketEnd(): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        const remaining = this.market.endTime - Date.now();

        if (remaining <= 0 && !this.held) {
          if (this.tickInterval) {
            clearInterval(this.tickInterval);
            this.tickInterval = null;
          }
          resolve();
          return;
        }
      };

      // Check every 100ms
      this.tickInterval = setInterval(check, 100);
      check(); // immediate first check
    });
  }

  private resolveOutcome(): "UP" | "DOWN" {
    const finalPrice = this.priceFeed.getPrice();
    return finalPrice >= this.market.priceTobeat ? "UP" : "DOWN";
  }

  private computePnl(outcome: "UP" | "DOWN"): RoundPnl | null {
    // Check both sides for position data
    for (const side of ["UP", "DOWN"] as MarketSide[]) {
      const pos = this.exchange.getPosition(side);
      if (pos && (pos.shares > 0 || pos.realizedPnl !== 0)) {
        const isWinner = side === outcome;
        const unrealizedPnl = pos.shares > 0
          ? (isWinner ? 1.0 : 0) * pos.shares - pos.avgEntryPrice * pos.shares
          : 0;
        const totalPnl = pos.realizedPnl + unrealizedPnl;

        return {
          marketId: this.market.id,
          side,
          entryPrice: pos.avgEntryPrice,
          exitPrice: pos.shares > 0 ? (isWinner ? 1.0 : 0) : null,
          shares: pos.shares,
          pnl: Math.round(totalPnl * 10000) / 10000,
          outcome: totalPnl > 0.001 ? "win" : totalPnl < -0.001 ? "loss" : "scratch",
          resolvedBy: pos.shares > 0 ? "expiry" : "sell",
        };
      }
    }
    return null;
  }
}
