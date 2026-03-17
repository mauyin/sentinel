import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { AuditLogger } from "./logger.js";
import { Decimal } from "../core/types.js";
import type { MarketSnapshot, TradeDecision, TradeResult } from "../core/types.js";

vi.mock("../infra/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
  childLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function makeSnapshot(): MarketSnapshot {
  return {
    market: "ETH-USDC-BASE",
    price: new Decimal(2100),
    change24h: 1.5,
    volume24h: 1_000_000,
    high24h: 2150,
    low24h: 2050,
    timestamp: Date.now(),
  };
}

function makeDecision(overrides: Partial<TradeDecision> = {}): TradeDecision {
  return {
    action: "buy",
    market: "ETH-USDC-BASE",
    size: 50,
    confidence: 75,
    reasoning: "Strong momentum",
    ...overrides,
  };
}

describe("AuditLogger hash chain", () => {
  let tmpDir: string;
  let logger: AuditLogger;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sentinel-audit-"));
    logger = new AuditLogger(tmpDir);
    await logger.init();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("generates hash and prevHash for each entry", async () => {
    const entry = await logger.logDecision(
      makeSnapshot(),
      makeDecision(),
      { status: "approved" },
    );

    expect(entry.hash).toBeDefined();
    expect(entry.hash).toHaveLength(64); // SHA-256 hex
    expect(entry.prevHash).toBeDefined();
    expect(entry.prevHash).toHaveLength(64);
  });

  it("first entry links to genesis hash (all zeros)", async () => {
    const entry = await logger.logDecision(
      makeSnapshot(),
      makeDecision(),
      { status: "approved" },
    );

    expect(entry.prevHash).toBe("0".repeat(64));
  });

  it("chains entries — second entry prevHash equals first entry hash", async () => {
    const first = await logger.logDecision(
      makeSnapshot(),
      makeDecision(),
      { status: "approved" },
    );

    const second = await logger.logDecision(
      makeSnapshot(),
      makeDecision({ action: "hold", confidence: 40 }),
      { status: "approved" },
    );

    expect(second.prevHash).toBe(first.hash);
  });

  it("hash is deterministic — recomputable from entry content", async () => {
    const entry = await logger.logDecision(
      makeSnapshot(),
      makeDecision(),
      { status: "approved" },
    );

    const { hash: storedHash, ...rest } = entry;
    const recomputed = createHash("sha256")
      .update(JSON.stringify(rest))
      .digest("hex");

    expect(recomputed).toBe(storedHash);
  });

  it("builds a valid chain across multiple entries", async () => {
    await logger.logDecision(makeSnapshot(), makeDecision(), { status: "approved" });
    await logger.logDecision(makeSnapshot(), makeDecision({ action: "hold" }), { status: "approved" });
    await logger.logDecision(makeSnapshot(), makeDecision({ action: "sell" }), { status: "rejected", reason: "test" });

    const result = logger.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(3);
    expect(result.brokenAt).toBeUndefined();
  });

  it("verifyChain returns valid for empty chain", () => {
    const result = logger.verifyChain();
    expect(result.valid).toBe(true);
    expect(result.entries).toBe(0);
  });

  it("writes entries to JSONL file", async () => {
    await logger.logDecision(makeSnapshot(), makeDecision(), { status: "approved" });
    await logger.logDecision(makeSnapshot(), makeDecision({ action: "hold" }), { status: "approved" });

    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = join(tmpDir, "audit-logs", `${dateStr}.jsonl`);
    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");

    expect(lines).toHaveLength(2);

    const firstEntry = JSON.parse(lines[0]!);
    const secondEntry = JSON.parse(lines[1]!);

    expect(firstEntry.hash).toBeDefined();
    expect(secondEntry.prevHash).toBe(firstEntry.hash);
  });

  it("includes tradeResult in hashed entries", async () => {
    const tradeResult: TradeResult = {
      success: true,
      txHash: "0x" + "ab".repeat(32),
      market: "ETH-USDC-BASE",
      side: "long",
      size: new Decimal(50),
      price: new Decimal(2100),
      timestamp: Date.now(),
    };

    const entry = await logger.logDecision(
      makeSnapshot(),
      makeDecision(),
      { status: "approved" },
      tradeResult,
    );

    expect(entry.tradeResult).toBeDefined();
    expect(entry.tradeResult!.txHash).toBe(tradeResult.txHash);

    // Hash includes tradeResult
    const { hash: storedHash, ...rest } = entry;
    const recomputed = createHash("sha256")
      .update(JSON.stringify(rest))
      .digest("hex");
    expect(recomputed).toBe(storedHash);
  });

  it("getRecentEntries returns last N entries", async () => {
    await logger.logDecision(makeSnapshot(), makeDecision(), { status: "approved" });
    await logger.logDecision(makeSnapshot(), makeDecision({ action: "hold" }), { status: "approved" });
    await logger.logDecision(makeSnapshot(), makeDecision({ action: "sell" }), { status: "approved" });

    const recent = logger.getRecentEntries(2);
    expect(recent).toHaveLength(2);
    expect(recent[0]!.decision.action).toBe("hold");
    expect(recent[1]!.decision.action).toBe("sell");
  });

  it("recovers lastHash from existing JSONL on init", async () => {
    // Write first entry
    const first = await logger.logDecision(makeSnapshot(), makeDecision(), { status: "approved" });

    // Create a new logger instance pointed at the same directory
    const logger2 = new AuditLogger(tmpDir);
    await logger2.init();

    // Second logger should recover the last hash
    const second = await logger2.logDecision(
      makeSnapshot(),
      makeDecision({ action: "hold" }),
      { status: "approved" },
    );

    expect(second.prevHash).toBe(first.hash);
  });
});
