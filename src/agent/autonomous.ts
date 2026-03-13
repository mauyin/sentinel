import type { Env } from "../config/env.js";
import type { MarketPairConfig } from "../config/markets.js";
import type { RiskBridge } from "../risk/bridge.js";
import type { AuditLogger } from "../audit/logger.js";
import type { ExecutionRouter, ExecuteParams } from "../execution/router.js";
import type { LlmConfig } from "../llm/provider.js";
import type {
  MarketSnapshot,
  PortfolioSnapshot,
  TradeDecision,
  TradeResult,
} from "../core/types.js";
import { Decimal } from "../core/types.js";
import { chat } from "../llm/provider.js";
import { parseTradeDecision } from "../llm/parser.js";
import {
  MARKET_ANALYSIS_SYSTEM,
  RISK_REVIEW_SYSTEM,
  buildMarketAnalysisPrompt,
  buildRiskReviewPrompt,
} from "../llm/prompts.js";
import { fetchMarketSnapshots, fetchPrices } from "../market/feed.js";
import { fetchPortfolio } from "../market/portfolio.js";
import {
  formatMarketData,
  formatPortfolio,
  formatRecentTrades,
} from "../market/analyzer.js";
import { getPublicClient } from "../infra/rpc.js";
import { getAccount } from "../infra/rpc.js";
import { childLogger } from "../infra/logger.js";
import {
  POLL_INTERVAL_MS,
  MIN_CONFIDENCE_TO_TRADE,
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_DEADLINE_SECONDS,
} from "../core/constants.js";

export interface AgentDeps {
  env: Env;
  llm: LlmConfig;
  risk: RiskBridge;
  audit: AuditLogger;
  executor: ExecutionRouter;
  markets: MarketPairConfig[];
}

const MAX_RECENT_TRADES = 20;

