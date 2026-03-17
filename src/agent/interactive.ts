import { createInterface, type Interface } from "node:readline";
import type { AgentDeps } from "./autonomous.js";
import { chat } from "../llm/provider.js";
import { parseTradeDecision } from "../llm/parser.js";
import {
  MARKET_ANALYSIS_SYSTEM,
  RISK_REVIEW_SYSTEM,
  buildMarketAnalysisPrompt,
  buildRiskReviewPrompt,
  formatStrategyMemory,
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

const log = childLogger({ component: "interactive" });

export async function runInteractive(deps: AgentDeps): Promise<void> {
  const recentTrades: TradeResult[] = [];

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  log.info("interactive mode started — type 'q' to quit");
  process.stdout.write("\n=== Sentinel — Interactive DeFi Trading Agent ===\n");
  process.stdout.write("Commands: [enter] run analysis | [q] quit\n\n");

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
      process.stdout.write("\nError during analysis. See logs for details.\n\n");
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
  log.info("fetching market data");
  const coingeckoIds = [
    ...new Set(markets.flatMap((m) => [m.baseToken.coingeckoId, m.quoteToken.coingeckoId])),
  ];
  const [snapshots, prices] = await Promise.all([
    fetchMarketSnapshots(coingeckoIds),
    fetchPrices(coingeckoIds),
  ]);

  if (snapshots.length === 0) {
    log.warn("no market data available");
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

  process.stdout.write("\n--- Market Data ---\n");
  process.stdout.write(marketData + "\n");
  process.stdout.write("\n--- Portfolio ---\n");
  process.stdout.write(portfolioData + "\n");

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
  log.info("querying LLM for trade decision");
  const tradesData = formatRecentTrades(recentTrades);
  const riskContextStr = formatRiskContext(riskCtx);

  // Strategy memory for context
  const recentAuditEntries = audit.getRecentEntries(10);
  const strategyMemory = formatStrategyMemory(recentAuditEntries);

  const userPrompt = buildMarketAnalysisPrompt(
    marketData,
    portfolioData,
    tradesData,
    riskContextStr,
    strategyMemory,
  );

  let rawResponse: string;
  try {
    rawResponse = await chat(llm, MARKET_ANALYSIS_SYSTEM, userPrompt);
  } catch (err) {
    log.error({ err }, "LLM request failed");
    process.stdout.write("\nLLM unavailable. Try again later.\n\n");
    return;
  }

  const decision = parseTradeDecision(rawResponse);

  if (!decision) {
    log.warn("LLM returned unparseable response");
    return;
  }

  process.stdout.write("\n--- Trade Decision ---\n");
  process.stdout.write(`  Action:     ${decision.action}\n`);
  process.stdout.write(`  Market:     ${decision.market}\n`);
  process.stdout.write(`  Confidence: ${decision.confidence}%\n`);
  process.stdout.write(`  Size (raw): ${decision.size ?? "N/A"}\n`);
  process.stdout.write(`  Reasoning:  ${decision.reasoning}\n`);

  if (decision.action === "hold") {
    log.info("LLM recommends HOLD");
    const snapshot = snapshots[0];
    if (snapshot) {
      await audit.logDecision(snapshot, decision, { status: "approved" });
    }
    return;
  }

  // Handle close action
  if (decision.action === "close") {
    const marketPair =
      markets.find((m) => m.id.toLowerCase() === decision.market.toLowerCase()) ??
      markets.find((m) =>
        decision.market.toLowerCase().includes(m.baseToken.symbol.toLowerCase()),
      ) ??
      markets[0]!;

    const snapshot = snapshots.find(
      (s) => s.market.toLowerCase() === decision.market.toLowerCase(),
    ) ?? snapshots[0]!;

    const position = riskCtx.openPositions.find(
      (p) => p.market.toLowerCase() === marketPair.id.toLowerCase(),
    );

    if (!position) {
      log.info({ market: decision.market }, "no open position to close");
      process.stdout.write("\nNo open position to close.\n\n");
      await audit.logDecision(snapshot, decision, { status: "rejected", reason: "no open position" });
      return;
    }

    const answer = await prompt(
      rl,
      `\nClose ${position.side} ${position.size} USD on ${marketPair.id}? (y/n): `,
    );

    if (answer.toLowerCase() !== "y") {
      log.info("user declined close");
      await audit.logDecision(snapshot, decision, { status: "rejected", reason: "user declined" });
      return;
    }

    const side = position.side as "long" | "short";
    const size = new Decimal(position.size);

    await risk.updatePrice(marketPair.id, snapshot.price.toNumber());

    const result = await executor.closePosition({
      market: marketPair,
      side,
      size,
      price: snapshot.price,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });

    if (result.success) {
      const oppositeSide = side === "long" ? "short" : "long";
      await risk.processFill({
        market: marketPair.id,
        side: oppositeSide,
        size: size.toNumber(),
        price: snapshot.price.toNumber(),
        fee: result.fee?.toNumber() ?? 0,
      });
    }

    await audit.logDecision(snapshot, decision, { status: result.success ? "approved" : "rejected" }, result);
    recentTrades.push(result);
    if (recentTrades.length > 20) recentTrades.shift();

    process.stdout.write(`\n--- Close Result ---\n`);
    process.stdout.write(`  Success: ${result.success}\n`);
    process.stdout.write(`  TxHash:  ${result.txHash ?? "N/A"}\n`);
    if (result.error) process.stdout.write(`  Error:   ${result.error}\n`);
    process.stdout.write("\n");
    return;
  }

  // Step 3: Risk review
  log.info("running LLM risk review");
  const riskReviewPrompt = buildRiskReviewPrompt(
    JSON.stringify(decision),
    portfolioData,
    JSON.stringify(riskState),
  );

  let riskApproved = true;
  try {
    const riskReviewRaw = await chat(llm, RISK_REVIEW_SYSTEM, riskReviewPrompt);
    const riskReview = JSON.parse(
      riskReviewRaw.match(/\{[\s\S]*\}/)?.[0] ?? riskReviewRaw,
    );
    if (riskReview && !riskReview.approved) {
      log.info({ concerns: riskReview.concerns }, "LLM risk review rejected");
      process.stdout.write(`\nLLM Risk Review REJECTED: ${riskReview.concerns?.join("; ")}\n`);
      riskApproved = false;
    }
  } catch {
    log.warn("could not parse LLM risk review — proceeding with caution");
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

  process.stdout.write(`\n--- Position Sizing ---\n`);
  process.stdout.write(`  ${sizerResult.reasoning}\n`);

  if (tradeSize.lessThanOrEqualTo(0)) {
    log.info("no trade capacity available");
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

  process.stdout.write(`\n--- Risk Engine Verdict ---\n`);
  process.stdout.write(`  Status: ${verdict.status}\n`);
  if (verdict.status !== "approved") {
    process.stdout.write(`  Reason: ${verdict.reason ?? "unknown"}\n`);
    await audit.logDecision(snapshot, decision, {
      status: "rejected",
      reason: (verdict.reason as string) ?? "risk engine rejected",
    });

    if (!riskApproved) {
      log.info("both LLM and Rust risk engine rejected");
      return;
    }
  }

  if (verdict.status !== "approved") {
    log.info("risk engine rejected the trade");
    return;
  }

  // Step 5: Ask user for confirmation
  const answer = await prompt(
    rl,
    `\nExecute ${side} ${tradeSize} USD on ${marketPair.id}? (y/n/q): `,
  );

  if (answer.toLowerCase() === "q") {
    return;
  }

  if (answer.toLowerCase() !== "y") {
    log.info("user declined trade");
    await audit.logDecision(snapshot, decision, {
      status: "rejected",
      reason: "user declined",
    });
    return;
  }

  // Step 6: Execute
  log.info("executing trade");
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

  process.stdout.write(`\n--- Result ---\n`);
  process.stdout.write(`  Success: ${result.success}\n`);
  process.stdout.write(`  TxHash:  ${result.txHash ?? "N/A"}\n`);
  if (result.error) process.stdout.write(`  Error:   ${result.error}\n`);
  process.stdout.write("\n");
}

function prompt(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}
