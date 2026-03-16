# Sentinel

Autonomous DeFi trading agent that combines private LLM reasoning (Venice.ai), a Rust risk engine with circuit breaker protection, and real on-chain execution across Uniswap and GMX. Every decision is validated, audited, and observable through a live web dashboard — the first autonomous trading agent that can prove every decision it made.

## Quick Start

```bash
# Clone and configure
cp .env.example .env
# Edit .env with your API keys and wallet

# Option 1: Docker (recommended)
docker compose up
# Open http://localhost:3000

# Option 2: Manual
cargo build --release          # Build Rust risk engine
pnpm install                   # Install Node.js dependencies
pnpm dev -- --mode autonomous  # Start trading
```

## Architecture

```
                         SENTINEL AGENT
                ┌────────────────────────────────────────┐
                │                                        │
  Venice.ai ◄───┤  LLM Layer ──► 7-Step Pipeline         │
  (private)  ───►│                    │                   │
                │                    ▼                   │
  CoinGecko ◄─┐│  Oracle        Circuit       Risk      │
  DeFiLlama ◄─┘│  Aggregator    Breaker       Engine    │
                │  (staleness    (Rust)        (Rust)    │
                │   + fallback)      │             │     │
                │                    ▼             │     │
                │              Execution Router    │     │
                │              (slippage guard)    │     │
                │                 │        │       │     │
                │           Uniswap    GMX V2      │     │
                │           (spot)     (perps)     │     │
                │                                  │     │
                │  EventBus ──► Dashboard (:3000)  │     │
                │           ──► Webhook Alerts     │     │
                └────────────────────────────────────────┘
```

### 7-Step Pipeline

1. **Observe** — Fetch prices from oracle aggregator (CoinGecko + DeFiLlama fallback)
2. **Analyze** — Format market data, portfolio, and risk context for LLM
3. **Reason** — Query Venice.ai for structured trade decision
4. **Confidence check** — Filter low-confidence signals (< 60/100)
5. **Risk review** — Second LLM pass for risk assessment
6. **Validate** — Rust risk engine checks margin, limits, circuit breaker
7. **Execute** — On-chain swap via Uniswap or GMX with slippage guard

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LLM_API_KEY` | Yes | — | Venice.ai API key |
| `LLM_BASE_URL` | No | `https://api.venice.ai/api/v1` | LLM endpoint (OpenAI-compatible) |
| `LLM_MODEL` | No | `llama-3.3-70b` | Model name |
| `UNISWAP_API_KEY` | Yes | — | Uniswap Trading API key |
| `AGENT_PRIVATE_KEY` | Yes | — | Wallet private key (`0x...`) |
| `BASE_RPC_URL` | No | `https://mainnet.base.org` | Base mainnet RPC |
| `ARBITRUM_RPC_URL` | No | `https://arb1.arbitrum.io/rpc` | Arbitrum One RPC |
| `MAX_TRADE_SIZE_USD` | No | `100` | Maximum single trade size in USD |
| `MAX_DAILY_VOLUME_USD` | No | `500` | Maximum daily trading volume |
| `MAX_DRAWDOWN_PCT` | No | `10` | Maximum drawdown before halt (%) |
| `COOLDOWN_SECONDS` | No | `60` | Seconds between trades |
| `INITIAL_EQUITY_USD` | No | `0` | Starting equity (`0` = auto-detect on-chain) |
| `MAX_CONSECUTIVE_LOSSES` | No | `5` | Circuit breaker: trip after N losses |
| `MAX_EQUITY_DROP_RATE_BPS` | No | `1000` | Circuit breaker: max equity drop per hour (bps) |
| `MAX_DATA_STALENESS_SECS` | No | `300` | Circuit breaker: max price data age (seconds) |
| `DASHBOARD_PORT` | No | `3000` | Web dashboard port |
| `ALERT_WEBHOOK_URL` | No | — | Discord/Slack webhook for alerts |
| `MODE` | No | `interactive` | `autonomous` \| `interactive` \| `smoke` |
| `LOG_LEVEL` | No | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` |

### Markets (`markets.yaml`)

Markets are defined in `markets.yaml` at the project root. Each market specifies:

```yaml
markets:
  - id: ETH-USDC-BASE           # Unique market identifier
    base:
      symbol: WETH
      address: "0x4200..."       # Token contract address
      decimals: 18
      coingeckoId: ethereum      # For price feeds
    quote:
      symbol: USDC
      address: "0x8335..."
      decimals: 6
      coingeckoId: usd-coin
    chainId: 8453                # Base mainnet
    venue: uniswap               # uniswap | gmx
    margin:
      initialBps: 1000           # 10% initial margin
      maintenanceBps: 500        # 5% maintenance margin
      maxLeverage: 10
    minTradeUsd: 1
