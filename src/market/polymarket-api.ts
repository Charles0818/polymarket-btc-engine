import type { Market } from "../types/index.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("PolymarketAPI");

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

/** Window duration in seconds */
const WINDOW_5M = 300;

/** Raw market data from Polymarket's Gamma API */
interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  description: string;
  startDate: string;
  endDate: string;
  /** Actual 5-min window start time (different from startDate!) */
  eventStartTime?: string;
  clobTokenIds?: string;
  /** JSON string like '["Up", "Down"]' */
  outcomes?: string;
  /** JSON string like '["0.505", "0.495"]' */
  outcomePrices?: string;
  tokens?: {
    token_id: string;
    outcome: string;
    price: number;
  }[];
  active: boolean;
  closed: boolean;
  customData?: string;
  acceptingOrders?: boolean;
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  description: string;
  startDate: string;
  endDate: string;
  /** Actual 5-min window start time */
  startTime?: string;
  markets: GammaMarket[];
}

/**
 * Compute the deterministic event slug for a BTC 5-minute market.
 *
 * Polymarket's 5-min BTC markets use fixed time windows aligned to
 * Unix epoch multiples of 300 seconds. The slug format is:
 *   btc-updown-5m-{window_start_unix}
 */
function computeSlug(windowStartUnix: number): string {
  return `btc-updown-5m-${windowStartUnix}`;
}

/**
 * Get the window-start timestamp (Unix seconds) for a given time.
 * Floors to the nearest 5-minute boundary.
 */
function getWindowStart(timeMs: number = Date.now()): number {
  return Math.floor(timeMs / 1000 / WINDOW_5M) * WINDOW_5M;
}

/**
 * Extract the Price to Beat (PTB) from a market description.
 *
 * Typical description:
 *   'This market will resolve to "Up" if the Bitcoin price at the end
 *    of the time range ... is greater than $83,512.35 ...'
 */
function extractPtbFromDescription(desc: string): number {
  if (!desc) return 0;
  // Match dollar amounts like $83,512.35 or $71687.61
  const match = desc.match(/\$\s?([\d,]+\.?\d*)/);
  if (match) {
    return parseFloat(match[1].replace(/,/g, ""));
  }
  return 0;
}

/**
 * Parse token IDs from the outcomes + clobTokenIds fields.
 *
 * The API returns:
 *   outcomes:     '["Up", "Down"]'
 *   clobTokenIds: '["<up_token_id>", "<down_token_id>"]'
 *
 * The arrays are parallel — index 0 of outcomes corresponds to index 0 of clobTokenIds.
 */
function parseTokenIds(market: GammaMarket): { up: string; down: string } {
  let up = "";
  let down = "";

  if (market.clobTokenIds && market.outcomes) {
    try {
      const tokenIds = JSON.parse(market.clobTokenIds) as string[];
      const outcomes = JSON.parse(market.outcomes) as string[];

      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i].toLowerCase();
        if (outcome === "up" || outcome === "yes") {
          up = tokenIds[i] ?? "";
        } else if (outcome === "down" || outcome === "no") {
          down = tokenIds[i] ?? "";
        }
      }
    } catch {
      /* JSON parse failed, try tokens array */
    }
  }

  // Fallback: tokens array (may not always be present)
  if ((!up || !down) && market.tokens) {
    for (const token of market.tokens) {
      const outcome = token.outcome.toLowerCase();
      if ((outcome === "up" || outcome === "yes") && !up) {
        up = token.token_id;
      } else if ((outcome === "down" || outcome === "no") && !down) {
        down = token.token_id;
      }
    }
  }

  return { up, down };
}

/**
 * Client for Polymarket's Gamma API.
 * Discovers BTC 5-minute prediction markets using deterministic slug lookup.
 */
export class PolymarketGammaClient {
  /** Optional: provide a live BTC price to use as fallback PTB */
  private liveBtcPrice: number = 0;

  setLiveBtcPrice(price: number): void {
    this.liveBtcPrice = price;
  }

