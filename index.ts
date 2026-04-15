import "dotenv/config";
import { parseConfig } from "./src/config.js";
import { Engine } from "./src/core/engine.js";
import { ShadowEngine } from "./src/core/shadow-engine.js";
import { LiveEngine } from "./src/core/live-engine.js";
import { getStrategy, listStrategies } from "./src/strategy/index.js";

async function main() {
  const args = process.argv.slice(2);

  // Handle --help
  if (args.includes("--help")) {
    console.log(`
Polymarket BTC Trading Engine

Usage:
  bun run index.ts [options]
  npx tsx index.ts [options]

Modes:
  simulation    Paper trading with simulated markets (default)
  shadow        Watch REAL Polymarket markets, log virtual trades (no real orders)
  live          Live trading (requires API keys) — not yet implemented

Options:
  --mode <mode>           Trading mode: simulation|shadow|live (default: simulation)
  --rounds <n>            Number of market rounds (default: 5)
  --balance <n>           Starting USDC balance for sim (default: 1000)
  --strategy <name>       Strategy to run (default: simple-momentum)
  --log-level <level>     Log level: debug|info|warn|error (default: info)
  --price-feed <source>   Price feed: live|simulated (default: live)
  --list-strategies       List available strategies
  --help                  Show this help

Live mode requires a .env file with PRIVATE_KEY and CHAIN_ID.
See .env.example for all configuration options.

Examples:
  npx tsx index.ts --mode simulation --rounds 10 --strategy oracle-obi-hybrid
  npx tsx index.ts --mode shadow --rounds 5 --log-level debug
  npx tsx index.ts --mode live --rounds 10 --log-level debug
  npx tsx index.ts --strategy simple-momentum --rounds 3
`);
    return;
  }

  // Handle --list-strategies
  if (args.includes("--list-strategies")) {
    console.log("Available strategies:");
    for (const name of listStrategies()) {
      console.log(`  - ${name}`);
    }
    return;
  }

  const config = parseConfig(args);

  // --- SHADOW MODE ---
  if (config.mode === "shadow") {
    const shadow = new ShadowEngine(config);

    process.on("SIGINT", () => {
      console.log("\nShutting down shadow mode...");
      shadow.stop();
      process.exit(0);
    });

    try {
      await shadow.start();
    } catch (err) {
      console.error("Shadow engine error:", err);
      process.exit(1);
    }
    return;
  }

  // --- LIVE MODE ---
  if (config.mode === "live") {
    const live = new LiveEngine(config);

    process.on("SIGINT", () => {
      console.log("\nShutting down live mode — cancelling all orders...");
      live.stop();
      process.exit(0);
    });

    try {
      await live.start();
    } catch (err) {
      console.error("Live engine error:", err);
      process.exit(1);
    }
    return;
  }

  // --- SIMULATION MODE ---
  const strategyDef = getStrategy(config.strategy);
  if (!strategyDef) {
    console.error(`Unknown strategy: "${config.strategy}"`);
    console.error(`Available: ${listStrategies().join(", ")}`);
    process.exit(1);
  }

  const engine = new Engine(config);

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    engine.stop();
    process.exit(0);
  });

  try {
    await engine.start(strategyDef.run);
  } catch (err) {
    console.error("Engine error:", err);
    process.exit(1);
  }
}

main();
