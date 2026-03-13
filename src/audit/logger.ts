import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  AuditEntry,
  MarketSnapshot,
  TradeDecision,
  RiskVerdict,
  TradeResult,
} from "../core/types.js";
import { getLogger } from "../infra/logger.js";

const AUDIT_DIR = "audit-logs";

export class AuditLogger {
  private entries: AuditEntry[] = [];
  private logDir: string;

  constructor(projectRoot: string) {
    this.logDir = join(projectRoot, AUDIT_DIR);
  }

  async init(): Promise<void> {
    await mkdir(this.logDir, { recursive: true });
  }

  async logDecision(
    snapshot: MarketSnapshot,
    decision: TradeDecision,
    verdict: RiskVerdict,
    result?: TradeResult,
  ): Promise<AuditEntry> {
    const log = getLogger();

    const entry: AuditEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      marketSnapshot: snapshot,
      decision,
      riskVerdict: verdict,
      tradeResult: result,
    };

    this.entries.push(entry);

    // Append to daily log file
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = join(this.logDir, `${dateStr}.jsonl`);
    await appendFile(filePath, JSON.stringify(entry) + "\n");

    log.info(
      {
        id: entry.id,
        action: decision.action,
        market: decision.market,
        confidence: decision.confidence,
        verdict: verdict.status,
        txHash: result?.txHash,
      },
      "decision logged",
    );

    return entry;
  }

  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  getRecentEntries(count: number): AuditEntry[] {
    return this.entries.slice(-count);
  }
}