  /**
   * Fetch an event by its deterministic slug.
   * Uses a 8-second timeout to avoid hanging on slow API responses.
   */
  private async fetchBySlug(slug: string): Promise<Market | null> {
    try {
      const eventUrl = `${GAMMA_API_BASE}/events?slug=${slug}&limit=1`;
      log.debug("Fetching event by slug", { slug });
      const res = await fetch(eventUrl, {
        signal: AbortSignal.timeout(8_000),
      });

      if (!res.ok) {
        log.debug(`Event lookup returned ${res.status}`, { slug });
        return null;
      }

      const events = (await res.json()) as GammaEvent[];
      if (events.length === 0 || !events[0].markets?.length) {
        return null;
      }

      return this.parseEvent(events[0]);
    } catch (err) {
      log.debug("Event slug lookup failed", { slug, error: String(err) });
      return null;
    }
  }

  /**
   * Fetch currently active BTC 5-minute UP/DOWN markets.
   *
   * Strategy: compute the deterministic slug for several adjacent
   * 5-minute windows, then look them up directly by slug. This is
   * more reliable than broad search, which frequently fails with
   * network errors.
   */
  async getActive5MinBtcMarkets(): Promise<Market[]> {
    const now = Date.now();
    const currentWindowStart = getWindowStart(now);

    // Try 5 adjacent windows: prev, current, next, next+1, next+2
    // This maximizes the chance of finding the right market even if
    // the Gamma API is slow to index new windows.
    const windowOffsets = [-1, 0, 1, 2, 3];
    const slugs = windowOffsets.map((offset) =>
      computeSlug(currentWindowStart + offset * WINDOW_5M)
    );

    log.debug("Looking up markets by slug", {
      slugs: slugs.map((s) => s.replace("btc-updown-5m-", "")),
    });

    // Fetch all in parallel
    const fetches = await Promise.allSettled(
      slugs.map((slug) => this.fetchBySlug(slug))
    );

    const results: Market[] = [];
    for (const result of fetches) {
      if (result.status === "fulfilled" && result.value) {
        results.push(result.value);
      }
    }

    if (results.length > 0) {
      log.info(`Found ${results.length} market(s) via slug lookup`);
      return results.sort((a, b) => a.startTime - b.startTime);
    }

    // If slug lookup returned nothing, try broad search as last resort
    log.debug("Slug lookup returned no results, trying broad search...");
    return this.broadSearch();
  }

