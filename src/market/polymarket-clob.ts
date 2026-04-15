/**
 * Polymarket CLOB Client Wrapper
 *
 * Provides a high-level interface for placing and managing orders on
 * Polymarket's Central Limit Order Book (CLOB). Handles wallet setup,
 * API credential derivation, and order lifecycle management.
 *
 * This is the bridge between our strategy engine and the Polymarket exchange.
 */

import { Wallet } from "ethers";
import {
  ClobClient,
  Side,
  OrderType,
} from "@polymarket/clob-client";
import type {
  ApiKeyCreds,
  OrderBookSummary,
  OrderResponse,
  OpenOrder,
  BalanceAllowanceResponse,
  TickSize,
  Chain,
  ClobSigner,
} from "@polymarket/clob-client";
import { createLogger } from "../logging/logger.js";

/**
 * Adapt an ethers v6 Wallet to the EthersSigner interface expected by
 * the Polymarket CLOB client.  The SDK checks for `_signTypedData` (ethers v5
 * convention), but ethers v6 renames it to `signTypedData`.
 */
function wrapEthersV6Wallet(wallet: Wallet): ClobSigner {
  return {
    _signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, Array<{ name: string; type: string }>>,
      value: Record<string, unknown>,
    ) => wallet.signTypedData(domain as any, types, value),
    getAddress: () => Promise.resolve(wallet.address),
  } as ClobSigner;
}

const log = createLogger("CLOB");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ClobConfig {
  /** Ethereum private key (hex, with or without 0x) */
  privateKey: string;
  /** Chain ID: 137 (Polygon) or 80002 (Amoy) */
  chainId: number;
  /** CLOB API host URL */
  apiUrl: string;
  /** Pre-derived API credentials (optional — will auto-derive if missing) */
  creds?: ApiKeyCreds;
  /** Geo-block bypass token (optional) */
  geoBlockToken?: string;
  /** Maximum USDC risk per round */
  maxRiskPerRound: number;
  /** Maximum total exposure across all positions */
  maxTotalExposure: number;
}

/** Load CLOB config from environment variables */
export function loadClobConfig(): ClobConfig {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY environment variable is required");
  }

  const chainId = parseInt(process.env.CHAIN_ID || "137", 10);
  const apiUrl =
    process.env.CLOB_API_URL || "https://clob.polymarket.com";

  // Check for pre-derived credentials
  let creds: ApiKeyCreds | undefined;
  if (
    process.env.CLOB_API_KEY &&
    process.env.CLOB_API_SECRET &&
    process.env.CLOB_API_PASSPHRASE
  ) {
    creds = {
      key: process.env.CLOB_API_KEY,
      secret: process.env.CLOB_API_SECRET,
      passphrase: process.env.CLOB_API_PASSPHRASE,
    };
  }

  return {
    privateKey,
    chainId,
    apiUrl,
    creds,
    geoBlockToken: process.env.GEO_BLOCK_TOKEN || undefined,
    maxRiskPerRound: parseFloat(process.env.MAX_RISK_PER_ROUND || "2.00"),
    maxTotalExposure: parseFloat(process.env.MAX_TOTAL_EXPOSURE || "20.00"),
  };
}

// ---------------------------------------------------------------------------
// Order result types
// ---------------------------------------------------------------------------

export interface PlaceOrderResult {
  success: boolean;
  orderId?: string;
  errorMsg?: string;
  /** Actual average fill price (if immediately matched) */
  avgPrice?: number;
  /** Shares filled */
  filled?: number;
}

export interface PositionInfo {
  /** USDC balance available for trading */
  usdcBalance: number;
  /** USDC allowance on the exchange */
  usdcAllowance: number;
}

// ---------------------------------------------------------------------------
// CLOB Client Wrapper
// ---------------------------------------------------------------------------

export class PolymarketClobClient {
  private client: ClobClient | null = null;
  private wallet: Wallet | null = null;
  private config: ClobConfig;
  private initialized = false;

