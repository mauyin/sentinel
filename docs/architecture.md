# Sentinel - System Architecture

Autonomous DeFi trading agent that analyzes markets via Venice.ai (private LLM), validates through a Rust risk engine, and executes real on-chain swaps via Uniswap and GMX perpetuals.

---

## System Overview

```
                        +------------------+
                        |   Venice.ai LLM  |
                        | (private, no-log)|
                        +--------+---------+
                                 |
                                 | analysis + risk review
                                 v
+------------+    prices    +-----------+    JSON IPC    +----------------+
| CoinGecko  | ----------> |           | <-----------> | Rust Risk      |
| Price Feed |             | TypeScript|               | Engine         |
+------------+             | Agent     |               | (margin, PnL,  |
                           | Core      |               |  limits, state)|
+------------+    balance   |           |               +----------------+
| RPC / viem | ----------> |           |
| (Base, Arb)|             +-----------+
+------------+                 |   |
                    swap/trade |   | audit log
                               v   v
                    +----------+ +----------+
                    | Uniswap  | | JSONL    |
                    | / GMX    | | Audit    |
                    | on-chain | | Trail    |
                    +----------+ +----------+
```

---

## Two-Tier Architecture

### TypeScript Layer (Agent Logic)

Handles: LLM integration, market data, portfolio tracking, execution routing, CLI modes, audit logging.

### Rust Layer (Risk Engine)

Handles: margin calculation, PnL tracking, position management, trade limits, cooldown enforcement. Communicates via JSON stdin/stdout as a child process.

**Why two languages?** TypeScript for rapid API integration and async I/O. Rust for deterministic, zero-allocation financial math with fixed-point i128 arithmetic (no floating point).

---

## Module Map

```
sentinel/
├── crates/risk-engine/        # Rust risk validation binary
│   └── src/
│       ├── main.rs            # JSON IPC server (stdin/stdout)
│       ├── lib.rs             # Public crate API
│       ├── engine.rs          # Risk engine state machine
│       ├── margin.rs          # Initial & maintenance margin
│       ├── pnl.rs             # Unrealized/realized PnL, position fills
│       ├── limits.rs          # Trade size, volume, drawdown, cooldown
│       └── types.rs           # Decimal(i128), Side, Command, Response
│
├── src/
│   ├── index.ts               # CLI entry: mode selection (autonomous/interactive)
│   │
│   ├── config/
│   │   ├── env.ts             # Zod-validated env vars (fail-fast on startup)
│   │   ├── chains.ts          # Base, Base Sepolia, Arbitrum, Arbitrum Sepolia
│   │   └── markets.ts         # Token configs, market pairs, margin params
│   │
│   ├── core/
│   │   ├── types.ts           # Domain types (Decimal, TradeDecision, etc.)
│   │   └── constants.ts       # API URLs, contract addresses, agent defaults
│   │
│   ├── llm/
│   │   ├── provider.ts        # Venice.ai client (OpenAI-compatible SDK)
│   │   ├── prompts.ts         # System prompts: market analysis + risk review
│   │   └── parser.ts          # Extract & validate JSON from LLM responses
│   │
│   ├── market/
│   │   ├── feed.ts            # CoinGecko price feed (snapshots, prices)
│   │   ├── analyzer.ts        # Format market data for LLM consumption
│   │   └── portfolio.ts       # On-chain balance fetching (native + ERC-20)
│   │
│   ├── risk/
│   │   ├── bridge.ts          # TS <-> Rust IPC bridge (spawn, send, receive)
│   │   └── sizer.ts           # Programmatic position sizing (confidence, equity, volume caps)
│   │
│   ├── execution/             # Uniswap (spot) + GMX (perps) trade execution
│   ├── identity/              # ERC-8004 registration + wallet utils
│   ├── agent/                 # Autonomous loop, interactive REPL, smoke test
│   │
│   ├── audit/
│   │   └── logger.ts          # JSONL decision trail (daily files)
│   │
│   └── infra/
│       ├── logger.ts          # Pino structured logging (JSON in prod)
│       ├── rpc.ts             # viem PublicClient/WalletClient with retry
│       └── http.ts            # HTTP GET/POST with retry + timeout
│
├── scripts/
│   ├── register.ts            # ERC-8004 hackathon registration
│   ├── fund-wallet.ts         # Fund agent wallet
│   └── demo.ts                # Demo script
│
└── docs/                      # Architecture, requirements, partner info
```

---

## Data Flow

### Trade Decision Pipeline

```
1. OBSERVE   CoinGecko → fetchMarketSnapshots() → MarketSnapshot[]
                viem   → fetchPortfolio()       → PortfolioSnapshot
                                 ↓
2. ANALYZE   formatMarketData() + formatPortfolio() → prompt string
                                 ↓
             Venice.ai chat() → raw LLM response
                                 ↓
3. PARSE     parseTradeDecision() → TradeDecision (Zod validated)
             (confidence < 60 → hold, skip execution)
                                 ↓
4. REVIEW    Venice.ai risk review → { approved, adjustedSize, concerns }
                                 ↓
5. VALIDATE  RiskBridge.validateTrade() → JSON → Rust engine
             Rust checks: margin → limits → leverage → min size
             Returns: Approved { margin, free_collateral } | Rejected { reason }
                                 ↓
6. EXECUTE   Uniswap API swap / GMX perp trade → TxHash
                                 ↓
7. RECORD    RiskBridge.processFill() → update Rust state (positions, PnL)
             AuditLogger.logDecision() → JSONL file
```