```

GMX markets include additional fields:

```yaml
    venue: gmx
    gmx:
      marketAddress: "0x70d9..."
      indexToken: "0x82af..."
```

If `markets.yaml` is missing, Sentinel falls back to hardcoded ETH-USDC markets on Base and Arbitrum.

## Development

### Prerequisites

- Node.js >= 20
- Rust >= 1.77
- pnpm

### Setup

```bash
# Install dependencies
pnpm install

# Build the Rust risk engine
cargo build --release

# Copy and fill in environment
cp .env.example .env
```

### Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run in dev mode (interactive) |
| `pnpm dev -- --mode autonomous` | Autonomous trading mode |
| `pnpm dev -- --mode smoke` | Smoke test (dry run) |
| `pnpm test` | Run TypeScript tests (103 tests) |
| `cargo test` | Run Rust tests (70 tests) |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm build:risk` | Build Rust risk engine (release) |
| `pnpm demo` | Run demo script |

### Project Structure

```
sentinel/
├── crates/risk-engine/src/    # Rust risk engine
│   ├── engine.rs              #   Command handler, trade validation
│   ├── circuit.rs             #   Circuit breaker state machine
│   ├── limits.rs              #   Daily volume, drawdown, cooldown
│   ├── margin.rs              #   Margin calculations
│   ├── pnl.rs                 #   Position PnL tracking
│   └── types.rs               #   Domain types, checked arithmetic
├── src/
│   ├── agent/                 # Trading modes (autonomous, interactive)
│   ├── config/                # Env validation, chain config, YAML market loader
│   ├── core/                  # Domain types, constants
│   ├── dashboard/             # Embedded HTTP server + static web UI
│   ├── execution/             # Uniswap, GMX, execution router
│   ├── infra/                 # Logger, RPC, HTTP, EventBus
│   ├── llm/                   # Venice.ai provider, prompts, parser
│   ├── market/                # Oracle aggregator, portfolio, analyzer
│   ├── risk/                  # TypeScript <-> Rust bridge (IPC)
│   └── audit/                 # Decision logging (JSONL)
├── tests/e2e/                 # End-to-end pipeline tests
├── markets.yaml               # Market definitions
├── Dockerfile                 # Multi-stage build
└── docker-compose.yml         # Single-command deployment
```

## Dashboard

The embedded dashboard at `http://localhost:3000` provides:

- **Equity curve** — Sparkline of account value over time
- **Current positions** — Active positions with unrealized PnL
- **Recent decisions** — Timeline of LLM decisions with confidence scores
- **Risk state** — Daily volume usage, margin utilization
- **Circuit breaker** — Current state (Closed/Open/HalfOpen) with trip reason

Real-time updates via Server-Sent Events (SSE). Mobile-responsive.

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Dashboard UI |
| `GET /api/state` | Risk engine state (positions, equity, limits) |
| `GET /api/decisions` | Last 50 audit entries |
| `GET /api/health` | Circuit breaker state, price age, uptime |
| `GET /events` | SSE stream of real-time events |

## Circuit Breaker

The Rust risk engine includes a circuit breaker that halts trading when safety thresholds are breached:

```
CLOSED (trading) ──trip──► OPEN (halted) ──reset──► HALF_OPEN (test) ──win──► CLOSED
                                                                      ──loss──► OPEN
```

**Triggers** (any one trips the breaker):
- Consecutive losses exceed threshold
- Equity drops faster than configured rate per hour
- Price data becomes stale (oracle outage)
- Manual trip via `SIGUSR1` signal

## Demo

<!-- TODO: Add demo video link -->

*Demo video coming soon.*

## License

MIT
