# Sentinel - End-to-End Product Walkthrough

## The Big Picture

```
YOU (human)
 │
 │  fund wallet, set risk limits, pick mode
 │
 ▼
┌─────────────────────────────────────────────────────────────┐
│                     SENTINEL AGENT                          │
│                                                             │
│  ┌──────────┐   ┌───────────┐   ┌────────┐   ┌──────────┐ │
│  │ Observe  │──>│  Reason   │──>│ Verify │──>│ Execute  │ │
│  │ (market) │   │ (private) │   │ (risk) │   │ (on-chain│ │
│  └──────────┘   └───────────┘   └────────┘   └──────────┘ │
│       │                                           │         │
│       ▼                                           ▼         │
│  ┌──────────┐                               ┌──────────┐   │
│  │  Audit   │                               │ Identity │   │
│  │  Trail   │                               │ (ERC8004)│   │
│  └──────────┘                               └──────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## Layer by Layer

### Layer 1 — Third-Party Services (things we don't build)

| Service | What it gives us | Chain/Protocol |
|---------|-----------------|----------------|
| Venice.ai | Private LLM inference (llama-3.3-70b), zero data retention | HTTPS API |
| CoinGecko | Real-time prices, 24h volume/change/high/low | Free REST API |
| Uniswap Trading API | Spot swap quotes + execution (ETH/USDC) | Base, Arbitrum |
| GMX | Perpetual futures (ETH-USD, BTC-USD) | Arbitrum |
| Self Protocol | ZK-powered agent identity verification | Base |
| Synthesis Devfolio | Hackathon registration, ERC-8004 minting | Base |
| RPC providers | Block reads, tx submission | Base, Arbitrum |

### Layer 2 — Services We Build

| Component | Language | What it does |
|-----------|----------|-------------|
| Risk Engine | Rust | Stateful trade validation — margin, PnL, limits, cooldown. Separate binary, JSON IPC. |
| LLM Pipeline | TypeScript | Two-pass analysis: market analysis prompt → risk review prompt. Zod-validates all output. |
| Market Observer | TypeScript | Fetches prices + on-chain portfolio, formats for LLM consumption. |
| Execution Router | TypeScript | Routes approved trades to Uniswap (spot) or GMX (perps). Signs and submits txs. |
| Audit Logger | TypeScript | JSONL trail of every decision: snapshot → reasoning → verdict → tx result. |
| Risk Bridge | TypeScript | Spawns Rust binary, manages JSON stdin/stdout communication. |

### Layer 3 — The Agent Loop (what ties it all together)

Two modes:
- **Autonomous** — runs the loop on a timer (every 60s), trades without asking
- **Interactive** — human reviews each proposed trade before execution

---

## The Complete Flow (one trade cycle)

### Step 1: OBSERVE

```
CoinGecko API ──> fetchMarketSnapshots()
  → ETH: $3,412, +2.1% 24h, vol $18B
  → BTC: $97,200, -0.3% 24h, vol $42B

viem RPC ──> fetchPortfolio()
  → Wallet: 0x...abc
  → 1.2 WETH ($4,094), 5,000 USDC
  → Total: $9,094
```

### Step 2: REASON (private — Venice.ai)

```
Pass 1 — Market Analysis:
  System: "You are Sentinel, an autonomous DeFi trading agent..."
  User:   [market data + portfolio + recent trades]
  Venice: {
    "action": "buy",
    "market": "ETH-USDC-BASE",
    "size": 0.15,
    "confidence": 72,
    "reasoning": "Strong momentum with rising volume...",
    "timeHorizon": "swing",
    "riskLevel": "medium"
  }

Pass 2 — Risk Review:
  System: "You are the risk review layer..."
  User:   [proposed trade + portfolio + risk engine state]
  Venice: {
    "approved": true,
    "adjustedSize": 0.12,
    "concerns": ["portfolio already 45% ETH exposure"],
    "reasoning": "Reduce size due to concentration, otherwise sound."
  }

→ Trade decision: BUY 0.12 ETH at ~$3,412
```

### Step 3: VERIFY (Rust risk engine)

```
TS → Rust (JSON stdin):
  {"command":"validate_trade","payload":{
    "market":"ETH-USDC-BASE","side":"long",
    "size":0.12,"price":3412.0,"leverage":1.0
  }}

Rust checks (in order):
  ✓ Trade size: $409 < $500 max          (limits.rs)
  ✓ Daily volume: $409 < $2000 max       (limits.rs)
  ✓ Drawdown: 0 bps < 1000 bps max      (limits.rs)
  ✓ Cooldown: 300s since last > 60s min  (limits.rs)
  ✓ Margin: $40.9 required < $5,000 free (margin.rs)
  ✓ Leverage: 1x < 10x max
  ✓ Min size: $409 > $1 min

Rust → TS (JSON stdout):
  {"status":"approved","margin_required":40.9,"free_collateral":4959.1}
```

### Step 4: EXECUTE (on-chain)

```
Spot trade (Uniswap):
  → Uniswap API: get quote for 0.12 WETH ← USDC on Base
  → Sign tx with agent wallet private key
  → Submit via RPC
  → Tx confirmed: 0xabc123...

