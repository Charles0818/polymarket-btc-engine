import type {
  Order,
  Fill,
  Position,
  MarketSide,
  Market,
} from "../types/index.js";
import type { PlaceOrderOpts } from "../types/strategy.js";
import { SimulatedOrderBook } from "./sim-order-book.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("SimExchange");

let orderCounter = 0;
function nextOrderId(): string {
  return `sim-order-${++orderCounter}`;
}

/**
 * Simulates the Polymarket exchange for paper trading.
 * Handles order placement, fill simulation, position tracking, and balance management.
 */
export class SimulatedExchange {
  private balance: number;
  private orders: Map<string, Order> = new Map();
  private positions: Map<string, Position> = new Map(); // keyed by MarketSide
  private fills: Fill[] = [];
  private fillCallbacks: ((fill: Fill, order: Order) => void)[] = [];
  private cancelCallbacks: ((order: Order, reason: string) => void)[] = [];
  private orderBook: SimulatedOrderBook;
  private buysBlocked = false;
  private sellsBlocked = false;

  constructor(balance: number, orderBook: SimulatedOrderBook) {
    this.balance = balance;
    this.orderBook = orderBook;
  }

  getBalance(): number {
    return this.balance;
  }

  getPosition(side?: MarketSide): Position | null {
    if (side) {
      return this.positions.get(side) ?? null;
    }
    // Return the first non-zero position
    for (const pos of this.positions.values()) {
      if (pos.shares > 0) return pos;
    }
    return null;
  }

  getActiveOrders(): Order[] {
    return [...this.orders.values()].filter(
      (o) => o.status === "pending" || o.status === "matched"
    );
  }

  getOrderBook() {
    return this.orderBook;
  }

  blockBuys() {
    this.buysBlocked = true;
  }

  blockSells() {
    this.sellsBlocked = true;
  }

  onFill(cb: (fill: Fill, order: Order) => void) {
    this.fillCallbacks.push(cb);
  }

  onCancel(cb: (order: Order, reason: string) => void) {
    this.cancelCallbacks.push(cb);
  }

  async placeOrder(opts: PlaceOrderOpts): Promise<Order> {
    if (opts.action === "buy" && this.buysBlocked) {
      throw new Error("Buys are blocked for this market");
    }
    if (opts.action === "sell" && this.sellsBlocked) {
      throw new Error("Sells are blocked for this market");
    }

    // Check if we have enough balance for a buy
    if (opts.action === "buy") {
      const cost = opts.price * opts.size;
      if (cost > this.balance) {
        throw new Error(
          `Insufficient balance: need ${cost.toFixed(2)} but have ${this.balance.toFixed(2)}`
        );
      }
    }

    // Check if we have shares to sell
    if (opts.action === "sell") {
      const pos = this.positions.get(opts.side);
      if (!pos || pos.shares < opts.size) {
        throw new Error(
          `Insufficient shares: need ${opts.size} but have ${pos?.shares ?? 0}`
        );
      }
    }

    const order: Order = {
      id: nextOrderId(),
      side: opts.side,
      action: opts.action,
      price: opts.price,
      size: opts.size,
      filledSize: 0,
      status: "pending",
      type: opts.type ?? "GTC",
      createdAt: Date.now(),
      expireAt: opts.expireAt,
    };

    this.orders.set(order.id, order);
    log.debug(`Order placed: ${order.action} ${order.size}x ${order.side} @ ${order.price}`, {
      orderId: order.id,
    });

    // Simulate fill after a small delay (mimics on-chain confirmation)
    this.simulateFill(order);

    return order;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);

    if (order.status !== "pending" && order.status !== "matched") {
      throw new Error(`Cannot cancel order in status: ${order.status}`);
    }

