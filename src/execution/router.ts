import type { MarketPairConfig } from "../config/markets.js";
import type { Decimal, Side, TradeResult } from "../core/types.js";
import type { Env } from "../config/env.js";
import type { SupportedChainId } from "../config/chains.js";
import { txUrl } from "../config/chains.js";
import { childLogger } from "../infra/logger.js";
import { getPublicClient, getAccount } from "../infra/rpc.js";
import { UniswapExecutor } from "./uniswap.js";
import { GmxExecutor } from "./gmx.js";

export interface ExecuteParams {
  market: MarketPairConfig;
  side: Side;
  sizeUsd: Decimal;
  price: Decimal;
  slippageBps: number;
  deadlineSeconds: number;
}

export interface CloseParams {
  market: MarketPairConfig;
  side: Side;
  size: Decimal;
  price: Decimal;
  slippageBps: number;
}

export interface Executor {
  execute(params: ExecuteParams): Promise<TradeResult>;
  closePosition?(params: CloseParams): Promise<TradeResult>;
}

// Minimum gas balance required to attempt a trade (in wei) — ~0.001 ETH
const MIN_GAS_WEI = 1_000_000_000_000_000n;

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

  async closePosition(params: CloseParams): Promise<TradeResult> {
    const fakeHash = `0x${"0".repeat(63)}2`;

    this.log.info(
      {
        market: params.market.id,
        side: params.side,
        size: params.size.toString(),
      },
      "mock position closed",
    );

    return {
      success: true,
      txHash: fakeHash,
      market: params.market.id,
      side: params.side,
      size: params.size,
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
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  register(chainId: SupportedChainId, executor: Executor): void {
    this.executors.set(chainId, executor);
    this.log.info({ chainId }, "executor registered");
  }

  async execute(params: ExecuteParams): Promise<TradeResult> {
    const chainId = params.market.chainId;

    // Gas balance pre-check
    const gasOk = await this.checkGasBalance(chainId);
    if (!gasOk) {
      return {
        success: false,
        market: params.market.id,
        side: params.side,
        size: params.sizeUsd,
        price: params.price,
        error: "insufficient gas balance for transaction",
        timestamp: Date.now(),
      };
    }

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

  async closePosition(params: CloseParams): Promise<TradeResult> {
    const chainId = params.market.chainId;

    // Gas balance pre-check
    const gasOk = await this.checkGasBalance(chainId);
    if (!gasOk) {
      return {
        success: false,
        market: params.market.id,
        side: params.side,
        size: params.size,
        price: params.price,
        error: "insufficient gas balance for close transaction",
        timestamp: Date.now(),
      };
    }

    const executor = this.executors.get(chainId);

    if (!executor) {
      this.log.error({ chainId }, "no executor for chain");
      return {
        success: false,
        market: params.market.id,
        side: params.side,
        size: params.size,
        price: params.price,
        error: `no executor registered for chainId ${chainId}`,
        timestamp: Date.now(),
      };
    }

    if (!executor.closePosition) {
      this.log.error({ chainId }, "executor does not support closing positions");
      return {
        success: false,
        market: params.market.id,
        side: params.side,
        size: params.size,
        price: params.price,
        error: "executor does not support closing positions",
        timestamp: Date.now(),
      };
    }

    const result = await executor.closePosition(params);

    if (result.success && result.txHash) {
      this.log.info(
        { market: params.market.id, tx: txUrl(chainId, result.txHash) },
        "position closed",
      );
    }

    return result;
  }

  private async checkGasBalance(chainId: SupportedChainId): Promise<boolean> {
    try {
      const client = getPublicClient(chainId);
      const account = getAccount(this.env.AGENT_PRIVATE_KEY as `0x${string}`);
      const balance = await client.getBalance({ address: account.address });

      if (balance < MIN_GAS_WEI) {
        this.log.warn(
          { chainId, balance: balance.toString(), minRequired: MIN_GAS_WEI.toString() },
          "insufficient gas balance — skipping trade",
        );
        return false;
      }

      return true;
    } catch (err) {
      this.log.warn({ err, chainId }, "gas balance check failed — proceeding with caution");
      return true; // Don't block on balance check failure
    }
  }
}

// ---------------------------------------------------------------------------
// Factory — wires executors per chain (mock for all chains initially)
// ---------------------------------------------------------------------------

export function createRouter(env: Env): ExecutionRouter {
  const router = new ExecutionRouter(env);
  const mock = new MockExecutor();

  router.register(8453, new UniswapExecutor(env, 8453)); // Base mainnet — real Uniswap
  router.register(84532, mock);                          // Base Sepolia — mock
  router.register(42161, new GmxExecutor(env, 42161));   // Arbitrum One — real GMX
  router.register(421614, mock);                         // Arbitrum Sepolia — mock

  return router;
}