  constructor(config: ClobConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the CLOB client: create wallet, derive API credentials
   * if needed, and instantiate the ClobClient.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    log.info("Initializing CLOB client...");

    // 1. Create ethers Wallet from private key
    const pk = this.config.privateKey.startsWith("0x")
      ? this.config.privateKey
      : `0x${this.config.privateKey}`;
    this.wallet = new Wallet(pk);

    log.info("Wallet loaded", {
      address: this.wallet.address,
      chain: this.config.chainId,
    });

    // 2. Create ClobClient (initially without creds to derive them)
    const chain = this.config.chainId as Chain;
    const signer = wrapEthersV6Wallet(this.wallet);

    if (this.config.creds) {
      // Use pre-derived credentials
      log.info("Using pre-derived API credentials");
      this.client = new ClobClient(
        this.config.apiUrl,
        chain,
        signer,
        this.config.creds,
        undefined, // signatureType
        undefined, // funderAddress
        this.config.geoBlockToken,
      );
    } else {
      // Need to derive credentials
      log.info("Deriving API credentials...");
      const tempClient = new ClobClient(
        this.config.apiUrl,
        chain,
        signer,
        undefined, // no creds yet
        undefined, // signatureType
        undefined, // funderAddress
        this.config.geoBlockToken,
      );

      const creds = await tempClient.createOrDeriveApiKey();
      log.info("API credentials derived", {
        key: creds.key.slice(0, 8) + "...",
      });

      // Recreate client with derived credentials
      this.client = new ClobClient(
        this.config.apiUrl,
        chain,
        signer,
        creds,
        undefined,
        undefined,
        this.config.geoBlockToken,
      );
      this.config.creds = creds;
    }

    // 3. Verify connectivity
    try {
      const ok = await this.client.getOk();
      log.info("CLOB API connected", { status: ok });
    } catch (err) {
      log.error("CLOB API health check failed", { error: String(err) });
      throw new Error("Failed to connect to Polymarket CLOB API");
    }

    this.initialized = true;
    log.info("CLOB client initialized successfully");
  }

  /** Ensure the client is initialized before any operation */
  private ensureInitialized(): ClobClient {
    if (!this.client || !this.initialized) {
      throw new Error("CLOB client not initialized. Call initialize() first.");
    }
    return this.client;
  }

  // -------------------------------------------------------------------------
  // Order Placement
  // -------------------------------------------------------------------------

  /**
   * Buy shares of a token (UP or DOWN) at a limit price.
   *
   * @param tokenId  - The condition token ID to buy
   * @param price    - Limit price per share (0 to 1)
   * @param size     - Number of shares to buy
   * @param tickSize - Market tick size (default "0.01")
   * @returns Order result with orderId and fill info
   */
  async buyShares(
    tokenId: string,
    price: number,
    size: number,
    tickSize: TickSize = "0.01",
  ): Promise<PlaceOrderResult> {
    const client = this.ensureInitialized();

    log.info("Placing BUY order", {
      tokenId: tokenId.slice(0, 12) + "...",
      price,
      size,
    });

    try {
      const resp = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          size,
          side: Side.BUY,
        },
        { tickSize, negRisk: true },
        OrderType.GTC,
      );