    order.status = "cancelled";
    for (const cb of this.cancelCallbacks) {
      cb(order, "user_cancelled");
    }
  }

  async cancelAllOrders(): Promise<void> {
    for (const order of this.orders.values()) {
      if (order.status === "pending" || order.status === "matched") {
        order.status = "cancelled";
        for (const cb of this.cancelCallbacks) {
          cb(order, "user_cancelled");
        }
      }
    }
  }

  async emergencySell(side: MarketSide): Promise<void> {
    const pos = this.positions.get(side);
    if (!pos || pos.shares <= 0) return;

    const bestBid = this.orderBook.getBestBid(side);
    log.warn(`Emergency sell: ${pos.shares} ${side} shares @ ${bestBid}`);

    await this.placeOrder({
      side,
      action: "sell",
      price: bestBid,
      size: pos.shares,
    });
  }

  /**
   * Resolve all open positions at market end.
   * Winning shares pay out $1, losing shares pay out $0.
   */
  resolveMarket(outcome: "UP" | "DOWN") {
    for (const [side, pos] of this.positions.entries()) {
      if (pos.shares <= 0) continue;

      const isWinner = side === outcome;
      const payout = isWinner ? pos.shares * 1.0 : 0;

      log.info(
        `Resolving ${pos.shares} ${side} shares → ${isWinner ? "WIN" : "LOSS"} (payout: ${payout.toFixed(2)})`,
      );

      this.balance += payout;
      pos.realizedPnl += payout - pos.shares * pos.avgEntryPrice;
      pos.shares = 0;
    }
  }

  private simulateFill(order: Order) {
    // Simulate a realistic delay: 100-500ms for order matching
    const delay = 100 + Math.random() * 400;

    setTimeout(() => {
      if (order.status === "cancelled") return;

      // Check if order can fill against the book
      const book = this.orderBook.getOrderBook(order.side);

      let canFill = false;
      if (order.action === "buy") {
        // Buy fills if our limit price >= best ask
        const bestAsk = book.asks[0]?.price ?? Infinity;
        canFill = order.price >= bestAsk;
      } else {
        // Sell fills if our limit price <= best bid
        const bestBid = book.bids[0]?.price ?? 0;
        canFill = order.price <= bestBid;
      }

      if (!canFill) {
        // Order rests on the book — for simulation, we'll fill it after another delay
        // with some probability to simulate partial fills
        setTimeout(() => {
          if (order.status === "cancelled") return;
          // 70% chance of filling a resting order within the window
          if (Math.random() < 0.7) {
            this.executeFill(order);
          } else {
            order.status = "expired";
            for (const cb of this.cancelCallbacks) {
              cb(order, "no_fill");
            }
          }
        }, 500 + Math.random() * 2000);
        return;
      }

      this.executeFill(order);
    }, delay);
  }

  private executeFill(order: Order) {
    if (order.status === "cancelled" || order.status === "filled") return;

    const fillPrice = order.price;
    const fillSize = order.size - order.filledSize;

    if (order.action === "buy") {
      const cost = fillPrice * fillSize;
      this.balance -= cost;

      // Update position
      const existing = this.positions.get(order.side);
      if (existing && existing.shares > 0) {
        const totalShares = existing.shares + fillSize;
        existing.avgEntryPrice =
          (existing.avgEntryPrice * existing.shares + fillPrice * fillSize) / totalShares;
        existing.shares = totalShares;
      } else {
        this.positions.set(order.side, {
          side: order.side,
          shares: fillSize,
          avgEntryPrice: fillPrice,
          realizedPnl: 0,
        });
      }
    } else {
      // Sell — credit balance and reduce position
      const revenue = fillPrice * fillSize;
      this.balance += revenue;

      const pos = this.positions.get(order.side);
      if (pos) {
        const pnl = (fillPrice - pos.avgEntryPrice) * fillSize;
        pos.realizedPnl += pnl;
        pos.shares -= fillSize;
      }
    }

    order.filledSize = order.size;
    order.status = "filled";

    const fill: Fill = {
      orderId: order.id,
      price: fillPrice,
      size: fillSize,
      timestamp: Date.now(),
      side: order.side,
      action: order.action,
    };

    this.fills.push(fill);

    log.debug(
      `Fill: ${order.action} ${fillSize}x ${order.side} @ ${fillPrice}`,
      { orderId: order.id, balance: Math.round(this.balance * 100) / 100 },
    );

    for (const cb of this.fillCallbacks) {
      cb(fill, order);
    }
  }
}
