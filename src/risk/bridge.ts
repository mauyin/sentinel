import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { RISK_ENGINE_BIN, RISK_ENGINE_BIN_DEBUG } from "../core/constants.js";
import { getLogger } from "../infra/logger.js";

interface RiskCommand {
  command: string;
  payload?: unknown;
}

interface RiskResponse {
  status: string;
  [key: string]: unknown;
}

/**
 * Bridge to the Rust risk engine binary.
 * Communicates via JSON over stdin/stdout.
 */
export class RiskBridge {
  private process: ChildProcess | null = null;
  private pending = new Map<
    number,
    { resolve: (v: RiskResponse) => void; reject: (e: Error) => void }
  >();
  private seq = 0;
  private binPath: string;

  constructor(projectRoot: string) {
    const release = join(projectRoot, RISK_ENGINE_BIN);
    const debug = join(projectRoot, RISK_ENGINE_BIN_DEBUG);
    this.binPath = existsSync(release) ? release : debug;
  }

  async start(): Promise<void> {
    const log = getLogger();

    if (!existsSync(this.binPath)) {
      throw new Error(
        `risk engine binary not found at ${this.binPath} — run 'cargo build' first`,
      );
    }

    this.process = spawn(this.binPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = createInterface({ input: this.process.stdout! });
    rl.on("line", (line) => {
      try {
        const response = JSON.parse(line) as RiskResponse;
        // Resolve the oldest pending request (FIFO)
        const first = this.pending.entries().next();
        if (!first.done) {
          const [id, handler] = first.value;
          this.pending.delete(id);
          handler.resolve(response);
        }
      } catch (err) {
        log.error({ line, err }, "failed to parse risk engine response");
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      log.warn({ stderr: data.toString() }, "risk engine stderr");
    });

    this.process.on("exit", (code) => {
      log.info({ code }, "risk engine process exited");
      for (const [, handler] of this.pending) {
        handler.reject(new Error(`risk engine exited with code ${code}`));
      }
      this.pending.clear();
      this.process = null;
    });

    log.info({ bin: this.binPath }, "risk engine started");
  }

  async send(cmd: RiskCommand): Promise<RiskResponse> {
    if (!this.process?.stdin) {
      throw new Error("risk engine not started");
    }

    const id = this.seq++;
    const line = JSON.stringify(cmd) + "\n";

    return new Promise<RiskResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });

      const ok = this.process!.stdin!.write(line);
      if (!ok) {
        this.process!.stdin!.once("drain", () => {
          // Written after drain
        });
      }
    });
  }

  async validateTrade(trade: {
    market: string;
    side: string;
    size: number;
    price: number;
    leverage: number;
  }): Promise<RiskResponse> {
    return this.send({ command: "validate_trade", payload: trade });
  }

  async processFill(fill: {
    market: string;
    side: string;
    size: number;
    price: number;
    fee: number;
  }): Promise<RiskResponse> {
    return this.send({ command: "process_fill", payload: fill });
  }

  async updatePrice(market: string, price: number): Promise<RiskResponse> {
    return this.send({
      command: "update_price",
      payload: { market, price },
    });
  }

  async getState(): Promise<RiskResponse> {
    return this.send({ command: "get_state" });
  }

  async configure(limits: {
    max_trade_size_usd: number;
    max_daily_volume_usd: number;
    max_drawdown_bps: number;
    cooldown_seconds: number;
  }): Promise<RiskResponse> {
    return this.send({ command: "configure", payload: limits });
  }

  async addMarket(market: {
    symbol: string;
    initial_margin_bps: number;
    maintenance_margin_bps: number;
    max_leverage: number;
    tick_size: number;
    min_size: number;
  }): Promise<RiskResponse> {
    return this.send({ command: "add_market", payload: market });
  }

  async initAccount(equity: number): Promise<RiskResponse> {
    return this.send({ command: "init_account", payload: { equity } });
  }

  stop(): void {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
  }
}
