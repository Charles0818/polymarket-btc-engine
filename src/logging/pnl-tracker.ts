import type { RoundPnl } from "../types/index.js";
import { createLogger } from "./logger.js";

const log = createLogger("PnL");

export class PnlTracker {
  private rounds: RoundPnl[] = [];
  private sessionStartBalance: number;

  constructor(startBalance: number) {
    this.sessionStartBalance = startBalance;
  }

  recordRound(round: RoundPnl) {
    this.rounds.push(round);

    const emoji = round.pnl >= 0 ? "✅" : "❌";
    log.info(`${emoji} Round ${this.rounds.length}: ${round.pnl >= 0 ? "+" : ""}${round.pnl.toFixed(4)} USDC`, {
      side: round.side,
      entry: round.entryPrice,
      exit: round.exitPrice ?? 0,
      shares: round.shares,
      resolvedBy: round.resolvedBy,
    });
  }

  get totalPnl(): number {
    return this.rounds.reduce((sum, r) => sum + r.pnl, 0);
  }

  get winRate(): number {
    if (this.rounds.length === 0) return 0;
    const wins = this.rounds.filter((r) => r.outcome === "win").length;
    return wins / this.rounds.length;
  }

  get currentBalance(): number {
    return this.sessionStartBalance + this.totalPnl;
  }

  printSummary() {
    const wins = this.rounds.filter((r) => r.outcome === "win").length;
    const losses = this.rounds.filter((r) => r.outcome === "loss").length;
    const scratches = this.rounds.filter((r) => r.outcome === "scratch").length;

    console.log("\n" + "=".repeat(50));
    console.log("  SESSION SUMMARY");
    console.log("=".repeat(50));
    console.log(`  Rounds:     ${this.rounds.length}`);
    console.log(`  Wins:       ${wins}`);
    console.log(`  Losses:     ${losses}`);
    console.log(`  Scratches:  ${scratches}`);
    console.log(`  Win rate:   ${(this.winRate * 100).toFixed(1)}%`);
    console.log(`  Total PnL:  ${this.totalPnl >= 0 ? "+" : ""}${this.totalPnl.toFixed(4)} USDC`);
    console.log(`  Balance:    ${this.currentBalance.toFixed(2)} USDC`);
    console.log("=".repeat(50) + "\n");
  }
}
