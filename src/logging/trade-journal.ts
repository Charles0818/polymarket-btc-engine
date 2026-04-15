import * as fs from "fs";
import * as path from "path";
import { createLogger } from "./logger.js";

const log = createLogger("Journal");

export interface TradeJournalEntry {
  timestamp: string;
  round: number;
  marketId: string;
  priceTobeat: number;
  btcPriceAtSignal: number;
  oracleDeviation: number;
  obi: number;
  momentum: number;
  confidence: string;
  action: "BUY" | "SELL" | "STOP_LOSS" | "SKIP" | "HOLD_TO_EXPIRY";
  side: "UP" | "DOWN" | "NONE";
  entryPrice: number;
  exitPrice: number;
  shares: number;
  virtualPnl: number;
  outcome: "UP" | "DOWN" | "PENDING";
  skipReason: string;
  btcPriceAtResolution: number;
  timeRemainingAtEntry: number;
}

const CSV_HEADERS = [
  "timestamp",
  "round",
  "market_id",
  "price_to_beat",
  "btc_price_at_signal",
  "oracle_deviation_pct",
  "obi",
  "momentum",
  "confidence",
  "action",
  "side",
  "entry_price",
  "exit_price",
  "shares",
  "virtual_pnl",
  "outcome",
  "skip_reason",
  "btc_price_at_resolution",
  "time_remaining_at_entry_ms",
].join(",");

/**
 * Logs every strategy decision to a CSV file for post-analysis.
 * In shadow mode, all "trades" are virtual — no real orders placed.
 */
export class TradeJournal {
  private filePath: string;
  private stream: fs.WriteStream;
  private entryCount = 0;

  constructor(outputDir: string = ".") {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const fileName = `shadow-journal-${timestamp}.csv`;
    this.filePath = path.join(outputDir, fileName);

    // Create directory if needed
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    this.stream = fs.createWriteStream(this.filePath, { flags: "a" });
    this.stream.write(CSV_HEADERS + "\n");

    log.info("Trade journal created", { path: this.filePath });
  }

  record(entry: TradeJournalEntry) {
    const row = [
      entry.timestamp,
      entry.round,
      entry.marketId,
      entry.priceTobeat,
      entry.btcPriceAtSignal,
      entry.oracleDeviation.toFixed(6),
      entry.obi.toFixed(4),
      entry.momentum.toFixed(2),
      entry.confidence,
      entry.action,
      entry.side,
      entry.entryPrice,
      entry.exitPrice,
      entry.shares,
      entry.virtualPnl.toFixed(4),
      entry.outcome,
      `"${entry.skipReason}"`,
      entry.btcPriceAtResolution,
      entry.timeRemainingAtEntry,
    ].join(",");

    this.stream.write(row + "\n");
    this.entryCount++;
  }

  getFilePath(): string {
    return this.filePath;
  }

  getEntryCount(): number {
    return this.entryCount;
  }

  close() {
    this.stream.end();
    log.info("Trade journal closed", {
      entries: this.entryCount,
      path: this.filePath,
    });
  }
}
