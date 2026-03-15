import { createInterface, type Interface } from "node:readline";
import type { AgentDeps } from "./autonomous.js";
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
  formatRiskContext,
  type RiskContextData,
} from "../market/analyzer.js";
import { computeTradeSize, resolveProposedSizeUsd } from "../risk/sizer.js";
import { getPublicClient, getAccount } from "../infra/rpc.js";
import { childLogger } from "../infra/logger.js";
import { Decimal } from "../core/types.js";
import type { ExecuteParams } from "../execution/router.js";
import type { TradeResult } from "../core/types.js";
import {
  DEFAULT_SLIPPAGE_BPS,
  DEFAULT_DEADLINE_SECONDS,
} from "../core/constants.js";

export async function runInteractive(deps: AgentDeps): Promise<void> {
  const log = childLogger({ component: "interactive" });
  const recentTrades: TradeResult[] = [];

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  log.info("interactive mode started — type 'q' to quit");
  console.log("\n=== Sentinel — Interactive DeFi Trading Agent ===\n");
  console.log("Commands: [enter] run analysis | [q] quit\n");

  let running = true;

  while (running) {
    const input = await prompt(rl, "sentinel> ");
    const cmd = input.trim().toLowerCase();

    if (cmd === "q" || cmd === "quit" || cmd === "exit") {
      running = false;
      break;
    }

    try {
      await runInteractiveCycle(deps, recentTrades, rl);
    } catch (err) {
      log.error({ err }, "interactive cycle failed");
      console.error("\nError during analysis. See logs for details.\n");
    }
  }

  rl.close();
  log.info("interactive mode stopped");
}

