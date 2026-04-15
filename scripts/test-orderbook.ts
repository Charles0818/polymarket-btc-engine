/**
 * Diagnostic: test the CLOB REST API order book endpoint.
 *
 * Usage: npx tsx scripts/test-orderbook.ts
 */

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const CLOB_API_BASE = "https://clob.polymarket.com";
const WINDOW_5M = 300;

function getWindowStart(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_5M) * WINDOW_5M;
}

async function fetchWithRetry(url: string, retries = 3): Promise<any> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return res.json();
      console.log(`  Attempt ${i + 1}: HTTP ${res.status}`);
    } catch (err: any) {
      console.log(`  Attempt ${i + 1}: ${err.cause?.code ?? err.message}`);
    }
    if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

async function getMarketTokens(): Promise<{ up: string; down: string; slug: string } | null> {
  const currentWindow = getWindowStart();
  for (const offset of [0, -WINDOW_5M, WINDOW_5M]) {
    const ts = currentWindow + offset;
    const slug = `btc-updown-5m-${ts}`;
    console.log(`Trying: ${slug}`);
    const events = await fetchWithRetry(`${GAMMA_API_BASE}/events?slug=${slug}&limit=1`);
    if (!events?.length || !events[0].markets?.length) continue;
    const market = events[0].markets[0];
    if (!market.outcomes || !market.clobTokenIds) continue;
    const outcomes = JSON.parse(market.outcomes) as string[];
    const tokenIds = JSON.parse(market.clobTokenIds) as string[];
    let up = "", down = "";
    for (let i = 0; i < outcomes.length; i++) {
      if (outcomes[i].toLowerCase() === "up") up = tokenIds[i];
      else if (outcomes[i].toLowerCase() === "down") down = tokenIds[i];
    }
    if (up && down) return { up, down, slug: events[0].slug };
  }
  return null;
}

async function main() {
  console.log("=== CLOB REST API Order Book Test ===\n");

  const tokens = await getMarketTokens();
  if (!tokens) {
    console.log("Could not find a market. Try again in a minute.");
    return;
  }

  console.log(`\nMarket: ${tokens.slug}`);
  console.log(`UP token:   ${tokens.up.slice(0, 30)}...`);
  console.log(`DOWN token: ${tokens.down.slice(0, 30)}...`);

  // Test CLOB REST API for UP token
  console.log(`\n--- Fetching UP order book ---`);
  console.log(`GET ${CLOB_API_BASE}/book?token_id=${tokens.up.slice(0, 20)}...`);
  const upBook = await fetchWithRetry(`${CLOB_API_BASE}/book?token_id=${tokens.up}`);
  if (upBook) {
    console.log(`  ✅ Response received`);
    console.log(`  Bids: ${upBook.bids?.length ?? 0}`);
    if (upBook.bids?.length > 0) {
      for (const b of upBook.bids.slice(0, 5)) {
        console.log(`    bid: price=${b.price}, size=${b.size}`);
      }
    }
    console.log(`  Asks: ${upBook.asks?.length ?? 0}`);
    if (upBook.asks?.length > 0) {
      for (const a of upBook.asks.slice(0, 5)) {
        console.log(`    ask: price=${a.price}, size=${a.size}`);
      }
    }
    console.log(`  Other keys: ${Object.keys(upBook).filter(k => k !== "bids" && k !== "asks").join(", ")}`);
  } else {
    console.log(`  ❌ Failed to fetch UP book`);
  }

  // Test CLOB REST API for DOWN token
  console.log(`\n--- Fetching DOWN order book ---`);
  const downBook = await fetchWithRetry(`${CLOB_API_BASE}/book?token_id=${tokens.down}`);
  if (downBook) {
    console.log(`  ✅ Response received`);
    console.log(`  Bids: ${downBook.bids?.length ?? 0}`);
    if (downBook.bids?.length > 0) {
      for (const b of downBook.bids.slice(0, 5)) {
        console.log(`    bid: price=${b.price}, size=${b.size}`);
      }
    }
    console.log(`  Asks: ${downBook.asks?.length ?? 0}`);
    if (downBook.asks?.length > 0) {
      for (const a of downBook.asks.slice(0, 5)) {
        console.log(`    ask: price=${a.price}, size=${a.size}`);
      }
    }
  } else {
    console.log(`  ❌ Failed to fetch DOWN book`);
  }

  // Also test /price and /midpoint endpoints
  console.log(`\n--- Testing /price endpoint ---`);
  const upPrice = await fetchWithRetry(`${CLOB_API_BASE}/price?token_id=${tokens.up}&side=buy`);
  if (upPrice) {
    console.log(`  UP buy price: ${JSON.stringify(upPrice)}`);
  }
  const downPrice = await fetchWithRetry(`${CLOB_API_BASE}/price?token_id=${tokens.down}&side=buy`);
  if (downPrice) {
    console.log(`  DOWN buy price: ${JSON.stringify(downPrice)}`);
  }

  console.log(`\n--- Testing /midpoint endpoint ---`);
  const upMid = await fetchWithRetry(`${CLOB_API_BASE}/midpoint?token_id=${tokens.up}`);
  if (upMid) {
    console.log(`  UP midpoint: ${JSON.stringify(upMid)}`);
  }

  console.log("\n=== Done ===");
}

main().catch(console.error);
