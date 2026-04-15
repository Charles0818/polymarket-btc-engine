import type { StrategyDefinition } from "../types/index.js";
import simpleMomentum from "./simple-momentum.js";
import oracleObiHybrid from "./oracle-obi-hybrid.js";

/** Registry of all available strategies */
const strategies: Map<string, StrategyDefinition> = new Map();

// Register built-in strategies
strategies.set(simpleMomentum.name, simpleMomentum);
strategies.set(oracleObiHybrid.name, oracleObiHybrid);

export function getStrategy(name: string): StrategyDefinition | undefined {
  return strategies.get(name);
}

export function listStrategies(): string[] {
  return [...strategies.keys()];
}

export function registerStrategy(def: StrategyDefinition) {
  strategies.set(def.name, def);
}