  /**
   * Broad search fallback: fetch recent active events and filter by slug pattern.
   */
  private async broadSearch(): Promise<Market[]> {
    try {
      const url = new URL(`${GAMMA_API_BASE}/events`);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", "30");
      url.searchParams.set("order", "startDate");
      url.searchParams.set("ascending", "false");

      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        log.warn(`Broad search returned ${res.status}`);
        return [];
      }

      const events = (await res.json()) as GammaEvent[];

      const btc5m = events.filter((e) =>
        e.slug?.startsWith("btc-updown-5m-")
      );

      const results: Market[] = [];
      for (const event of btc5m) {
        const parsed = this.parseEvent(event);
        if (parsed) results.push(parsed);
      }

      if (results.length > 0) {
        log.info(`Broad search found ${results.length} BTC 5m market(s)`);
      }

      return results.sort((a, b) => a.startTime - b.startTime);
    } catch (err) {
      log.error("Broad search failed", { error: String(err) });
      return [];
    }
  }

  /**
   * Fetch a specific market by condition ID.
   */
  async getMarketByConditionId(conditionId: string): Promise<Market | null> {
    try {
      const url = `${GAMMA_API_BASE}/markets?conditionId=${conditionId}`;
      const res = await fetch(url);
      if (!res.ok) return null;

      const data = (await res.json()) as GammaMarket[];
      if (data.length === 0) return null;

      // Wrap in a fake event to reuse parseEvent
      return this.parseEvent({
        id: data[0].id,
        title: data[0].question,
        slug: data[0].slug,
        description: data[0].description,
        startDate: data[0].startDate,
        endDate: data[0].endDate,
        markets: data,
      });
    } catch {
      return null;
    }
  }

  /**
   * Parse a Gamma event into our Market type.
   */
  private parseEvent(event: GammaEvent): Market | null {
    const market = event.markets[0];
    if (!market) return null;

    // --- Token IDs ---
    const tokens = parseTokenIds(market);
    if (!tokens.up && !tokens.down) {
      log.debug("No token IDs found", { slug: event.slug });
      return null;
    }

    // --- Price to Beat ---
    // 1) Try market description
    let priceTobeat = extractPtbFromDescription(market.description);
    // 2) Try event description
    if (priceTobeat === 0) {
      priceTobeat = extractPtbFromDescription(event.description);
    }
    // 3) Try customData (some markets may have it)
    if (priceTobeat === 0 && market.customData) {
      try {
        const custom = JSON.parse(market.customData);
        priceTobeat =
          custom.priceTobeat ?? custom.priceToBeat ?? custom.price ?? 0;
      } catch {
        /* ignore */
      }
    }
    // 4) Fallback: use live BTC price (the PTB is the opening price of the window)
    if (priceTobeat === 0 && this.liveBtcPrice > 0) {
      log.debug("Using live BTC price as PTB fallback", {
        price: this.liveBtcPrice,
      });
      priceTobeat = this.liveBtcPrice;
    }

    // --- Timing ---
    // eventStartTime (on market) or startTime (on event) = actual window start
    // endDate = window end
    // startDate = when the market was created (often the day before!)
    const windowStartStr =
      market.eventStartTime || event.startTime || market.startDate;
    const windowEndStr = market.endDate || event.endDate;

    const startTime = new Date(windowStartStr).getTime();
    const endTime = new Date(windowEndStr).getTime();
    const now = Date.now();

    const status = market.closed
      ? "resolved"
      : now >= startTime
        ? "active"
        : "upcoming";

    const result: Market = {
      id: market.conditionId || event.id,
      priceTobeat,
      startTime,
      endTime,
      tokens,
      status,
    };

    log.debug("Parsed market", {
      slug: event.slug,
      ptb: priceTobeat,
      status,
      startsIn: `${Math.round((startTime - now) / 1000)}s`,
      endsIn: `${Math.round((endTime - now) / 1000)}s`,
      upToken: tokens.up.slice(0, 12) + "...",
      downToken: tokens.down.slice(0, 12) + "...",
    });

    return result;
  }
}

/**
 * Get the next upcoming or currently active 5-minute BTC market.
 * Returns null if no market is found.
 */
export async function getNextBtcMarket(
  client: PolymarketGammaClient
): Promise<Market | null> {
  const markets = await client.getActive5MinBtcMarkets();

  if (markets.length === 0) {
    log.warn("No active BTC 5-minute markets found");
    return null;
  }

  const now = Date.now();

  // Prefer active markets with the most time remaining
  const active = markets
    .filter((m) => m.status === "active" && m.endTime > now)
    .sort((a, b) => b.endTime - a.endTime);

  if (active.length > 0) {
    const best = active[0];
    log.info("Found active market", {
      id: best.id.slice(0, 12),
      ptb: best.priceTobeat,
      endsIn: `${Math.round((best.endTime - now) / 1000)}s`,
    });
    return best;
  }

  // Then upcoming markets — but only if they start within 10 minutes
  const maxWait = 10 * 60 * 1000;
  const upcoming = markets.filter(
    (m) => m.startTime > now && m.startTime - now < maxWait
  );
  if (upcoming.length > 0) {
    const next = upcoming[0];
    log.info("Found upcoming market", {
      id: next.id.slice(0, 12),
      ptb: next.priceTobeat,
      startsIn: `${Math.round((next.startTime - now) / 1000)}s`,
    });
    return next;
  }

  return null;
}
