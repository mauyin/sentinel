import { getLogger } from "./logger.js";

export interface HttpOptions {
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY = 1_000;

export async function httpGet<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  return httpRequest<T>("GET", url, undefined, opts);
}

export async function httpPost<T>(
  url: string,
  body: unknown,
  opts: HttpOptions = {},
): Promise<T> {
  return httpRequest<T>("POST", url, body, opts);
}

async function httpRequest<T>(
  method: string,
  url: string,
  body: unknown,
  opts: HttpOptions,
): Promise<T> {
  const log = getLogger();
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelay = opts.retryDelay ?? DEFAULT_RETRY_DELAY;
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...opts.headers,
        },
        body: body != null ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      }

      return (await response.json()) as T;
    } catch (err) {
      const isLast = attempt === retries;
      if (isLast) {
        log.error({ url, method, attempt, err }, "http request failed (final)");
        throw err;
      }
      log.warn({ url, method, attempt, err }, "http request failed, retrying");
      await sleep(retryDelay * (attempt + 1));
    }
  }

  throw new Error("unreachable");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
