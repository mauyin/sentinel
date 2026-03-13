# Sentinel - Product Overview

## What is Sentinel?

Sentinel is an autonomous DeFi trading agent that makes real on-chain trades with institutional-grade risk management. It analyzes markets using private AI (Venice.ai), validates every decision through a Rust risk engine, and executes swaps and perpetual futures trades on Uniswap and GMX.

**One sentence:** An AI agent that trades crypto autonomously with hard risk limits, private reasoning, and full auditability.

---

## The Problem

Today's trading bots are either:
- **Dumb** — simple rules (grid bots, DCA) with no market understanding
- **Opaque** — black-box AI with no verifiable risk controls
- **Leaky** — strategies exposed to API providers, centralized services, or plaintext logs

None of them are truly autonomous agents with both intelligence and discipline.

---

## How Sentinel is Different

### 1. Private Cognition, Public Execution

Market analysis and trading strategy happen through Venice.ai's no-data-retention LLM. Your alpha stays private. Only the final on-chain trades are visible.

### 2. Institutional Risk Engine

A purpose-built Rust risk engine enforces hard limits before every trade:
- **Margin checks** — initial and maintenance margin per position
- **Position limits** — max trade size, max daily volume
- **Drawdown protection** — automatic halt at configurable loss threshold
- **Cooldown enforcement** — minimum time between trades
- **Full PnL tracking** — unrealized/realized P&L, weighted average entries

The agent literally cannot bypass these limits. The risk engine is a separate binary that validates every trade via JSON IPC.

### 3. Complete Audit Trail

Every decision is logged with full context: market snapshot, LLM reasoning, risk verdict, execution result, timestamps. JSONL format, daily files, append-only.

### 4. Real On-Chain Execution

No mocks. No paper trading. Real swaps on Uniswap, real perpetual futures on GMX, real transaction hashes on Base and Arbitrum.

### 5. On-Chain Identity

The agent has a verifiable on-chain identity via ERC-8004 on Base Mainnet, plus ZK-powered human-backed verification via Self Protocol.

---

## Architecture at a Glance

```
Market Data ──> Venice.ai LLM ──> Rust Risk Engine ──> Uniswap/GMX
 (CoinGecko)    (private analysis)  (hard validation)    (on-chain)
                                         │
                                    Audit Logger
                                    (every decision)
```

See `architecture.md` for the full technical deep-dive.

---

## Hackathon Theme Alignment

| Theme | How Sentinel Addresses It |
|-------|---------------------------|
| **Agents that Pay** | Autonomous on-chain trading with hard spending limits and margin controls |
| **Agents that Trust** | ERC-8004 identity, ZK verification (Self Protocol), decentralized execution |
| **Agents that Cooperate** | Deterministic risk engine, immutable smart contract execution, auditable decisions |
| **Agents that Keep Secrets** | Venice.ai zero-retention inference, private strategy reasoning |

---

## Target Bounties

| Track | Partner | Why We Fit |
|-------|---------|------------|
| Private Agents, Trusted Actions | Venice.ai | Venice.ai is our LLM — private cognition for an on-chain risk desk |
| Agentic Finance | Uniswap | Uniswap API for autonomous swaps with real TxIDs |
| Agents that Pay | bond.credit x GMX | Live GMX perpetual futures trading (hard requirement) |
| Best Self Agent ID | Self Protocol | ZK-verified agent identity |
| Best Use of Locus | Locus | Agent wallet spending controls |
| Best Use of Delegations | MetaMask | Scoped trading permissions via delegation framework |
| Open Track | Synthesis | Hits all four themes |

---

## Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Agent logic | TypeScript | Rapid API integration, async I/O |
| Risk engine | Rust | Deterministic fixed-point math, crash isolation |
| LLM | Venice.ai (llama-3.3-70b) | Private inference, OpenAI-compatible API |
| Financial math | decimal.js + i128 | No floating point anywhere |
| Chain interaction | viem | Type-safe Ethereum client |
| Validation | Zod | Runtime schema validation at all boundaries |
| Logging | Pino | Structured JSON logging with correlation IDs |
| Execution | Uniswap API + GMX | Real on-chain swaps and perpetual futures |
| Identity | ERC-8004 + Self Protocol | On-chain + ZK-verified agent identity |

---

## Key Differentiators for Judges

1. **Not a wrapper** — The agent has a real Rust risk engine with 28 tests, not just an LLM calling APIs
2. **Private by design** — Venice.ai means strategies never leave the inference session
3. **Financially rigorous** — Fixed-point arithmetic, margin model, drawdown protection
4. **Multi-venue** — Spot (Uniswap) + perpetuals (GMX) execution
5. **Fully auditable** — Every decision has a paper trail
6. **Open source** — All code public on GitHub
