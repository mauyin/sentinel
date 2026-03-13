import type { MarketPairConfig } from "../config/markets.js";
import type { Decimal, Side, TradeResult } from "../core/types.js";
import type { Env } from "../config/env.js";
import type { SupportedChainId } from "../config/chains.js";
import { txUrl } from "../config/chains.js";
import { childLogger } from "../infra/logger.js";

export interface ExecuteParams {
  market: MarketPairConfig;
  side: Side;
  sizeUsd: Decimal;
  price: Decimal;
  slippageBps: number;
  deadlineSeconds: number;
}

export interface Executor {
  execute(params: ExecuteParams): Promise<TradeResult>;
}

// ---------------------------------------------------------------------------
// Mock executor — logs would-be trades, returns fake success
// ---------------------------------------------------------------------------

export class MockExecutor implements Executor {
  private log = childLogger({ component: "mock-executor" });

  async execute(params: ExecuteParams): Promise<TradeResult> {
    const fakeHash = `0x${"0".repeat(63)}1`;

    this.log.info(
      {
        market: params.market.id,
        side: params.side,
        sizeUsd: params.sizeUsd.toString(),
        price: params.price.toString(),
      },
      "mock trade executed",
    );

    return {
      success: true,
      txHash: fakeHash,
      market: params.market.id,
      side: params.side,
      size: params.sizeUsd,
      price: params.price,
      timestamp: Date.now(),
    };
  }
}

// ---------------------------------------------------------------------------
// Execution router — dispatches to the right executor by chainId
// ---------------------------------------------------------------------------

export class ExecutionRouter {
  private executors = new Map<SupportedChainId, Executor>();
  private log = childLogger({ component: "execution-router" });

  register(chainId: SupportedChainId, executor: Executor): void {
    this.executors.set(chainId, executor);
    this.log.info({ chainId }, "executor registered");
  }

  async execute(params: ExecuteParams): Promise<TradeResult> {
    const chainId = params.market.chainId;
    const executor = this.executors.get(chainId);

    if (!executor) {
      this.log.error({ chainId }, "no executor for chain");
      return {
        success: false,
        market: params.market.id,
        side: params.side,
        size: params.sizeUsd,
        price: params.price,
        error: `no executor registered for chainId ${chainId}`,
        timestamp: Date.now(),
      };
    }

    const result = await executor.execute(params);

    if (result.success && result.txHash) {
      this.log.info(
        { market: params.market.id, tx: txUrl(chainId, result.txHash) },
        "trade executed",
      );
    }

    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory — wires executors per chain (mock for all chains initially)
// ---------------------------------------------------------------------------

export function createRouter(_env: Env): ExecutionRouter {
  const router = new ExecutionRouter();
  const mock = new MockExecutor();

  // All chains use mock execution until real executors are wired in
  router.register(8453, mock); // Base mainnet
  router.register(84532, mock); // Base Sepolia
  router.register(42161, mock); // Arbitrum One
  router.register(421614, mock); // Arbitrum Sepolia

  return router;
}
