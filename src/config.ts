export interface EngineConfig {
  /** "simulation", "shadow", or "live" */
  mode: "simulation" | "shadow" | "live";
  /** Number of market rounds to trade */
  rounds: number;
  /** Starting balance for simulation (USDC) */
  simBalance: number;
  /** Strategy name to run */
  strategy: string;
  /** Market slot duration in ms (default 5 min) */
  slotDuration: number;
  /** How early to enter the next market (ms before slot starts) */
  entryLeadTime: number;
  /** BTC price feed source (live mode auto-falls back through multiple sources) */
  priceFeed: "live" | "simulated";
  /** Log level */
  logLevel: "debug" | "info" | "warn" | "error";
}

const defaults: EngineConfig = {
  mode: "simulation",
  rounds: 5,
  simBalance: 1000,
  strategy: "simple-momentum",
  slotDuration: 5 * 60 * 1000,
  entryLeadTime: 10_000,
  priceFeed: "live",
  logLevel: "info",
};

export function parseConfig(args: string[]): EngineConfig {
  const config = { ...defaults };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--mode":
        config.mode = next as EngineConfig["mode"];
        i++;
        break;
      case "--rounds":
        config.rounds = parseInt(next, 10);
        i++;
        break;
      case "--balance":
        config.simBalance = parseFloat(next);
        i++;
        break;
      case "--strategy":
        config.strategy = next;
        i++;
        break;
      case "--log-level":
        config.logLevel = next as EngineConfig["logLevel"];
        i++;
        break;
      case "--price-feed":
        config.priceFeed = next as EngineConfig["priceFeed"];
        i++;
        break;
    }
  }

  return config;
}
