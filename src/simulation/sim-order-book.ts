import type { OrderBook, OrderBookLevel, MarketSide, Market } from "../types/index.js";
import type { PriceFeed } from "../feeds/btc-price.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("SimOrderBook");

/**
 * Simulates a Polymarket-style order book for a binary market.
 * Generates realistic bid/ask levels based on the current BTC price
 * relative to the market's Price to Beat.
 */
export class SimulatedOrderBook {
  private market: Market;
  private priceFeed: PriceFeed;
  private upBook: OrderBook = { bids: [], asks: [], timestamp: 0 };
  private downBook: OrderBook = { bids: [], asks: [], timestamp: 0 };
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(market: Market, priceFeed: PriceFeed) {
    this.market = market;
    this.priceFeed = priceFeed;
  }

  start() {
    this.update();
    // Refresh the simulated book every 200ms
    this.interval = setInterval(() => this.update(), 200);
    log.debug("Started simulated order book");
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getOrderBook(side: MarketSide): OrderBook {
    return side === "UP" ? this.upBook : this.downBook;
  }

  /** Get the best bid price for a side (what you'd get if you sell now) */
  getBestBid(side: MarketSide): number {
    const book = this.getOrderBook(side);
    return book.bids[0]?.price ?? 0;
  }

  /** Get the best ask price for a side (what you'd pay to buy now) */
  getBestAsk(side: MarketSide): number {
    const book = this.getOrderBook(side);
    return book.asks[0]?.price ?? 1;
  }

  private update() {
    const btcPrice = this.priceFeed.getPrice();
    const ptb = this.market.priceTobeat;
    const timeLeft = this.market.endTime - Date.now();
    const totalTime = this.market.endTime - this.market.startTime;
    const timeRatio = Math.max(0, Math.min(1, timeLeft / totalTime));

    // Calculate implied probability of UP based on current price vs PTB
    // When BTC is above PTB, UP is more likely; when below, DOWN is more likely
    const priceDelta = (btcPrice - ptb) / ptb;

    // Scale the implied probability — bigger divergence = more certainty
    // The further into the window, the more decisive the price difference
    const certaintyMultiplier = 1 + (1 - timeRatio) * 3; // 1x at start, 4x at end
    const rawProb = 0.5 + priceDelta * 50 * certaintyMultiplier;
    const upProb = Math.max(0.02, Math.min(0.98, rawProb));
    const downProb = 1 - upProb;

    // Add noise to simulate real market microstructure
    const noise = () => (Math.random() - 0.5) * 0.02;
    const spreadBasis = 0.02 + Math.random() * 0.03; // 2-5% spread

    const now = Date.now();
    this.upBook = this.generateBook(upProb, spreadBasis, noise, now);
    this.downBook = this.generateBook(downProb, spreadBasis, noise, now);
  }

  private generateBook(
    fairPrice: number,
    spread: number,
    noise: () => number,
    timestamp: number
  ): OrderBook {
    const halfSpread = spread / 2;
    const bestBid = Math.max(0.01, Math.min(0.99, fairPrice - halfSpread + noise()));
    const bestAsk = Math.max(0.01, Math.min(0.99, fairPrice + halfSpread + noise()));

    // Generate 5 levels of depth on each side
    const bids: OrderBookLevel[] = [];
    const asks: OrderBookLevel[] = [];

    for (let i = 0; i < 5; i++) {
      const bidPrice = Math.round(Math.max(0.01, bestBid - i * 0.01) * 100) / 100;
      const askPrice = Math.round(Math.min(0.99, bestAsk + i * 0.01) * 100) / 100;
      const bidSize = Math.round((50 + Math.random() * 200) * 100) / 100;
      const askSize = Math.round((50 + Math.random() * 200) * 100) / 100;

      bids.push({ price: bidPrice, size: bidSize });
      asks.push({ price: askPrice, size: askSize });
    }

    return { bids, asks, timestamp };
  }
}
