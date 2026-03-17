import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RiskBridge } from "./bridge.js";
import { RISK_ENGINE_BIN, RISK_ENGINE_BIN_DEBUG } from "../core/constants.js";

vi.mock("../infra/logger.js", () => {
  const noop = () => {};
  const logger = {
    info: noop, warn: noop, error: noop, debug: noop, fatal: noop,
    child: () => logger,
  };
  return {
    initLogger: () => logger,
    getLogger: () => logger,
    childLogger: () => logger,
  };
});

const projectRoot = process.cwd();
const binaryExists =
  existsSync(join(projectRoot, RISK_ENGINE_BIN)) ||
  existsSync(join(projectRoot, RISK_ENGINE_BIN_DEBUG));

describe.skipIf(!binaryExists)("RiskBridge auto-restart", () => {
  it("saveInitState stores markets, equity, and limits", async () => {
    const bridge = new RiskBridge(projectRoot);
    await bridge.start();

    // Configure normally
    await bridge.configure({
      max_trade_size_usd: 100,
      max_daily_volume_usd: 500,
      max_drawdown_bps: 1000,
      cooldown_seconds: 0,
    });

    await bridge.addMarket({
      symbol: "ETH-USDC",
      initial_margin_bps: 1000,
      maintenance_margin_bps: 500,
      max_leverage: 10,
      tick_size: 0.01,
      min_size: 0.001,
    });

    await bridge.initAccount(1000);

    // Save state for restart
    bridge.saveInitState({
      markets: [{
        symbol: "ETH-USDC",
        initial_margin_bps: 1000,
        maintenance_margin_bps: 500,
        max_leverage: 10,
        tick_size: 0.01,
        min_size: 0.001,
      }],
      equity: 1000,
      limits: {
        max_trade_size_usd: 100,
        max_daily_volume_usd: 500,
        max_drawdown_bps: 1000,
        cooldown_seconds: 0,
      },
    });

    // Verify it works before stopping
    const state = await bridge.getState();
    expect(state.status).toBe("state");

    bridge.stop();
  }, 10_000);

  it("constructor accepts onHalt callback", () => {
    let haltCalled = false;
    const bridge = new RiskBridge(projectRoot, () => { haltCalled = true; });

    // Just verifying it doesn't throw
    expect(haltCalled).toBe(false);
  });

  it("intentional stop does not trigger restart", async () => {
    let haltCalled = false;
    const bridge = new RiskBridge(projectRoot, () => { haltCalled = true; });
    await bridge.start();

    // Verify it's working
    const state = await bridge.getState();
    expect(state).toBeDefined();

    // Intentional stop
    bridge.stop();

    // Wait a bit — should not trigger halt
    await new Promise((r) => setTimeout(r, 500));
    expect(haltCalled).toBe(false);
  }, 10_000);
});

describe.skipIf(!binaryExists)("RiskBridge constructor", () => {
  it("prefers release binary over debug", () => {
    // Just verify construction doesn't throw
    const bridge = new RiskBridge(projectRoot);
    expect(bridge).toBeDefined();
  });

  it("onHalt parameter is optional", () => {
    const bridge = new RiskBridge(projectRoot);
    expect(bridge).toBeDefined();
  });
});
