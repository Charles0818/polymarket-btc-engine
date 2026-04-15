import type { OrderBook, OrderBookLevel, MarketSide } from "../types/index.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("PolymarketOB");

/**
 * CLOB API base URL.
 * No authentication required for read-only market data.
 */
const CLOB_API_BASE = "https://clob.polymarket.com";

/** How often to poll prices (ms) */
const POLL_INTERVAL_MS = 3_000;

/** Timeout per REST request (ms) */
const FETCH_TIMEOUT_MS = 8_000;

interface PriceResponse {
  price: string;
}

interface MidpointResponse {
  mid: string;
}

interface TokenPricing {
  /** Best price to buy shares (best ask) */
  buyPrice: number;
  /** Best price to sell shares (best bid) */
  sellPrice: number;
  /** Midpoint price */
  midPrice: number;
  /** Last update timestamp */
  timestamp: number;
}

/**
 * Market data feed using Polymarket's CLOB REST API.
 *
 * Uses the `/price` and `/midpoint` endpoints which are accessible
 * even when `/book` and WebSocket endpoints are blocked.
 *
 * Polls every few seconds to keep pricing current.
 */
export class PolymarketOrderBookFeed {
  private pricing: Map<string, TokenPricing> = new Map(); // keyed by token_id
  private tokenToSide: Map<string, MarketSide> = new Map();
  private tokens: string[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _connected = false;

  /**
   * Start polling price data for the given tokens.
   */
  async connect(tokens: { up: string; down: string }): Promise<void> {
    this.tokenToSide.set(tokens.up, "UP");
    this.tokenToSide.set(tokens.down, "DOWN");
    this.tokens = [tokens.up, tokens.down];
    this._connected = false;

    // Do an initial fetch
    await this.pollOnce();

    // Start periodic polling
    this.pollTimer = setInterval(() => {
      this.pollOnce().catch((err) =>
        log.debug("Poll error", { error: String(err) })
      );
    }, POLL_INTERVAL_MS);
  }

  /**
   * Fetch current pricing for all subscribed tokens.
   */
  private async pollOnce(): Promise<void> {
    const fetches = this.tokens.map(async (tokenId) => {
      const side = this.tokenToSide.get(tokenId) ?? "?";

      try {
        // Fetch buy price (best ask), sell price (best bid), and midpoint in parallel
        const [buyRes, sellRes, midRes] = await Promise.allSettled([
          fetch(`${CLOB_API_BASE}/price?token_id=${tokenId}&side=buy`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          }),
          fetch(`${CLOB_API_BASE}/price?token_id=${tokenId}&side=sell`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          }),
          fetch(`${CLOB_API_BASE}/midpoint?token_id=${tokenId}`, {
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          }),
        ]);

        let buyPrice = 0;
        let sellPrice = 0;
        let midPrice = 0;

        if (buyRes.status === "fulfilled" && buyRes.value.ok) {
          const data = (await buyRes.value.json()) as PriceResponse;
          buyPrice = parseFloat(data.price) || 0;
        }
        if (sellRes.status === "fulfilled" && sellRes.value.ok) {
          const data = (await sellRes.value.json()) as PriceResponse;
          sellPrice = parseFloat(data.price) || 0;
        }
        if (midRes.status === "fulfilled" && midRes.value.ok) {
          const data = (await midRes.value.json()) as MidpointResponse;
          midPrice = parseFloat(data.mid) || 0;
        }

        // Fallback midpoint from buy/sell
        if (midPrice === 0 && buyPrice > 0 && sellPrice > 0) {
          midPrice = (buyPrice + sellPrice) / 2;
        }

        if (buyPrice > 0 || sellPrice > 0) {
          this.pricing.set(tokenId, {
            buyPrice,
            sellPrice,
            midPrice,
            timestamp: Date.now(),
          });

          if (!this._connected) {
            this._connected = true;
            log.info("Market pricing received", {
              side,
              buyPrice,
              sellPrice,
              midPrice,
            });
          }
        }
      } catch (err) {
        log.debug("Price fetch failed", {
          side,
          error: String(err),
        });
      }
    });

    await Promise.allSettled(fetches);
  }

  /**
   * Get pricing for a given side.
   */
  private getPricing(side: MarketSide): TokenPricing | null {
    for (const [tokenId, s] of this.tokenToSide.entries()) {
      if (s === side) {
        return this.pricing.get(tokenId) ?? null;
      }
    }
    return null;
  }

  /**
   * Get the current order book for a given side.
   * Constructs a minimal order book from price data.
   */
  getOrderBook(side: MarketSide): OrderBook {
    const p = this.getPricing(side);
    if (!p) return { bids: [], asks: [], timestamp: 0 };

    const bids: OrderBookLevel[] = p.sellPrice > 0
      ? [{ price: p.sellPrice, size: 100 }] // estimated size
      : [];
    const asks: OrderBookLevel[] = p.buyPrice > 0
      ? [{ price: p.buyPrice, size: 100 }]
      : [];

    return { bids, asks, timestamp: p.timestamp };
  }

  /**
   * Get the best bid (sell price) for a side.
   */
  getBestBid(side: MarketSide): number {
    return this.getPricing(side)?.sellPrice ?? 0;
  }

  /**
   * Get the best ask (buy price) for a side.
   */
  getBestAsk(side: MarketSide): number {
    return this.getPricing(side)?.buyPrice ?? 1;
  }

  /**
   * Get the mid price for a side.
   */
  getMidPrice(side: MarketSide): number {
    return this.getPricing(side)?.midPrice ?? 0;
  }

  /**
   * Returns true if we've received pricing data.
   */
  get isConnected(): boolean {
    return this._connected;
  }

  /**
   * Returns true if we have any pricing data.
   */
  get hasData(): boolean {
    return this.pricing.size > 0;
  }

  /**
   * Whether we have full order book depth (we don't — only top-of-book prices).
   * This is used by the strategy to decide whether OBI is meaningful.
   */
  get hasDepthData(): boolean {
    return false; // /price endpoint only gives top-of-book, not depth
  }

  /**
   * Wait until we have pricing data, or until timeout.
   */
  async waitForConnection(timeoutMs: number = 15_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.hasData) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.hasData;
  }

  /**
   * Stop polling and clear data.
   */
  disconnect(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.pricing.clear();
    this.tokens = [];
    this.tokenToSide.clear();
    this._connected = false;
    log.info("Market data feed stopped");
  }
}
