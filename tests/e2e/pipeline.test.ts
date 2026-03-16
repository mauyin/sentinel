import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { RiskBridge } from "../../src/risk/bridge.js";
import { AuditLogger } from "../../src/audit/logger.js";
import { EventBus } from "../../src/infra/events.js";
import { Decimal } from "../../src/core/types.js";
import { RISK_ENGINE_BIN, RISK_ENGINE_BIN_DEBUG } from "../../src/core/constants.js";
import type { ExecuteParams, Executor } from "../../src/execution/router.js";
import { ExecutionRouter } from "../../src/execution/router.js";
import type { TradeResult } from "../../src/core/types.js";

// Suppress logger output in tests
vi.mock("../../src/infra/logger.js", () => {
  const noop = () => {};
  const logger = {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    fatal: noop,
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

/**
 * E2E Pipeline Test (WS5.3)
 *
 * Tests the complete 7-step pipeline with:
 * - Real Rust risk engine (spawned binary)
 * - Mock executor (returns configurable results)
 * - Mock LLM (returns canned decisions)
 * - Real audit logger (writes to temp dir)
 * - Real EventBus
 */
describe.skipIf(!binaryExists)("E2E pipeline", () => {
  let bridge: RiskBridge;
  let audit: AuditLogger;
  let eventBus: EventBus;
  let tmpDir: string;

  const TEST_MARKET = {
    id: "ETH-USDC-BASE",
    baseToken: {
      symbol: "WETH",
      address: "0x4200000000000000000000000000000000000006" as const,
      decimals: 18,
      coingeckoId: "ethereum",
    },
    quoteToken: {
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const,
      decimals: 6,
      coingeckoId: "usd-coin",
    },
    chainId: 8453 as const,
    venue: "uniswap" as const,
    initialMarginBps: 1000,
    maintenanceMarginBps: 500,
    maxLeverage: 10,
    minTradeUsd: 1,
  };

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "sentinel-e2e-"));

    // Initialize real risk engine
    bridge = new RiskBridge(projectRoot);
    await bridge.start();

    await bridge.configure({
      max_trade_size_usd: 100,
      max_daily_volume_usd: 500,
      max_drawdown_bps: 1000,
      cooldown_seconds: 0,
    });

    await bridge.configureCircuit({
      max_consecutive_losses: 3,
      max_equity_drop_rate_bps: 1000,
      max_data_staleness_secs: 300,
    });

    await bridge.addMarket({
      symbol: TEST_MARKET.id,
      initial_margin_bps: TEST_MARKET.initialMarginBps,
      maintenance_margin_bps: TEST_MARKET.maintenanceMarginBps,
      max_leverage: TEST_MARKET.maxLeverage,
      tick_size: 0.01,
      min_size: 0.001,
    });

    await bridge.initAccount(1000);

    // Initialize audit logger
    audit = new AuditLogger(tmpDir);
    await audit.init();

    eventBus = new EventBus();
  }, 15_000);

  afterAll(async () => {
    bridge.stop();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("full pipeline: validate → fill → state updated", async () => {
    const price = 2100;
    const size = 0.04; // 0.04 ETH * $2100 = $84 < $100 max

    // Step 1: Update price in risk engine
    const priceRes = await bridge.updatePrice(TEST_MARKET.id, price);
    expect(priceRes.status).toBe("price_updated");

    // Step 2: Validate trade
    const verdict = await bridge.validateTrade({
      market: TEST_MARKET.id,
      side: "long",
      size,
      price,
      leverage: 1,
    });
    expect(verdict.status).toBe("approved");

    // Step 3: Mock executor returns success
    const mockResult: TradeResult = {
      success: true,
      txHash: "0x" + "ab".repeat(32),
      market: TEST_MARKET.id,
      side: "long",
      size: new Decimal(size * price),
      price: new Decimal(price),
      timestamp: Date.now(),
    };

    // Step 4: Process fill in risk engine
    const fillRes = await bridge.processFill({
      market: TEST_MARKET.id,
      side: "long",
      size,
      price,
      fee: 0.5,
    });
    expect(fillRes.status).toBe("fill_processed");

    // Step 5: Record win
    await bridge.recordWin();

    // Step 6: Log to audit
    const snapshot = {
      market: "ethereum",
      price: new Decimal(price),
      change24h: 1.5,
      volume24h: 1_000_000,
      high24h: 2150,
      low24h: 2050,
      timestamp: Date.now(),
    };
    const decision = {
      action: "buy" as const,
      market: "ETH-USDC-BASE",
      size: 84,
      confidence: 75,
      reasoning: "Strong momentum with high volume",
    };
    const entry = await audit.logDecision(snapshot, decision, { status: "approved" }, mockResult);

    expect(entry.id).toBeDefined();
    expect(entry.decision.action).toBe("buy");
    expect(entry.riskVerdict.status).toBe("approved");
    expect(entry.tradeResult?.txHash).toBe(mockResult.txHash);

    // Step 7: Verify state
    const state = await bridge.getState();
    expect(state.status).toBe("state");
    // Positions are nested under `account`
    const account = state.account as { equity: unknown; positions: Array<{ market: string; side: string }> };
    expect(account).toBeDefined();
    expect(account.positions).toBeDefined();
    expect(account.positions.some((p) => p.market === TEST_MARKET.id)).toBe(true);
  });

  it("rejects unknown market from LLM", async () => {
    const verdict = await bridge.validateTrade({
      market: "DOGE-USDC-FANTASY",
      side: "long",
      size: 0.01,
      price: 0.5,
      leverage: 1,
    });
    expect(verdict.status).toBe("rejected");
  });

  it("circuit breaker trips after N consecutive losses", async () => {
    // Configure low threshold for testing
    await bridge.configureCircuit({
      max_consecutive_losses: 2,
      max_equity_drop_rate_bps: 1000,
      max_data_staleness_secs: 300,
    });

    // Reset to start fresh
    await bridge.resetCircuit();

    // Record losses
    await bridge.recordLoss();
    await bridge.recordLoss();

    // Circuit should be open
    const state = await bridge.checkCircuit();
    expect(state.state).toBe("open");

    // Validate should be rejected
    const verdict = await bridge.validateTrade({
      market: TEST_MARKET.id,
      side: "long",
      size: 0.01,
      price: 2100,
      leverage: 1,
    });
    expect(verdict.status).toBe("rejected");
    expect(verdict.reason).toContain("circuit_breaker");

    // Clean up: Open → HalfOpen → Closed
    await bridge.resetCircuit();
    await bridge.resetCircuit();
  });

  it("EventBus emits trade events", () => {
    const events: Array<{ type: string; data: unknown }> = [];
    eventBus.on((e) => events.push(e));

    eventBus.emit("trade", {
      success: true,
      market: TEST_MARKET.id,
      side: "long",
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("trade");
  });

  it("pending fill lifecycle: pending → confirm", async () => {
    // Ensure circuit is closed
    const preState = await bridge.checkCircuit();
    if (preState.state !== "closed") {
      await bridge.resetCircuit();
      if ((await bridge.checkCircuit()).state !== "closed") {
        await bridge.resetCircuit();
      }
    }

    // Process as pending
    const fillRes = await bridge.processFill({
      market: TEST_MARKET.id,
      side: "long",
      size: 0.01,
      price: 2100,
      fee: 0.1,
      pending: true,
    });
    expect(fillRes.status).toBe("fill_processed");

    // Confirm
    const confirmRes = await bridge.confirmFill(TEST_MARKET.id);
    expect(confirmRes.status).toBe("fill_confirmed");
  });

  it("pending fill lifecycle: pending → rollback", async () => {
    // Process another pending
    const fillRes = await bridge.processFill({
      market: TEST_MARKET.id,
      side: "long",
      size: 0.01,
      price: 2100,
      fee: 0.1,
      pending: true,
    });
    expect(fillRes.status).toBe("fill_processed");

    // Rollback
    const rollbackRes = await bridge.rollbackPending(TEST_MARKET.id);
    expect(rollbackRes.status).toBe("pending_rolled_back");
  });

  it("mock executor produces valid TradeResult", async () => {
    class TestMockExecutor implements Executor {
      async execute(params: ExecuteParams): Promise<TradeResult> {
        return {
          success: true,
          txHash: "0x" + "ff".repeat(32),
          market: params.market.id,
          side: params.side,
          size: params.sizeUsd,
          price: params.price,
          timestamp: Date.now(),
        };
      }
    }

    const router = new ExecutionRouter();
    router.register(8453 as any, new TestMockExecutor());

    const result = await router.execute({
      market: TEST_MARKET,
      side: "long",
      sizeUsd: new Decimal(50),
      price: new Decimal(2100),
      slippageBps: 50,
      deadlineSeconds: 180,
    });

    expect(result.success).toBe(true);
    expect(result.market).toBe(TEST_MARKET.id);
    expect(result.txHash).toBeDefined();
  });
});