### Risk Engine IPC Protocol

```
TypeScript (RiskBridge)                    Rust (main.rs → RiskEngine)
       |                                          |
       |--- spawn child process ------------------>|
       |                                          |
       |--- {"command":"validate_trade",  ------->|
       |     "payload":{market,side,size,         |--- validate_trade()
       |      price,leverage}}                    |    margin::pre_trade_check()
       |                                          |    limits::check_trade()
       |<-- {"status":"approved",  ---------------|
       |     "margin_required":"...",             |
       |     "free_collateral":"..."}             |
       |                                          |
       |--- {"command":"process_fill", ---------> |--- process_fill()
       |     "payload":{market,side,size,         |    pnl::process_fill()
       |      price,fee}}                         |    update equity, peak
       |                                          |
       |<-- {"status":"fill_processed",  ---------|
       |     "realized_pnl":"...",                |
       |     "equity":"..."}                      |
```

---

## Risk Engine Internals

### Margin Model

```
initial_margin   = notional * initial_margin_rate
                 = (size * price) * (initial_margin_bps / 10000)

maintenance_margin = notional * maintenance_margin_rate

free_collateral  = effective_equity - total_maintenance_margin
effective_equity = equity + sum(unrealized_pnl)

pre_trade_check: free_collateral - initial_margin >= 0
```

### Limit Enforcement (checked in order)

1. **Max trade size** — single trade notional cap
2. **Max daily volume** — rolling 24h notional (resets UTC midnight)
3. **Max drawdown** — basis points from peak equity
4. **Cooldown timer** — minimum seconds between trades

### PnL Calculation

```
unrealized_pnl:
  Long:  (current_price - entry_price) * size
  Short: (entry_price - current_price) * size

process_fill (5 cases):
  1. No position → open new
  2. Same side  → weighted average entry, increase size
  3. Opposite, partial  → reduce position, realize PnL
  4. Opposite, exact    → close position, realize PnL
  5. Opposite, overshoot → close + flip, realize PnL from close portion

realized_pnl = signed_price_diff * close_size - fee
```

### Fixed-Point Arithmetic

Both layers avoid floating-point:
- **TypeScript:** `decimal.js` library (arbitrary precision)
- **Rust:** `Decimal(i128)` with 10^8 scale factor

---

## External Services

| Service | Protocol | Purpose | Auth |
|---------|----------|---------|------|
| Venice.ai | HTTPS (OpenAI SDK) | Private LLM inference | API key |
| CoinGecko | HTTPS REST | Price feed (free tier) | None |
| Uniswap Trading API | HTTPS REST | Swap quotes & execution | API key |
| GMX | On-chain (viem) | Perpetual futures | Wallet key |
| RPC (Alchemy/etc.) | JSON-RPC | Chain reads & tx submission | RPC URL |
| Synthesis Devfolio | HTTPS REST | Hackathon registration | Bearer token |

---

## Chain Support

| Chain | ID | Use Case | Testnet |
|-------|----|----------|---------|
| Base | 8453 | Primary execution (Uniswap, ERC-8004) | No |
| Base Sepolia | 84532 | Testing | Yes |
| Arbitrum One | 42161 | GMX perpetuals | No |
| Arbitrum Sepolia | 421614 | GMX testing | Yes |

---

## Key Design Decisions

1. **Risk engine as subprocess** — Crash isolation. If Rust panics, TS agent survives. Clear protocol boundary.
2. **No floating point** — Financial math must be deterministic. `decimal.js` + `i128` fixed-point everywhere.
3. **Two-LLM architecture** — First LLM analyzes market and proposes trades. Second LLM reviews the proposal against risk state. Both private via Venice.ai.
4. **Zod at boundaries** — All external data (env vars, API responses, LLM output) validated on entry. Fail fast, fail loud.
5. **JSONL audit trail** — Every decision logged with full context (snapshot → decision → verdict → result). Daily files, append-only.
6. **Conservative defaults** — 60% confidence threshold, hold bias, 60s cooldown. The agent errs on the side of not trading.

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Risk engine (Rust) | Done | 28 tests, 0 warnings |
| Config / env | Done | Zod validation, fail-fast |
| LLM integration | Done | Venice.ai provider, prompts, parser |
| Market data | Done | CoinGecko feed, portfolio fetching |
| Risk bridge (TS) | Done | JSON IPC with Rust binary |
| Audit logger | Done | JSONL daily files |
| Infrastructure | Done | Logger, RPC, HTTP with retries |
| Execution (Uniswap) | **Done** | Uniswap Trading API — quote, permit2, swap |
| Execution (GMX) | **Done** | GMX V2 ExchangeRouter multicall |
| Identity (ERC-8004) | **Partial** | Read-only registration check; write via Synthesis API |
| Agent modes | **Done** | Autonomous loop, interactive REPL, smoke test |
| Position sizing | **Done** | Programmatic sizer with confidence scaling, equity/volume caps |
| Multi-agent | WIP | Not started |