      const result = this.parseOrderResponse(resp);
      if (result.success) {
        log.info("BUY order placed", {
          orderId: result.orderId?.slice(0, 12),
          price,
          size,
        });
      } else {
        log.warn("BUY order failed", { error: result.errorMsg });
      }
      return result;
    } catch (err) {
      log.error("BUY order threw", { error: String(err) });
      return { success: false, errorMsg: String(err) };
    }
  }

  /**
   * Sell shares of a token to exit a position.
   *
   * @param tokenId  - The condition token ID to sell
   * @param price    - Limit price per share
   * @param size     - Number of shares to sell
   * @param tickSize - Market tick size
   */
  async sellShares(
    tokenId: string,
    price: number,
    size: number,
    tickSize: TickSize = "0.01",
  ): Promise<PlaceOrderResult> {
    const client = this.ensureInitialized();

    log.info("Placing SELL order", {
      tokenId: tokenId.slice(0, 12) + "...",
      price,
      size,
    });

    try {
      const resp = await client.createAndPostOrder(
        {
          tokenID: tokenId,
          price,
          size,
          side: Side.SELL,
        },
        { tickSize, negRisk: true },
        OrderType.GTC,
      );

      const result = this.parseOrderResponse(resp);
      if (result.success) {
        log.info("SELL order placed", {
          orderId: result.orderId?.slice(0, 12),
          price,
          size,
        });
      } else {
        log.warn("SELL order failed", { error: result.errorMsg });
      }
      return result;
    } catch (err) {
      log.error("SELL order threw", { error: String(err) });
      return { success: false, errorMsg: String(err) };
    }
  }

  /**
   * Place a market order (Fill-or-Kill) to buy immediately at best available price.
   * Used for urgent entries when limit orders might not fill in time.
   *
   * @param tokenId - Token to buy
   * @param amount  - USDC amount to spend
   * @param tickSize - Market tick size
   */
  async marketBuy(
    tokenId: string,
    amount: number,
    tickSize: TickSize = "0.01",
  ): Promise<PlaceOrderResult> {
    const client = this.ensureInitialized();

    log.info("Placing MARKET BUY (FOK)", {
      tokenId: tokenId.slice(0, 12) + "...",
      amount,
    });

    try {
      const resp = await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          amount,
          side: Side.BUY,
        },
        { tickSize, negRisk: true },
        OrderType.FOK,
      );

      const result = this.parseOrderResponse(resp);
      if (result.success) {
        log.info("MARKET BUY filled", {
          orderId: result.orderId?.slice(0, 12),
          amount,
        });
      } else {
        log.warn("MARKET BUY failed", { error: result.errorMsg });
      }
      return result;
    } catch (err) {
      log.error("MARKET BUY threw", { error: String(err) });
      return { success: false, errorMsg: String(err) };
    }
  }

  // -------------------------------------------------------------------------
  // Order Management
  // -------------------------------------------------------------------------

  /** Cancel a specific order by ID */
  async cancelOrder(orderId: string): Promise<boolean> {
    const client = this.ensureInitialized();
    try {
      await client.cancelOrder({ orderID: orderId });
      log.info("Order cancelled", { orderId: orderId.slice(0, 12) });
      return true;
    } catch (err) {
      log.error("Cancel failed", {
        orderId: orderId.slice(0, 12),
        error: String(err),
      });
      return false;
    }
  }

  /** Cancel all open orders */
  async cancelAllOrders(): Promise<boolean> {
    const client = this.ensureInitialized();
    try {
      await client.cancelAll();
      log.info("All orders cancelled");
      return true;
    } catch (err) {
      log.error("Cancel all failed", { error: String(err) });
      return false;
    }
  }

  /** Get all open orders, optionally filtered by market or asset */
  async getOpenOrders(marketId?: string): Promise<OpenOrder[]> {
    const client = this.ensureInitialized();
    try {
      const params = marketId ? { market: marketId } : undefined;
      return await client.getOpenOrders(params);
    } catch (err) {
      log.error("Failed to get open orders", { error: String(err) });
      return [];
    }
  }

  /** Get a specific order by ID */
  async getOrder(orderId: string): Promise<OpenOrder | null> {
    const client = this.ensureInitialized();
    try {
      return await client.getOrder(orderId);
    } catch (err) {
      log.error("Failed to get order", { error: String(err) });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Account Info
  // -------------------------------------------------------------------------

  /** Get USDC balance and allowance */
  async getUsdcBalance(): Promise<PositionInfo> {
    const client = this.ensureInitialized();
    try {
      const resp: BalanceAllowanceResponse =
        await client.getBalanceAllowance({
          asset_type: "COLLATERAL" as any,
        });
      return {
        usdcBalance: parseFloat(resp.balance),
        usdcAllowance: parseFloat(resp.allowance),
      };
    } catch (err) {
      log.error("Failed to get balance", { error: String(err) });
      return { usdcBalance: 0, usdcAllowance: 0 };
    }
  }

  /** Check if we're in closed-only (banned) mode */
  async isClosedOnly(): Promise<boolean> {
    const client = this.ensureInitialized();
    try {
      const status = await client.getClosedOnlyMode();
      return status.closed_only;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Order Book
  // -------------------------------------------------------------------------

  /** Get the full order book for a token */
  async getOrderBook(tokenId: string): Promise<OrderBookSummary | null> {
    const client = this.ensureInitialized();
    try {
      return await client.getOrderBook(tokenId);
    } catch (err) {
      log.error("Failed to get order book", { error: String(err) });
      return null;
    }
  }

  /** Get midpoint price for a token */
  async getMidpoint(tokenId: string): Promise<number | null> {
    const client = this.ensureInitialized();
    try {
      const mid = await client.getMidpoint(tokenId);
      return typeof mid === "number" ? mid : parseFloat(mid);
    } catch (err) {
      log.error("Failed to get midpoint", { error: String(err) });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get address(): string {
    return this.wallet?.address ?? "";
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  get apiCreds(): ApiKeyCreds | undefined {
    return this.config.creds;
  }

  get riskLimits() {
    return {
      maxRiskPerRound: this.config.maxRiskPerRound,
      maxTotalExposure: this.config.maxTotalExposure,
    };
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private parseOrderResponse(resp: any): PlaceOrderResult {
    // The CLOB API can return different shapes depending on the endpoint
    if (!resp) {
      return { success: false, errorMsg: "Empty response" };
    }

    // Standard OrderResponse shape
    if (typeof resp === "object" && "success" in resp) {
      const r = resp as OrderResponse;
      return {
        success: r.success,
        orderId: r.orderID,
        errorMsg: r.errorMsg || undefined,
      };
    }

    // Sometimes the API returns just an order ID string
    if (typeof resp === "string") {
      return { success: true, orderId: resp };
    }

    // If it has an orderID field, treat as success
    if (resp.orderID) {
      return { success: true, orderId: resp.orderID };
    }

    log.warn("Unexpected order response shape", {
      type: typeof resp,
      keys: Object.keys(resp),
    });
    return { success: false, errorMsg: "Unexpected response format" };
  }
}
