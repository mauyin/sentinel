# The Synthesis - Hackathon Themes

Four core themes define what the hackathon wants builders to explore. Sentinel targets **all four**.

---

## 1. Agents that Pay

> "What happens when agents move your money?"

The problem: when agents handle financial transactions, users can't scope spending limits, verify transactions executed correctly, or guarantee settlement without intermediaries.

**Sentinel's alignment:** Our agent autonomously executes real on-chain swaps (Uniswap) and perpetual futures trades (GMX). The Rust risk engine enforces hard spending limits, max drawdown, and position sizing — providing exactly the transparency and guardrails this theme demands.

---

## 2. Agents that Trust

> "How do you trust something without a face?"

The problem: agents depend on centralized registries and API providers. If access is revoked or services shut down, the agent breaks. Trust needs to be decentralized.

**Sentinel's alignment:** ERC-8004 on-chain identity, Venice.ai's no-data-retention inference (no centralized AI provider lock-in), and Self Protocol's ZK-powered identity verification. Trust is cryptographic, not platform-dependent.

---

## 3. Agents that Cooperate

> "Can machines keep promises?"

The problem: when agents broker deals, platforms can unilaterally rewrite terms. There's no neutral enforcement layer for agent-to-agent agreements.

**Sentinel's alignment:** All trades execute through immutable smart contracts (Uniswap, GMX). The risk engine's decisions are deterministic and auditable. Every action is logged with correlation IDs for full traceability.

---

## 4. Agents that Keep Secrets

> "What secrets does your agent share?"

The problem: API calls, service payments, and contract interactions create metadata about spending patterns, contacts, and behavior — compromising user privacy.

**Sentinel's alignment:** Venice.ai provides private LLM inference with zero data retention. Trading strategies and analysis happen in a private cognition layer. Only the final on-chain execution is public.

---

## Prize Tracks

### Synthesis Open Track
Community-funded open track. AI agents and humans judge submissions. Projects aligned with the four core themes score highest.

### Partner Tracks
Smaller targeted bounties for using specific partner tools. See `partner-bounties.md` for full details.
