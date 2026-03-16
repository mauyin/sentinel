# Sentinel — Autonomous DeFi Trading Agent

Autonomous DeFi trading agent for The Synthesis hackathon. Analyzes markets via Venice.ai (private LLM), validates through a Rust risk engine with circuit breaker, and executes real on-chain swaps via Uniswap and GMX. Includes a live web dashboard with SSE updates.

## Tech Stack

- **TypeScript** — Agent logic, API integrations, dashboard, CLI
- **Rust** — Risk engine (margin, PnL, limits, circuit breaker, pending state)
- **viem** — Ethereum client
- **OpenAI SDK** — Venice.ai client (OpenAI-compatible API)
- **decimal.js** — Financial math (no floating point)
- **Pino** — Structured logging
- **Zod** — Runtime validation

## Structure

```
sentinel/
├── crates/risk-engine/    # Rust: risk validation (JSON stdin/stdout CLI)
│   └── src/
│       ├── circuit.rs     # Circuit breaker state machine
│       ├── engine.rs      # Command handler, trade validation
│       ├── limits.rs      # Daily volume, drawdown, cooldown
│       ├── margin.rs      # Margin calculations
│       ├── pnl.rs         # Position PnL tracking
│       └── types.rs       # Domain types, checked arithmetic
├── src/
│   ├── config/            # Env, chains, markets (YAML config loader)
│   ├── core/              # Domain types, constants
│   ├── llm/               # Venice.ai provider, prompts, parser
│   ├── market/            # Oracle aggregator (CoinGecko + DeFiLlama), portfolio
│   ├── risk/              # TS ↔ Rust bridge (seq IDs, timeout)
│   ├── execution/         # Uniswap (slippage guard), GMX (close + pending), router
│   ├── identity/          # ERC-8004, wallet
│   ├── audit/             # Decision logging (JSONL)
│   ├── agent/             # Autonomous (circuit breaker), interactive, smoke
│   ├── dashboard/         # Embedded HTTP server, SSE, static UI
│   └── infra/             # Logger, RPC, HTTP, EventBus
├── tests/e2e/             # E2E pipeline tests
├── markets.yaml           # Config-driven market definitions
├── Dockerfile             # Multi-stage: Rust build + Node.js runtime
├── docker-compose.yml     # Single-command deployment
├── scripts/               # Registration, funding, demo
└── docs/                  # Architecture, risk model, conversation log
```

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`
- All financial math uses `decimal.js` (TypeScript) or fixed-point i128 (Rust) — NEVER floating point
- Risk engine communicates via JSON over stdin/stdout with sequence IDs
- Zod validates all external data at boundaries
- Pino for structured logging with correlation IDs

## Commands

- `pnpm dev` — Run in dev mode (tsx)
- `pnpm test` — Run TypeScript tests (103 tests)
- `cargo test` — Run Rust tests (70 tests)
- `pnpm dev -- --mode autonomous` — Autonomous trading
- `pnpm dev -- --mode interactive` — Interactive CLI
- `docker compose up` — Deploy with dashboard at localhost:3000

## Risk Engine Protocol

TypeScript spawns Rust binary, sends JSON commands via stdin with sequence IDs:
```json
{"command": "validate_trade", "payload": {...}, "seq": 0}
{"command": "process_fill", "payload": {..., "pending": true}, "seq": 1}
{"command": "check_circuit", "seq": 2}
{"command": "get_state", "seq": 3}
```

Rust responds with JSON on stdout, echoing the seq:
```json
{"status": "approved", "payload": {...}, "seq": 0}
{"status": "rejected", "reason": "circuit_breaker_open", "seq": 1}
{"status": "circuit_state", "state": "closed", "consecutive_losses": 0, "seq": 2}
```

## Circuit Breaker

State machine: Closed (trading) → Open (halted) → HalfOpen (test trade) → Closed
- Triggers: consecutive losses, equity drop rate, data staleness, manual (SIGUSR1)
- Reset goes Open → HalfOpen → Closed (requires successful trade to fully close)

## Dashboard

Embedded HTTP server at `DASHBOARD_PORT` (default 3000):
- `GET /` — Static dashboard (equity curve, positions, decisions, risk state)
- `GET /api/state` — Risk engine state JSON
- `GET /api/decisions` — Recent audit entries
- `GET /api/health` — Circuit breaker, price age, uptime
- `GET /events` — SSE stream of real-time events

## Vault

- path: ~/Desktop/vault
- context-card: 02-Projects/sentinel/ContextCard.md
- session-folder: 05-Sessions/sentinel/
