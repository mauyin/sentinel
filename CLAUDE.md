# Sentinel — Autonomous DeFi Trading Agent

Autonomous DeFi trading agent for The Synthesis hackathon. Analyzes markets via Venice.ai (private LLM), validates through a Rust risk engine, and executes real on-chain swaps via Uniswap and GMX.

## Tech Stack

- **TypeScript** — Agent logic, API integrations, CLI
- **Rust** — Risk engine (margin, PnL, limits)
- **viem** — Ethereum client
- **OpenAI SDK** — Venice.ai client (OpenAI-compatible API)
- **decimal.js** — Financial math (no floating point)
- **Pino** — Structured logging
- **Zod** — Runtime validation

## Structure

```
sentinel/
├── crates/risk-engine/    # Rust: risk validation (JSON stdin/stdout CLI)
├── src/
│   ├── config/            # Env, chains, markets
│   ├── core/              # Domain types, constants
│   ├── llm/               # Venice.ai provider, prompts, parser
│   ├── market/            # Price feeds, portfolio, analyzer
│   ├── risk/              # TS ↔ Rust bridge
│   ├── execution/         # Uniswap, GMX, router
│   ├── identity/          # ERC-8004, wallet
│   ├── audit/             # Decision logging, on-chain anchoring
│   ├── agent/             # Autonomous, interactive, multi-agent modes
│   └── infra/             # Logger, RPC, HTTP utilities
├── scripts/               # Registration, funding, demo
└── docs/                  # Architecture, risk model, conversation log
```

## Conventions

- Conventional commits: `feat:`, `fix:`, `refactor:`, `chore:`
- All financial math uses `decimal.js` (TypeScript) or fixed-point i128 (Rust) — NEVER floating point
- Risk engine communicates via JSON over stdin/stdout
- Zod validates all external data at boundaries
- Pino for structured logging with correlation IDs

## Commands

- `pnpm dev` — Run in dev mode (tsx)
- `pnpm test` — Run TypeScript tests
- `cargo test` — Run Rust tests (from sentinel/ root)
- `pnpm dev -- --mode autonomous` — Autonomous trading
- `pnpm dev -- --mode interactive` — Interactive CLI

## Risk Engine Protocol

TypeScript spawns Rust binary, sends JSON commands via stdin:
```json
{"command": "validate_trade", "payload": {...}}
{"command": "process_fill", "payload": {...}}
{"command": "update_price", "payload": {...}}
{"command": "get_state"}
```

Rust responds with JSON on stdout:
```json
{"status": "approved", "payload": {...}}
{"status": "rejected", "reason": "max_drawdown_exceeded"}
```

## Vault

- path: ~/Desktop/vault
- context-card: 02-Projects/sentinel/ContextCard.md
- session-folder: 05-Sessions/sentinel/
