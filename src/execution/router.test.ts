import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../infra/logger.js", () => {
  const logger = {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: () => logger,
  };
  return {
    getLogger: () => logger,
    childLogger: () => logger,
  };
});

vi.mock("../infra/rpc.js", () => ({
  getPublicClient: vi.fn(),
  getAccount: vi.fn().mockReturnValue({ address: "0xTestAddress" }),
}));

vi.mock("../config/chains.js", () => ({
  txUrl: vi.fn().mockReturnValue("https://basescan.org/tx/0x..."),
}));

import { ExecutionRouter, MockExecutor } from "./router.js";
import type { ExecuteParams, CloseParams } from "./router.js";
import type { Executor } from "./router.js";
import type { TradeResult } from "../core/types.js";
import { Decimal } from "../core/types.js";
import { getPublicClient } from "../infra/rpc.js";

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

const MOCK_ENV = {
  AGENT_PRIVATE_KEY: "0x" + "ab".repeat(32),
} as any;

function makeExecuteParams(overrides: Partial<ExecuteParams> = {}): ExecuteParams {
  return {
    market: TEST_MARKET,
    side: "long",
    sizeUsd: new Decimal(50),
    price: new Decimal(2100),
    slippageBps: 50,
    deadlineSeconds: 180,
    ...overrides,
  };
}

describe("ExecutionRouter gas pre-check", () => {
  let router: ExecutionRouter;

  beforeEach(() => {
    router = new ExecutionRouter(MOCK_ENV);
    vi.clearAllMocks();
  });

  it("rejects trade when gas balance is too low", async () => {
    vi.mocked(getPublicClient).mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(100n), // way below 0.001 ETH
    } as any);

    const mockExecutor: Executor = {
      execute: vi.fn().mockResolvedValue({ success: true }),
    };
    router.register(8453 as any, mockExecutor);

    const result = await router.execute(makeExecuteParams());

    expect(result.success).toBe(false);
    expect(result.error).toContain("insufficient gas");
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  it("allows trade when gas balance is sufficient", async () => {
    vi.mocked(getPublicClient).mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(10_000_000_000_000_000n), // 0.01 ETH
    } as any);

    const mockExecutor: Executor = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        txHash: "0x123",
        market: TEST_MARKET.id,
        side: "long",
        size: new Decimal(50),
        price: new Decimal(2100),
        timestamp: Date.now(),
      } as TradeResult),
    };
    router.register(8453 as any, mockExecutor);

    const result = await router.execute(makeExecuteParams());

    expect(result.success).toBe(true);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  it("proceeds when gas check fails (e.g., RPC error)", async () => {
    vi.mocked(getPublicClient).mockReturnValue({
      getBalance: vi.fn().mockRejectedValue(new Error("RPC timeout")),
    } as any);

    const mockExecutor: Executor = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        market: TEST_MARKET.id,
        side: "long",
        size: new Decimal(50),
        price: new Decimal(2100),
        timestamp: Date.now(),
      } as TradeResult),
    };
    router.register(8453 as any, mockExecutor);

    const result = await router.execute(makeExecuteParams());

    // Should proceed despite RPC error
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });
});

describe("ExecutionRouter closePosition", () => {
  let router: ExecutionRouter;

  beforeEach(() => {
    router = new ExecutionRouter(MOCK_ENV);
    vi.mocked(getPublicClient).mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(10_000_000_000_000_000n),
    } as any);
  });

  it("routes close to executor.closePosition", async () => {
    const mockExecutor: Executor = {
      execute: vi.fn(),
      closePosition: vi.fn().mockResolvedValue({
        success: true,
        txHash: "0xclose",
        market: TEST_MARKET.id,
        side: "long",
        size: new Decimal(50),
        price: new Decimal(2100),
        timestamp: Date.now(),
      } as TradeResult),
    };
    router.register(8453 as any, mockExecutor);

    const result = await router.closePosition({
      market: TEST_MARKET,
      side: "long",
      size: new Decimal(50),
      price: new Decimal(2100),
      slippageBps: 50,
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xclose");
    expect(mockExecutor.closePosition).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  it("returns error when executor has no closePosition", async () => {
    const mockExecutor: Executor = {
      execute: vi.fn(),
      // No closePosition method
    };
    router.register(8453 as any, mockExecutor);

    const result = await router.closePosition({
      market: TEST_MARKET,
      side: "long",
      size: new Decimal(50),
      price: new Decimal(2100),
      slippageBps: 50,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not support closing");
  });

  it("returns error when no executor registered for chain", async () => {
    const result = await router.closePosition({
      market: TEST_MARKET,
      side: "long",
      size: new Decimal(50),
      price: new Decimal(2100),
      slippageBps: 50,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no executor registered");
  });

  it("checks gas before closing", async () => {
    vi.mocked(getPublicClient).mockReturnValue({
      getBalance: vi.fn().mockResolvedValue(100n), // too low
    } as any);

    const mockExecutor: Executor = {
      execute: vi.fn(),
      closePosition: vi.fn(),
    };
    router.register(8453 as any, mockExecutor);

    const result = await router.closePosition({
      market: TEST_MARKET,
      side: "long",
      size: new Decimal(50),
      price: new Decimal(2100),
      slippageBps: 50,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("insufficient gas");
    expect(mockExecutor.closePosition).not.toHaveBeenCalled();
  });
});

describe("MockExecutor", () => {
  it("execute returns success with fake hash", async () => {
    const mock = new MockExecutor();
    const result = await mock.execute(makeExecuteParams());

    expect(result.success).toBe(true);
    expect(result.txHash).toBeDefined();
    expect(result.market).toBe(TEST_MARKET.id);
  });

  it("closePosition returns success with fake hash", async () => {
    const mock = new MockExecutor();
    const result = await mock.closePosition!({
      market: TEST_MARKET,
      side: "long",
      size: new Decimal(50),
      price: new Decimal(2100),
      slippageBps: 50,
    });

    expect(result.success).toBe(true);
    expect(result.txHash).toBeDefined();
  });
});
