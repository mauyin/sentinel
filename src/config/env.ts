import { z } from "zod";

const envSchema = z.object({
  // LLM
  LLM_BASE_URL: z.string().url().default("https://api.venice.ai/api/v1"),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default("llama-3.3-70b"),

  // Uniswap
  UNISWAP_API_KEY: z.string().min(1),

  // Chain RPCs
  BASE_RPC_URL: z.string().url().default("https://mainnet.base.org"),
  BASE_SEPOLIA_RPC_URL: z.string().url().default("https://sepolia.base.org"),
  ARBITRUM_RPC_URL: z.string().url().default("https://arb1.arbitrum.io/rpc"),
  ARBITRUM_SEPOLIA_RPC_URL: z
    .string()
    .url()
    .default("https://sepolia-rollup.arbitrum.io/rpc"),

  // Agent wallet
  AGENT_PRIVATE_KEY: z.string().startsWith("0x").min(66).max(66),

  // Risk parameters
  MAX_TRADE_SIZE_USD: z.coerce.number().positive().default(100),
  MAX_DAILY_VOLUME_USD: z.coerce.number().positive().default(500),
  MAX_DRAWDOWN_PCT: z.coerce.number().positive().max(100).default(10),
  COOLDOWN_SECONDS: z.coerce.number().nonnegative().default(60),
  INITIAL_EQUITY_USD: z.coerce.number().nonnegative().default(0),

  // Circuit breaker
  MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().positive().default(5),
  MAX_EQUITY_DROP_RATE_BPS: z.coerce.number().int().positive().default(1000),
  MAX_DATA_STALENESS_SECS: z.coerce.number().int().positive().default(300),

  // ERC-8004 / Synthesis
  ERC8004_CONTRACT_ADDRESS: z.string().startsWith("0x").optional(),
  SYNTHESIS_API_KEY: z.string().optional(),

  // Dashboard
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3000),
  ALERT_WEBHOOK_URL: z.string().url().optional(),

  // Mode
  MODE: z.enum(["autonomous", "interactive", "smoke"]).default("interactive"),

  // Logging
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | undefined;

export function loadEnv(): Env {
  if (_env) return _env;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`[sentinel] invalid environment:\n${formatted}`);
    process.exit(1);
  }

  _env = result.data;
  return _env;
}

export function getEnv(): Env {
  if (!_env) {
    throw new Error("env not loaded — call loadEnv() first");
  }
  return _env;
}