OR Perp trade (GMX):
  → GMX contract: open long 0.12 ETH-USD on Arbitrum
  → Sign + submit
  → Tx confirmed: 0xdef456...
```

### Step 5: RECORD

```
TS → Rust: {"command":"process_fill","payload":{
  "market":"ETH-USDC-BASE","side":"long",
  "size":0.12,"price":3412.0,"fee":1.7
}}

Rust updates state:
  → New position: ETH-USDC long 0.12 @ $3,412
  → Equity: $9,094 → $9,092.3 (after fee)
  → Peak equity updated

Audit logger writes to audit-logs/2026-03-13.jsonl:
  {
    "id": "uuid",
    "timestamp": "...",
    "marketSnapshot": { prices, portfolio },
    "decision": { action, reasoning, confidence },
    "riskVerdict": { approved, margin },
    "result": { success, txHash, price, fee }
  }
```

### Step 6: LOOP

```
Wait 60 seconds → back to Step 1
(or wait for human input in interactive mode)
```

---

## Identity Layer (runs once at startup)

```
Agent starts
  │
  ├─ ERC-8004 Registration (Synthesis Devfolio API)
  │   → On-chain agent identity on Base Mainnet
  │   → Returns: participantId, teamId, apiKey
  │   → Tx visible on BaseScan
  │
  └─ Self Protocol Verification
      → ZK proof that a human backs this agent
      → Privacy-preserving (no personal data exposed)
      → Verifiable by any counterparty on-chain
```

---

## What the Human Sees

### Interactive mode

```
$ pnpm dev -- --mode interactive

[sentinel] Starting...
[sentinel] Risk engine: started (28 checks loaded)
[sentinel] Wallet: 0x...abc (Base)
[sentinel] Portfolio: 1.2 WETH + 5,000 USDC = $9,094

[sentinel] Analyzing markets...
[sentinel] Proposal: BUY 0.12 ETH @ $3,412 (confidence: 72%)
[sentinel] Reasoning: "Strong momentum with rising volume..."
[sentinel] Risk engine: APPROVED (margin: $40.9, free: $4,959)

> Execute? (y/n): y

[sentinel] Tx submitted: 0xabc123...
[sentinel] Tx confirmed (block 12345678)
[sentinel] Position opened: ETH long 0.12 @ $3,412
```

### Autonomous mode

```
$ pnpm dev -- --mode autonomous

[sentinel] Starting autonomous loop (60s interval)...
[sentinel] Cycle 1: HOLD (confidence: 34%, below 60% threshold)
[sentinel] Cycle 2: BUY 0.08 ETH @ $3,450 → approved → 0xabc...
[sentinel] Cycle 3: HOLD
[sentinel] Cycle 4: SELL 0.08 ETH @ $3,520 → approved → 0xdef...
  → Realized PnL: +$5.60 (after fees)
```

---

## Relationship Map

```
                    ┌─────────────────┐
                    │   Human Owner   │
                    │ (funds wallet,  │
                    │  sets limits)   │
                    └────────┬────────┘
                             │ controls
                             ▼
┌─────────────┐     ┌───────────────┐     ┌──────────────┐
│  Venice.ai  │◄────│   SENTINEL    │────►│  Self Proto  │
│ (reasoning) │     │   TypeScript  │     │ (ZK identity)│
└─────────────┘     │    Agent      │     └──────────────┘
                    └───┬───┬───┬───┘
                        │   │   │
              ┌─────────┘   │   └──────────┐
              ▼             ▼              ▼
     ┌──────────────┐ ┌──────────┐ ┌────────────┐
     │ Rust Risk    │ │ Uniswap  │ │    GMX     │
     │ Engine       │ │ (spot)   │ │  (perps)   │
     │ (subprocess) │ │ Base     │ │ Arbitrum   │
     └──────────────┘ └──────────┘ └────────────┘
                           │              │
                           ▼              ▼
                    ┌─────────────────────────┐
                    │    Blockchain State     │
                    │  (Base + Arbitrum)      │
                    │  ERC-8004 identity      │
                    │  Swap/trade tx hashes   │
                    │  Token balances         │
                    └─────────────────────────┘
```

---

## What's Built vs What's Left

| Component | Status | Bounty it unlocks |
|-----------|--------|-------------------|
| Risk engine (Rust, 28 tests) | **Done** | Core requirement for all tracks |
| LLM pipeline (Venice.ai) | **Done** | Venice.ai track |
| Market data + portfolio | **Done** | — |
| Risk bridge (TS <-> Rust IPC) | **Done** | — |
| Audit logger | **Done** | Open Track (documentation) |
| Config + infra | **Done** | — |
| Uniswap execution | **Done** | Uniswap track |
| GMX execution | **Done** | bond.credit track |
| Agent loop (autonomous/interactive) | **Done** | All tracks |
| Position sizing | **Done** | Confidence-scaled, equity/volume capped |
| ERC-8004 registration | **Partial** | Open Track |
| Self Protocol identity | **WIP** | Self track |

The core pipeline (observe → reason → size → verify → execute) is fully functional. Identity registration is via the Synthesis API.