export async function runAutonomous(deps: AgentDeps): Promise<void> {
  const log = childLogger({ component: "autonomous" });
  const recentTrades: TradeResult[] = [];
  let stopped = false;
  let cycle = 0;

  const shutdown = () => {
    log.info("graceful shutdown requested");
    stopped = true;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log.info(
    { marketCount: deps.markets.length, pollMs: POLL_INTERVAL_MS },
    "autonomous agent starting",
  );

  while (!stopped) {
    cycle++;
    const cycleLog = childLogger({ component: "autonomous", cycle });

    try {
      await runCycle(deps, recentTrades, cycleLog);
    } catch (err) {
      cycleLog.error({ err }, "cycle failed");
    }

    if (!stopped) {
      cycleLog.info({ nextIn: POLL_INTERVAL_MS }, "sleeping until next cycle");
      await sleep(POLL_INTERVAL_MS);
    }
  }

  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  log.info({ totalCycles: cycle }, "autonomous agent stopped");
}

// ---------------------------------------------------------------------------
// Single analysis/trade cycle — the 7-step pipeline
// ---------------------------------------------------------------------------

async function runCycle(
  deps: AgentDeps,
  recentTrades: TradeResult[],
  log: ReturnType<typeof childLogger>,
): Promise<void> {
  const { env, llm, risk, audit, executor, markets } = deps;
  const account = getAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);

  // ── Step 1: OBSERVE ──────────────────────────────────────────────────
  log.info("step 1/7: observing markets");

  const coingeckoIds = uniqueCoingeckoIds(markets);
  const [snapshots, prices] = await Promise.all([
    fetchMarketSnapshots(coingeckoIds),
    fetchPrices(coingeckoIds),
  ]);

  if (snapshots.length === 0) {
    log.warn("no market data — skipping cycle");
    return;
  }

  // Fetch portfolio from the first market's chain
  const primaryMarket = markets[0]!;
  const client = getPublicClient(primaryMarket.chainId);
  const allTokens = markets.flatMap((m) => [m.baseToken, m.quoteToken]);
  const uniqueTokens = dedupeTokens(allTokens);
  const portfolio = await fetchPortfolio(
    client,
    account.address,
    uniqueTokens,
    primaryMarket.chainId,
    prices,
  );

  // ── Step 2: ANALYZE ──────────────────────────────────────────────────
  log.info("step 2/7: formatting data for LLM");

  const marketData = formatMarketData(snapshots);
  const portfolioData = formatPortfolio(portfolio);
  const tradesData = formatRecentTrades(recentTrades);
  const userPrompt = buildMarketAnalysisPrompt(
    marketData,
    portfolioData,
    tradesData,
  );

  // ── Step 3: REASON ───────────────────────────────────────────────────
  log.info("step 3/7: querying LLM for trade decision");

  const rawResponse = await chat(llm, MARKET_ANALYSIS_SYSTEM, userPrompt);
  const decision = parseTradeDecision(rawResponse);

  if (!decision) {
    log.warn("LLM returned unparseable response — skipping cycle");
    return;
  }

  log.info(
    {
      action: decision.action,
      market: decision.market,
      confidence: decision.confidence,
      size: decision.size,
    },
    "LLM decision parsed",
  );

  // ── Step 4: CONFIDENCE CHECK ─────────────────────────────────────────
  if (decision.action === "hold" || decision.confidence < MIN_CONFIDENCE_TO_TRADE) {
    log.info(
      { action: decision.action, confidence: decision.confidence },
      "step 4/7: below confidence threshold — holding",
    );

    // Still log the hold decision for audit trail
    const snapshot = findSnapshot(snapshots, decision.market);
    if (snapshot) {
      await audit.logDecision(snapshot, decision, { status: "approved" });
    }
    return;
  }

  // ── Step 5: RISK REVIEW (2nd LLM pass) ──────────────────────────────
  log.info("step 5/7: LLM risk review");

  const riskState = await risk.getState();
  const riskReviewPrompt = buildRiskReviewPrompt(
    JSON.stringify(decision),
    portfolioData,
    JSON.stringify(riskState),
  );
  const riskReviewRaw = await chat(llm, RISK_REVIEW_SYSTEM, riskReviewPrompt);
  const riskReview = parseRiskReview(riskReviewRaw);

  if (riskReview && !riskReview.approved) {
    log.info(
      { concerns: riskReview.concerns },
      "LLM risk review rejected trade",
    );
    const snapshot = findSnapshot(snapshots, decision.market);
    if (snapshot) {
      await audit.logDecision(snapshot, decision, {
        status: "rejected",
        reason: riskReview.concerns?.join("; ") ?? "LLM risk review rejected",
      });
    }
    return;
  }

  // Apply adjusted size if provided
  const tradeSize = riskReview?.adjustedSize
    ? new Decimal(riskReview.adjustedSize)
    : new Decimal(decision.size ?? env.MAX_TRADE_SIZE_USD);

  // ── Step 6: VALIDATE (Rust risk engine) ──────────────────────────────
  log.info("step 6/7: Rust risk engine validation");

  const marketPair = findMarketPair(markets, decision.market);
  const snapshot = findSnapshot(snapshots, decision.market);

  if (!marketPair || !snapshot) {
    log.warn(
      { market: decision.market },
      "market not found in config — skipping",
    );
    return;
  }

  // Update price in risk engine
  await risk.updatePrice(marketPair.id, snapshot.price.toNumber());

  const side = decision.action === "buy" ? "long" : "short";
  const verdict = await risk.validateTrade({
    market: marketPair.id,
    side,
    size: tradeSize.toNumber(),
    price: snapshot.price.toNumber(),
    leverage: 1,
  });

  if (verdict.status !== "approved") {
    log.info(
      { reason: verdict.reason ?? "unknown" },
      "Rust risk engine rejected trade",
    );
    await audit.logDecision(snapshot, decision, {
      status: "rejected",
      reason: (verdict.reason as string) ?? "risk engine rejected",
    });
    return;
  }

  // ── Step 7: EXECUTE ──────────────────────────────────────────────────
  log.info("step 7/7: executing trade");

  const executeParams: ExecuteParams = {
    market: marketPair,
    side,
    sizeUsd: tradeSize,
    price: snapshot.price,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
  };

  const result = await executor.execute(executeParams);

  // Update risk engine with fill
  if (result.success) {
    await risk.processFill({
      market: marketPair.id,
      side,
      size: tradeSize.toNumber(),
      price: snapshot.price.toNumber(),
      fee: result.fee?.toNumber() ?? 0,
    });
  }

  // Audit log
  await audit.logDecision(
    snapshot,
    decision,
    { status: verdict.status as "approved" | "rejected" },
    result,
  );

  // Track for LLM context
  recentTrades.push(result);
  if (recentTrades.length > MAX_RECENT_TRADES) {
    recentTrades.shift();
  }

  log.info(
    {
      success: result.success,
      txHash: result.txHash,
      market: result.market,
      side: result.side,
    },
    "cycle complete",
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RiskReview {
  approved: boolean;
  adjustedSize?: number;
  concerns?: string[];
  reasoning?: string;
}

function parseRiskReview(raw: string): RiskReview | null {
  try {
    // Try direct parse
    const parsed = JSON.parse(raw) as RiskReview;
    return parsed;
  } catch {
    // Try extracting JSON from markdown fences
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as RiskReview;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function findSnapshot(
  snapshots: MarketSnapshot[],
  market: string,
): MarketSnapshot | undefined {
  const lower = market.toLowerCase();
  return (
    snapshots.find((s) => s.market.toLowerCase() === lower) ??
    snapshots.find((s) => lower.includes(s.market.toLowerCase())) ??
    snapshots[0]
  );
}

function findMarketPair(
  markets: MarketPairConfig[],
  market: string,
): MarketPairConfig | undefined {
  const lower = market.toLowerCase();
  return (
    markets.find((m) => m.id.toLowerCase() === lower) ??
    markets.find((m) =>
      lower.includes(m.baseToken.symbol.toLowerCase()),
    ) ??
    markets[0]
  );
}

function uniqueCoingeckoIds(markets: MarketPairConfig[]): string[] {
  const ids = new Set<string>();
  for (const m of markets) {
    ids.add(m.baseToken.coingeckoId);
    ids.add(m.quoteToken.coingeckoId);
  }
  return [...ids];
}

function dedupeTokens(
  tokens: { symbol: string; address: `0x${string}`; decimals: number; coingeckoId: string }[],
) {
  const seen = new Set<string>();
  return tokens.filter((t) => {
    const key = `${t.address.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
