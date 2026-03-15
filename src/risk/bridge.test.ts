import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RiskBridge } from "./bridge.js";
import { RISK_ENGINE_BIN, RISK_ENGINE_BIN_DEBUG } from "../core/constants.js";

const projectRoot = process.cwd();
const binaryExists =
  existsSync(join(projectRoot, RISK_ENGINE_BIN)) ||
  existsSync(join(projectRoot, RISK_ENGINE_BIN_DEBUG));

describe.skipIf(!binaryExists)("RiskBridge integration", () => {
  let bridge: RiskBridge;

  beforeAll(async () => {
    bridge = new RiskBridge(projectRoot);
    await bridge.start();
  });

  afterAll(() => {
    bridge.stop();
  });

  it("configures risk limits", async () => {
    const res = await bridge.configure({
      max_trade_size_usd: 100,
      max_daily_volume_usd: 500,
      max_drawdown_bps: 1000,
      cooldown_seconds: 0,
    });
    expect(res.status).toBe("configured");
  });

  it("adds a market", async () => {
    const res = await bridge.addMarket({
      symbol: "ETH-USDC-BASE",
      initial_margin_bps: 1000,
      maintenance_margin_bps: 500,
      max_leverage: 10,
      tick_size: 0.01,
      min_size: 0.001,
    });
    expect(res.status).toBe("market_added");
  });

  it("initializes account", async () => {
    const res = await bridge.initAccount(1000);
    expect(res.status).toBe("account_initialized");
  });

  it("updates price", async () => {
    const res = await bridge.updatePrice("ETH-USDC-BASE", 2100);
    expect(res.status).toBe("price_updated");
  });

  it("approves a valid trade", async () => {
    // size is in base units: 0.04 ETH * $2100 = $84 notional < $100 max
    const res = await bridge.validateTrade({
      market: "ETH-USDC-BASE",
      side: "long",
      size: 0.04,
      price: 2100,
      leverage: 1,
    });
    expect(res.status).toBe("approved");
  });

  it("rejects oversized trade", async () => {
    // 1 ETH * $2100 = $2100 notional > $100 max
    const res = await bridge.validateTrade({
      market: "ETH-USDC-BASE",
      side: "long",
      size: 1,
      price: 2100,
      leverage: 1,
    });
    expect(res.status).toBe("rejected");
  });

  it("processes a fill", async () => {
    const res = await bridge.processFill({
      market: "ETH-USDC-BASE",
      side: "long",
      size: 0.04,
      price: 2100,
      fee: 0.5,
    });
    expect(res.status).toBe("fill_processed");
  });

  it("returns state with account data", async () => {
    const res = await bridge.getState();
    expect(res.status).toBe("state");
    const account = res["account"] as Record<string, unknown>;
    expect(account).toHaveProperty("equity");
    expect(account).toHaveProperty("positions");
  });
});
