import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RiskBridge } from "./bridge.js";
import { RISK_ENGINE_BIN, RISK_ENGINE_BIN_DEBUG } from "../core/constants.js";

const projectRoot = process.cwd();
const binaryExists =
  existsSync(join(projectRoot, RISK_ENGINE_BIN)) ||
  existsSync(join(projectRoot, RISK_ENGINE_BIN_DEBUG));

describe.skipIf(!binaryExists)("RiskBridge — circuit breaker & pending orders", () => {
  let bridge: RiskBridge;

  beforeAll(async () => {
    bridge = new RiskBridge(projectRoot);
    await bridge.start();

    // Standard setup: configure, add market, init account
    await bridge.configure({
      max_trade_size_usd: 100,
      max_daily_volume_usd: 500,
      max_drawdown_bps: 1000,
      cooldown_seconds: 0,
    });
    await bridge.addMarket({
      symbol: "ETH-USDC-TEST",
      initial_margin_bps: 1000,
      maintenance_margin_bps: 500,
      max_leverage: 10,
      tick_size: 0.01,
      min_size: 0.001,
    });
    await bridge.initAccount(1000);
    await bridge.updatePrice("ETH-USDC-TEST", 2100);
  });

  afterAll(() => {
    bridge.stop();
  });

  // ── Circuit Breaker ─────────────────────────────────────────────────

  it("configures circuit breaker", async () => {
    const res = await bridge.configureCircuit({
      max_consecutive_losses: 3,
      max_equity_drop_rate_bps: 1000,
      max_data_staleness_secs: 300,
    });
    expect(res.status).toBe("circuit_configured");
  });

  it("checks circuit — initially closed", async () => {
    const res = await bridge.checkCircuit();
    expect(res.status).toBe("circuit_state");
    expect(res.state).toBe("closed");
  });

  it("trips circuit breaker manually", async () => {
    const res = await bridge.tripCircuit();
    expect(res.status).toBe("circuit_tripped");
  });

  it("rejects trades when circuit is open", async () => {
    const res = await bridge.validateTrade({
      market: "ETH-USDC-TEST",
      side: "long",
      size: 0.01,
      price: 2100,
      leverage: 1,
    });
    expect(res.status).toBe("rejected");
    expect(res.reason).toContain("circuit_breaker");
  });

  it("resets circuit breaker (Open → HalfOpen → Closed)", async () => {
    // First reset: Open → HalfOpen
    const res1 = await bridge.resetCircuit();
    expect(res1.status).toBe("circuit_reset");
    const state1 = await bridge.checkCircuit();
    expect(state1.state).toBe("half_open");

    // Second reset: HalfOpen → Closed
    const res2 = await bridge.resetCircuit();
    expect(res2.status).toBe("circuit_reset");
    const state2 = await bridge.checkCircuit();
    expect(state2.state).toBe("closed");
  });

  it("trips after consecutive losses", async () => {
    // Ensure we start from closed
    await bridge.configureCircuit({
      max_consecutive_losses: 2,
      max_equity_drop_rate_bps: 1000,
      max_data_staleness_secs: 300,
    });

    await bridge.recordLoss();
    const mid = await bridge.checkCircuit();
    // First loss should not trip (need 2)
    expect(mid.consecutive_losses).toBe(1);

    await bridge.recordLoss();
    const after = await bridge.checkCircuit();
    expect(after.state).toBe("open");

    // Clean up: Open → HalfOpen → Closed
    await bridge.resetCircuit();
    await bridge.resetCircuit();
  });

  it("recordWin resets consecutive loss counter", async () => {
    // Ensure clean start
    const preState = await bridge.checkCircuit();
    if (preState.state !== "closed") {
      await bridge.resetCircuit();
      if ((await bridge.checkCircuit()).state !== "closed") {
        await bridge.resetCircuit();
      }
    }

    await bridge.configureCircuit({
      max_consecutive_losses: 2,
      max_equity_drop_rate_bps: 1000,
      max_data_staleness_secs: 300,
    });

    await bridge.recordLoss();
    await bridge.recordWin(); // resets counter
    await bridge.recordLoss(); // only 1 loss now

    const state = await bridge.checkCircuit();
    expect(state.state).not.toBe("open");
  });

  // ── Pending Orders ──────────────────────────────────────────────────

  it("processes a pending fill", async () => {
    await bridge.resetCircuit();

    const res = await bridge.processFill({
      market: "ETH-USDC-TEST",
      side: "long",
      size: 0.01,
      price: 2100,
      fee: 0.1,
      pending: true,
    });
    expect(res.status).toBe("fill_processed");
  });

  it("confirms a pending fill", async () => {
    const res = await bridge.confirmFill("ETH-USDC-TEST");
    expect(res.status).toBe("fill_confirmed");
  });

  it("handles rollback of pending fill", async () => {
    // Create another pending position
    await bridge.processFill({
      market: "ETH-USDC-TEST",
      side: "long",
      size: 0.01,
      price: 2100,
      fee: 0.1,
      pending: true,
    });

    const res = await bridge.rollbackPending("ETH-USDC-TEST");
    expect(res.status).toBe("pending_rolled_back");
  });

  // ── Sequence IDs ────────────────────────────────────────────────────

  it("maintains seq IDs across multiple rapid requests", async () => {
    // Fire multiple requests concurrently — seq matching ensures correct pairing
    const results = await Promise.all([
      bridge.getState(),
      bridge.checkCircuit(),
      bridge.updatePrice("ETH-USDC-TEST", 2105),
    ]);

    expect(results[0]!.status).toBe("state");
    expect(results[1]!.status).toBe("circuit_state");
    expect(results[2]!.status).toBe("price_updated");
  });

  // ── Input Validation ────────────────────────────────────────────────

  it("rejects negative trade size", async () => {
    const res = await bridge.validateTrade({
      market: "ETH-USDC-TEST",
      side: "long",
      size: -1,
      price: 2100,
      leverage: 1,
    });
    // Rust returns rejected (input validation is part of rejection flow)
    expect(res.status).toBe("rejected");
    expect(res.reason).toBeDefined();
  });

  it("rejects zero price", async () => {
    const res = await bridge.validateTrade({
      market: "ETH-USDC-TEST",
      side: "long",
      size: 0.01,
      price: 0,
      leverage: 1,
    });
    expect(res.status).toBe("rejected");
    expect(res.reason).toBeDefined();
  });

  it("rejects unknown market", async () => {
    const res = await bridge.validateTrade({
      market: "UNKNOWN-MARKET",
      side: "long",
      size: 0.01,
      price: 2100,
      leverage: 1,
    });
    expect(res.status).toBe("rejected");
  });
});
