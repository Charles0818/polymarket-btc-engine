/** Represents a 5-minute BTC prediction market on Polymarket */
export interface Market {
  /** Unique identifier for this market slot */
  id: string;
  /** The BTC price that determines UP/DOWN resolution */
  priceTobeat: number;
  /** When this 5-min window starts (epoch ms) */
  startTime: number;
  /** When this 5-min window ends (epoch ms) */
  endTime: number;
  /** Condition token IDs for each outcome */
  tokens: {
    up: string;
    down: string;
  };
  /** Current state of the market */
  status: "upcoming" | "active" | "resolved";
  /** Resolution outcome (set after market ends) */
  outcome?: "UP" | "DOWN";
}

/** A single level in the order book */
export interface OrderBookLevel {
  price: number;
  size: number;
}

/** Full order book snapshot */
export interface OrderBook {
  /** Buy orders sorted by price descending (best bid first) */
  bids: OrderBookLevel[];
  /** Sell orders sorted by price ascending (best ask first) */
  asks: OrderBookLevel[];
  /** Timestamp of this snapshot */
  timestamp: number;
}

/** Which side of the market: UP or DOWN */
export type MarketSide = "UP" | "DOWN";

/** Order type — all Polymarket orders are limit orders */
export type OrderType = "GTC" | "GTD" | "FOK";

/** Order status through its lifecycle */
export type OrderStatus =
  | "pending"
  | "matched"
  | "mined"
  | "confirmed"
  | "cancelled"
  | "expired"
  | "filled";

/** A trading order */
export interface Order {
  id: string;
  side: MarketSide;
  /** "buy" or "sell" shares */
  action: "buy" | "sell";
  price: number;
  size: number;
  /** How many shares have been filled so far */
  filledSize: number;
  status: OrderStatus;
  type: OrderType;
  /** When the order was placed (epoch ms) */
  createdAt: number;
  /** For GTD orders: when it expires */
  expireAt?: number;
}

/** A completed fill (partial or full) */
export interface Fill {
  orderId: string;
  price: number;
  size: number;
  timestamp: number;
  side: MarketSide;
  action: "buy" | "sell";
}

/** Current position in a market */
export interface Position {
  side: MarketSide;
  shares: number;
  avgEntryPrice: number;
  /** Running realized PnL from sells */
  realizedPnl: number;
}

/** PnL result for a single market round */
export interface RoundPnl {
  marketId: string;
  side: MarketSide;
  entryPrice: number;
  exitPrice: number | null;
  shares: number;
  pnl: number;
  outcome: "win" | "loss" | "scratch";
  resolvedBy: "sell" | "expiry";
}
