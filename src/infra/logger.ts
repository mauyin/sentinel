import pino from "pino";

let _logger: pino.Logger | undefined;

export function initLogger(level: string = "info"): pino.Logger {
  if (_logger) return _logger;

  _logger = pino({
    level,
    transport:
      process.env["NODE_ENV"] !== "production"
        ? { target: "pino-pretty", options: { colorize: true } }
        : undefined,
    base: { service: "sentinel" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  return _logger;
}

export function getLogger(): pino.Logger {
  if (!_logger) return initLogger();
  return _logger;
}

export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return getLogger().child(bindings);
}
