import OpenAI from "openai";
import { getLogger } from "../infra/logger.js";

let _client: OpenAI | undefined;

const LLM_RETRY_DELAY_MS = 5_000;
const LLM_MAX_RETRIES = 1;

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function initLlm(config: LlmConfig): OpenAI {
  if (_client) return _client;

  _client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });

  getLogger().info(
    { baseUrl: config.baseUrl, model: config.model },
    "llm client initialized",
  );

  return _client;
}

export function getLlm(): OpenAI {
  if (!_client) {
    throw new Error("llm not initialized — call initLlm() first");
  }
  return _client;
}

export async function chat(
  config: LlmConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const log = getLogger();
  const client = _client ?? initLlm(config);

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      if (attempt > 0) {
        log.warn(
          { attempt, delay: LLM_RETRY_DELAY_MS },
          "retrying LLM request after failure",
        );
        await new Promise((r) => setTimeout(r, LLM_RETRY_DELAY_MS));
      }

      const start = Date.now();

      const response = await client.chat.completions.create({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.3,
        max_tokens: 2048,
      });

      const content = response.choices[0]?.message?.content ?? "";
      const elapsed = Date.now() - start;

      log.info(
        {
          model: config.model,
          elapsed,
          tokens: response.usage?.total_tokens,
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
          attempt,
        },
        "llm response received",
      );

      return content;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log.error(
        { err: lastError, attempt, maxRetries: LLM_MAX_RETRIES },
        "LLM request failed",
      );
    }
  }

  throw lastError ?? new Error("LLM request failed after retries");
}
