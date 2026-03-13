import { parseArgs } from "node:util";
import { loadEnv } from "./config/env.js";
import { initLogger, getLogger } from "./infra/logger.js";
import { initLlm } from "./llm/provider.js";

type Mode = "autonomous" | "interactive";

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", short: "m", default: "interactive" },
    },
  });

  const env = loadEnv();
  const log = initLogger(env.LOG_LEVEL);
  const mode = (values.mode ?? env.MODE) as Mode;

  initLlm({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
  });

  log.info({ mode }, "sentinel starting");

  switch (mode) {
    case "autonomous":
      log.info("autonomous mode — not yet implemented");
      break;
    case "interactive":
      log.info("interactive mode — not yet implemented");
      break;
    default:
      log.error({ mode: mode as string }, "unknown mode");
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  const log = getLogger();
  log.fatal({ err }, "sentinel fatal error");
  process.exit(1);
});
