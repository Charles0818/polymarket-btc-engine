import { createLogger } from "../logging/logger.js";

const log = createLogger("PriceFeed");

export interface PriceFeed {
  /** Get the latest BTC price */
  getPrice(): number;
  /** Start the price feed */
  start(): Promise<void>;
  /** Stop the price feed */
  stop(): void;
  /** Register a callback for price updates */
  onUpdate(callback: (price: number) => void): void;
}

/**
 * Simulated BTC price feed that generates realistic price movements
 * using geometric Brownian motion around a base price.
 */
export class SimulatedPriceFeed implements PriceFeed {
  private price: number;
  private callbacks: ((price: number) => void)[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private volatility: number;

  constructor(startPrice: number = 84000, volatility: number = 0.0008) {
    this.price = startPrice;
    this.volatility = volatility;
  }

  getPrice(): number {
    return this.price;
  }

  async start(): Promise<void> {
    log.info("Starting simulated BTC price feed", { price: this.price });

    // Update price every 500ms with small random movements
    this.interval = setInterval(() => {
      // Geometric Brownian motion step
      const drift = 0; // no directional bias
      const randomShock = (Math.random() - 0.5) * 2; // uniform [-1, 1]
      const change = this.price * (drift + this.volatility * randomShock);
      this.price = Math.round((this.price + change) * 100) / 100;

      for (const cb of this.callbacks) {
        cb(this.price);
      }
    }, 500);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    log.info("Stopped simulated price feed");
  }

  onUpdate(callback: (price: number) => void): void {
    this.callbacks.push(callback);
  }
}

/**
 * Multi-source live BTC price feed with automatic fallback.
 * Tries multiple WebSocket endpoints in order:
 *   1. Binance Global
 *   2. Binance US
 *   3. Coinbase
 *   4. Kraken
 *
 * Each source has its own message parser since the formats differ.
 * Includes auto-reconnect on disconnect.
 */

interface WsSource {
  name: string;
  url: string;
  /** Extract price from a parsed JSON message. Return 0 to skip. */
  parsePrice: (msg: Record<string, unknown>) => number;
  /** Optional subscription message to send after connecting */
  subscribe?: string;
}

const WS_SOURCES: WsSource[] = [
  {
    name: "Binance Global",
    url: "wss://stream.binance.com:9443/ws/btcusdt@aggTrade",
    parsePrice: (msg) => parseFloat(String(msg.p ?? "0")),
  },
  {
    name: "Binance US",
    url: "wss://stream.binance.us:9443/ws/btcusd@aggTrade",
    parsePrice: (msg) => parseFloat(String(msg.p ?? "0")),
  },
  {
    name: "Coinbase",
    url: "wss://ws-feed.exchange.coinbase.com",
    parsePrice: (msg) => {
      if (msg.type === "ticker" && msg.product_id === "BTC-USD") {
        return parseFloat(String(msg.price ?? "0"));
      }
      return 0;
    },
    subscribe: JSON.stringify({
      type: "subscribe",
      channels: [{ name: "ticker", product_ids: ["BTC-USD"] }],
    }),
  },
  {
    name: "Kraken",
    url: "wss://ws.kraken.com/v2",
    parsePrice: (msg) => {
      // Kraken v2 ticker format
      if (msg.channel === "ticker" && msg.data) {
        const data = msg.data as Record<string, unknown>[];
        if (Array.isArray(data) && data.length > 0) {
          return parseFloat(String(data[0].last ?? "0"));
        }
      }
      return 0;
    },
    subscribe: JSON.stringify({
      method: "subscribe",
      params: { channel: "ticker", symbol: ["BTC/USD"] },
    }),
  },
];

export class LivePriceFeed implements PriceFeed {
  private price: number = 0;
  private callbacks: ((price: number) => void)[] = [];
  private ws: import("ws").WebSocket | null = null;
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectedSource: WsSource | null = null;

  getPrice(): number {
    return this.price;
  }

  async start(): Promise<void> {
    this.shouldReconnect = true;
    await this.connectWithFallback();
  }

  /**
   * Try each WebSocket source in order until one connects.
   */
  private async connectWithFallback(): Promise<void> {
    for (const source of WS_SOURCES) {
      try {
        await this.connectToSource(source);
        this.connectedSource = source;
        return; // success
      } catch (err) {
        log.warn(`${source.name} failed, trying next...`, {
          error: String(err),
        });
      }
    }
    throw new Error(
      "All BTC price feed sources failed. Check your internet connection."
    );
  }

  private async connectToSource(source: WsSource): Promise<void> {
    const WebSocket = (await import("ws")).default;
    log.info(`Connecting to ${source.name}...`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { this.ws?.close(); } catch { /* ignore */ }
        reject(new Error(`${source.name} connection timeout (8s)`));
      }, 8_000);

      this.ws = new WebSocket(source.url);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        log.info(`Connected to ${source.name}`);

        // Send subscription message if needed
        if (source.subscribe) {
          this.ws!.send(source.subscribe);
        }

        resolve();
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          const price = source.parsePrice(msg);
          if (price > 0) {
            this.price = price;
            for (const cb of this.callbacks) {
              cb(this.price);
            }
          }
        } catch {
          // skip malformed messages
        }
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });

      this.ws.on("close", () => {
        log.warn(`${source.name} WebSocket closed`);
        if (this.shouldReconnect) {
          log.info("Reconnecting in 3 seconds...");
          this.reconnectTimer = setTimeout(() => {
            this.connectWithFallback().catch((err) =>
              log.error("All reconnect attempts failed", {
                error: String(err),
              })
            );
          }, 3000);
        }
      });
    });
  }

  stop(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    if (this.connectedSource) {
      log.info(`Disconnected from ${this.connectedSource.name}`);
    }
  }

  onUpdate(callback: (price: number) => void): void {
    this.callbacks.push(callback);
  }
}

/** @deprecated Use LivePriceFeed instead */
export const BinancePriceFeed = LivePriceFeed;
