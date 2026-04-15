import type {
  Market,
  MarketSide,
  Order,
  OrderBook,
  OrderType,
  Fill,
  Position,
} from "./market.js";

/** Options for placing an order */
export interface PlaceOrderOpts {
  side: MarketSide;
  action: "buy" | "sell";
  price: number;
  size: number;
  type?: OrderType;
  /** Epoch ms — for GTD orders */
  expireAt?: number;
}

/** Callback when an order is filled (partially or fully) */
export type OnFillCallback = (fill: Fill, order: Order) => void;

/** Callback when an order is cancelled or expires */
export type OnCancelCallback = (order: Order, reason: string) => void;

/**
 * The context object passed to every strategy.
 * This is the strategy's API for interacting with the engine.
 */
export interface StrategyContext {
  /** The current market being traded */
  market: Market;

  /** Place a buy or sell order. Returns the order object. */
  placeOrder(opts: PlaceOrderOpts): Promise<Order>;

  /** Cancel an active order */
  cancelOrder(orderId: string): Promise<void>;

  /** Cancel all active orders */
  cancelAllOrders(): Promise<void>;

  /** Get current position in this market */
  getPosition(): Position | null;

  /** Get all active (unfilled) orders */
  getActiveOrders(): Order[];

  /** Get the latest order book for a given side */
  getOrderBook(side: MarketSide): OrderBook;

  /** Get current BTC price from the price feed */
  getBtcPrice(): number;

  /**
   * Prevent the lifecycle from advancing to STOPPING.
   * Call this if your strategy needs more time (e.g. waiting for a fill).
   */
  hold(): void;

  /** Release the hold, allowing lifecycle to advance */
  release(): void;

  /** Emergency sell all positions at best bid */
  emergencySell(): Promise<void>;

  /** Block further buy orders for this market */
  blockBuys(): void;

  /** Block further sell orders for this market */
  blockSells(): void;

  /** Register a callback for when orders are filled */
  onFill(callback: OnFillCallback): void;

  /** Register a callback for when orders are cancelled/expired */
  onCancel(callback: OnCancelCallback): void;

  /** Milliseconds remaining in this market window */
  timeRemaining(): number;

  /** Structured logger scoped to this market */
  log: {
    info(msg: string, data?: Record<string, unknown>): void;
    warn(msg: string, data?: Record<string, unknown>): void;
    error(msg: string, data?: Record<string, unknown>): void;
    debug(msg: string, data?: Record<string, unknown>): void;
  };
}

/**
 * A strategy is a function that receives a context and trades.
 * It can optionally return a cleanup function.
 */
export type StrategyFn = (
  ctx: StrategyContext
) => Promise<CleanupFn | void>;

export type CleanupFn = () => void | Promise<void>;

/** Strategy definition with metadata */
export interface StrategyDefinition {
  name: string;
  description: string;
  run: StrategyFn;
}