async function runInteractiveCycle(
  deps: AgentDeps,
  recentTrades: TradeResult[],
  rl: Interface,
): Promise<void> {
  const { env, llm, risk, audit, executor, markets } = deps;
  const account = getAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);

  // Step 1: Fetch market data
  console.log("\nFetching market data...");
  const coingeckoIds = [
    ...new Set(markets.flatMap((m) => [m.baseToken.coingeckoId, m.quoteToken.coingeckoId])),
  ];
  const [snapshots, prices] = await Promise.all([
    fetchMarketSnapshots(coingeckoIds),
    fetchPrices(coingeckoIds),
  ]);

  if (snapshots.length === 0) {
    console.log("No market data available. Try again later.\n");
    return;
  }

  // Fetch portfolio
  const primaryMarket = markets[0]!;
  const client = getPublicClient(primaryMarket.chainId);
  const allTokens = markets
    .filter((m) => m.chainId === primaryMarket.chainId)
    .flatMap((m) => [m.baseToken, m.quoteToken]);
  const seen = new Set<string>();
  const uniqueTokens = allTokens.filter((t) => {
    const key = t.address.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const portfolio = await fetchPortfolio(
    client,
    account.address,
    uniqueTokens,
    primaryMarket.chainId,
    prices,
  );

  // Display market data
  const marketData = formatMarketData(snapshots);
  const portfolioData = formatPortfolio(portfolio);

  console.log("\n--- Market Data ---");
  console.log(marketData);
  console.log("\n--- Portfolio ---");
  console.log(portfolioData);

  // Fetch risk state for context
  const riskState = await risk.getState();
  const riskCtx: RiskContextData = {
    equityUsd: Number(riskState.equity ?? 0),
    maxTradeSizeUsd: env.MAX_TRADE_SIZE_USD,
    maxDailyVolumeUsd: env.MAX_DAILY_VOLUME_USD,
    dailyVolumeUsedUsd: Number(riskState.daily_volume ?? 0),
    maxDrawdownPct: env.MAX_DRAWDOWN_PCT,
    openPositions: Array.isArray(riskState.positions)
      ? (riskState.positions as { market: string; side: string; size: number; entry_price: number; unrealized_pnl: number }[]).map((p) => ({
          market: p.market,
          side: p.side,
          size: p.size,
          entryPrice: p.entry_price,
          unrealizedPnl: p.unrealized_pnl,
        }))
      : [],
  };

  // Step 2: LLM analysis
  console.log("\nAnalyzing with LLM...");
  const tradesData = formatRecentTrades(recentTrades);
  const riskContextStr = formatRiskContext(riskCtx);
  const userPrompt = buildMarketAnalysisPrompt(
    marketData,
    portfolioData,
    tradesData,
    riskContextStr,
  );

  const rawResponse = await chat(llm, MARKET_ANALYSIS_SYSTEM, userPrompt);
  const decision = parseTradeDecision(rawResponse);

  if (!decision) {
    console.log("LLM returned unparseable response. Skipping.\n");
    return;
  }

  console.log("\n--- Trade Decision ---");
  console.log(`  Action:     ${decision.action}`);
  console.log(`  Market:     ${decision.market}`);
  console.log(`  Confidence: ${decision.confidence}%`);
  console.log(`  Size (raw): ${decision.size ?? "N/A"}`);
  console.log(`  Reasoning:  ${decision.reasoning}`);

  if (decision.action === "hold") {
    console.log("\nLLM recommends HOLD. No trade to execute.\n");
    const snapshot = snapshots[0];
    if (snapshot) {
      await audit.logDecision(snapshot, decision, { status: "approved" });
    }
    return;
  }

  // Step 3: Risk review
  console.log("\nRunning risk review...");
  const riskReviewPrompt = buildRiskReviewPrompt(
    JSON.stringify(decision),
    portfolioData,
    JSON.stringify(riskState),
  );
  const riskReviewRaw = await chat(llm, RISK_REVIEW_SYSTEM, riskReviewPrompt);

  let riskApproved = true;
  try {
    const riskReview = JSON.parse(
      riskReviewRaw.match(/\{[\s\S]*\}/)?.[0] ?? riskReviewRaw,
    );
    if (riskReview && !riskReview.approved) {
      console.log(`\nLLM Risk Review REJECTED: ${riskReview.concerns?.join("; ")}`);
      riskApproved = false;
    }
  } catch {
    console.log("Could not parse risk review — proceeding with caution.");
  }

  // Step 4: Rust risk engine
  const marketPair =
    markets.find((m) => m.id.toLowerCase() === decision.market.toLowerCase()) ??
    markets.find((m) =>
      decision.market.toLowerCase().includes(m.baseToken.symbol.toLowerCase()),
    ) ??
    markets[0]!;

  const snapshot =
    snapshots.find(
      (s) => s.market.toLowerCase() === decision.market.toLowerCase(),
    ) ?? snapshots[0]!;

  const side = decision.action === "buy" ? "long" : "short";

  // Position sizing
  const proposedSizeUsd = resolveProposedSizeUsd(decision.size, snapshot.price);
  const sizerResult = computeTradeSize({
    proposedSizeUsd,
    confidence: decision.confidence,
    maxTradeSizeUsd: new Decimal(env.MAX_TRADE_SIZE_USD),
    equityUsd: new Decimal(riskCtx.equityUsd),
    dailyVolumeUsedUsd: new Decimal(riskCtx.dailyVolumeUsedUsd),
    maxDailyVolumeUsd: new Decimal(env.MAX_DAILY_VOLUME_USD),
  });
  const tradeSize = sizerResult.sizeUsd;

  console.log(`\n--- Position Sizing ---`);
  console.log(`  ${sizerResult.reasoning}`);

  if (tradeSize.lessThanOrEqualTo(0)) {
    console.log("\nNo trade capacity available. Skipping.\n");
    return;
  }

  await risk.updatePrice(marketPair.id, snapshot.price.toNumber());
  const verdict = await risk.validateTrade({
    market: marketPair.id,
    side,
    size: tradeSize.toNumber(),
    price: snapshot.price.toNumber(),
    leverage: 1,
  });

  console.log(`\n--- Risk Engine Verdict ---`);
  console.log(`  Status: ${verdict.status}`);
  if (verdict.status !== "approved") {
    console.log(`  Reason: ${verdict.reason ?? "unknown"}`);
    await audit.logDecision(snapshot, decision, {
      status: "rejected",
      reason: (verdict.reason as string) ?? "risk engine rejected",
    });

    if (!riskApproved) {
      console.log("\nBoth LLM and Rust risk engine rejected. Skipping.\n");
      return;
    }
  }

  if (verdict.status !== "approved") {
    console.log("\nRisk engine rejected the trade.\n");
    return;
  }

  // Step 5: Ask user for confirmation
  const answer = await prompt(
    rl,
    `\nExecute ${side} ${tradeSize} USD on ${marketPair.id}? (y/n/q): `,
  );

  if (answer.toLowerCase() === "q") {
    console.log("Quitting.\n");
    return;
  }

  if (answer.toLowerCase() !== "y") {
    console.log("Trade skipped.\n");
    await audit.logDecision(snapshot, decision, {
      status: "rejected",
      reason: "user declined",
    });
    return;
  }

  // Step 6: Execute
  console.log("\nExecuting trade...");
  const executeParams: ExecuteParams = {
    market: marketPair,
    side,
    sizeUsd: tradeSize,
    price: snapshot.price,
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
  };

  const result = await executor.execute(executeParams);

  if (result.success) {
    await risk.processFill({
      market: marketPair.id,
      side,
      size: tradeSize.toNumber(),
      price: snapshot.price.toNumber(),
      fee: result.fee?.toNumber() ?? 0,
    });
  }

  await audit.logDecision(
    snapshot,
    decision,
    { status: verdict.status as "approved" | "rejected" },
    result,
  );

  recentTrades.push(result);
  if (recentTrades.length > 20) recentTrades.shift();

  console.log(`\n--- Result ---`);
  console.log(`  Success: ${result.success}`);
  console.log(`  TxHash:  ${result.txHash ?? "N/A"}`);
  if (result.error) console.log(`  Error:   ${result.error}`);
  console.log();
}

function prompt(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}
