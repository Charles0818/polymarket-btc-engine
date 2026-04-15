/**
 * Diagnostic: dump full market details including complete description
 * to find where the Price to Beat is stored.
 *
 * Usage: npx tsx scripts/test-market-discovery.ts
 */

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const WINDOW_5M = 300;

function getWindowStart(timeMs: number = Date.now()): number {
  return Math.floor(timeMs / 1000 / WINDOW_5M) * WINDOW_5M;
}

async function main() {
  const now = Date.now();
  const currentWindow = getWindowStart(now);
  const slug = `btc-updown-5m-${currentWindow}`;

  console.log("=== Full Market Description Dump ===");
  console.log(`Time: ${new Date(now).toISOString()}`);
  console.log(`Slug: ${slug}\n`);

  // Fetch the event
  const eventUrl = `${GAMMA_API_BASE}/events?slug=${slug}&limit=1`;
  const res = await fetch(eventUrl);
  const events = await res.json() as any[];

  if (!events.length) {
    console.log("No event found for current window slug.");
    // Try previous window
    const prevSlug = `btc-updown-5m-${currentWindow - WINDOW_5M}`;
    console.log(`Trying previous: ${prevSlug}`);
    const res2 = await fetch(`${GAMMA_API_BASE}/events?slug=${prevSlug}&limit=1`);
    const events2 = await res2.json() as any[];
    if (events2.length) events.push(events2[0]);
  }

  if (!events.length) {
    console.log("No events found at all.");
    return;
  }

  const event = events[0];
  const market = event.markets?.[0];

  console.log("=== EVENT DESCRIPTION (full) ===");
  console.log(event.description);
  console.log("\n=== MARKET DESCRIPTION (full) ===");
  console.log(market?.description);

  console.log("\n=== KEY FIELDS ===");
  console.log(`Event title:        ${event.title}`);
  console.log(`Event startTime:    ${event.startTime}`);
  console.log(`Market eventStartTime: ${market?.eventStartTime}`);
  console.log(`Market endDate:     ${market?.endDate}`);
  console.log(`Market outcomes:    ${market?.outcomes}`);
  console.log(`Market outcomePrices: ${market?.outcomePrices}`);
  console.log(`Market customData:  ${market?.customData}`);

  // Also try fetching just the market directly to see if description differs
  if (market?.conditionId) {
    console.log("\n=== DIRECT MARKET FETCH ===");
    const mRes = await fetch(`${GAMMA_API_BASE}/markets/${market.id}`);
    if (mRes.ok) {
      const mData = await mRes.json() as any;
      console.log("Direct description:", mData.description);
    }
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
