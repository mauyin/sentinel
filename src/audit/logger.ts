import { randomUUID, createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
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
const GENESIS_HASH = "0".repeat(64);

export class AuditLogger {
  private entries: AuditEntry[] = [];
  private logDir: string;
  private lastHash: string = GENESIS_HASH;

  constructor(projectRoot: string) {
    this.logDir = join(projectRoot, AUDIT_DIR);
  }

  async init(): Promise<void> {
    await mkdir(this.logDir, { recursive: true });

    // Recover lastHash from today's log file (or most recent)
    try {
      const dateStr = new Date().toISOString().slice(0, 10);
      const filePath = join(this.logDir, `${dateStr}.jsonl`);
      const content = await readFile(filePath, "utf-8").catch(() => "");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        const lastEntry = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
        if (lastEntry.hash) {
          this.lastHash = lastEntry.hash;
        }
      }
    } catch {
      // No previous entries — start from genesis
    }
  }

  async logDecision(
    snapshot: MarketSnapshot,
    decision: TradeDecision,
    verdict: RiskVerdict,
    result?: TradeResult,
  ): Promise<AuditEntry> {
    const log = getLogger();

    const prevHash = this.lastHash;
    const partialEntry = {
      id: randomUUID(),
      timestamp: Date.now(),
      marketSnapshot: snapshot,
      decision,
      riskVerdict: verdict,
      tradeResult: result,
      prevHash,
    };

    // SHA-256 hash of the entry content + prevHash
    const hash = createHash("sha256")
      .update(JSON.stringify(partialEntry))
      .digest("hex");

    const entry: AuditEntry = { ...partialEntry, hash };

    this.lastHash = hash;
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
        hash: hash.slice(0, 12),
        prevHash: prevHash.slice(0, 12),
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

  /**
   * Verify the integrity of the hash chain.
   * Returns { valid, entries, brokenAt } where brokenAt is the index of the first broken link.
   */
  verifyChain(): { valid: boolean; entries: number; brokenAt?: number } {
    const entries = this.entries;
    if (entries.length === 0) return { valid: true, entries: 0 };

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // Verify prevHash linkage
      if (i === 0) {
        // First entry should link to genesis or the last recovered hash
        // (we can't verify the very first entry's prevHash without historical data)
      } else {
        const prev = entries[i - 1]!;
        if (entry.prevHash !== prev.hash) {
          return { valid: false, entries: entries.length, brokenAt: i };
        }
      }

      // Verify hash integrity: recompute hash from content
      const { hash: _storedHash, ...rest } = entry;
      const recomputedHash = createHash("sha256")
        .update(JSON.stringify(rest))
        .digest("hex");

      if (recomputedHash !== entry.hash) {
        return { valid: false, entries: entries.length, brokenAt: i };
      }
    }

    return { valid: true, entries: entries.length };
  }
}
