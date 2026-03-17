import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { RISK_ENGINE_BIN, RISK_ENGINE_BIN_DEBUG } from "../core/constants.js";
import { getLogger } from "../infra/logger.js";

interface RiskCommand {
  command: string;
  payload?: unknown;
  seq?: number;
}

interface RiskResponse {
  status: string;
  seq?: number;
  [key: string]: unknown;
}

const BRIDGE_TIMEOUT_MS = 5_000;
const RESTART_DELAY_MS = 2_000;
const MAX_RESTART_ATTEMPTS = 1;

/**
 * Bridge to the Rust risk engine binary.
 * Communicates via JSON over stdin/stdout with sequence IDs (WS1.5, WS2.1, WS2.2).
 * Auto-restarts on crash with state re-initialization.
 */
export class RiskBridge {
  private process: ChildProcess | null = null;
  private pending = new Map<
    number,
    { resolve: (v: RiskResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private seq = 0;
  private binPath: string;
  private restartCount = 0;
  private restarting = false;
  private initState?: {
    markets: { symbol: string; initial_margin_bps: number; maintenance_margin_bps: number; max_leverage: number; tick_size: number; min_size: number }[];
    equity: number;
    limits?: { max_trade_size_usd: number; max_daily_volume_usd: number; max_drawdown_bps: number; cooldown_seconds: number };
  };
  private onHalt?: () => void;

  constructor(projectRoot: string, onHalt?: () => void) {
    const release = join(projectRoot, RISK_ENGINE_BIN);
    const debug = join(projectRoot, RISK_ENGINE_BIN_DEBUG);
    this.binPath = existsSync(release) ? release : debug;
    this.onHalt = onHalt;
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
        // WS2.2: Match response to request by seq ID
        const responseSeq = response.seq;
        if (responseSeq !== undefined && this.pending.has(responseSeq)) {
          const handler = this.pending.get(responseSeq)!;
          this.pending.delete(responseSeq);
          clearTimeout(handler.timer);
          handler.resolve(response);
        } else {
          // Fallback: resolve the oldest pending request (FIFO) for backward compat
          const first = this.pending.entries().next();
          if (!first.done) {
            const [id, handler] = first.value;
            this.pending.delete(id);
            clearTimeout(handler.timer);
            handler.resolve(response);
          } else {
            log.warn({ responseSeq }, "received response with no matching pending request");
          }
        }
      } catch (err) {
        log.error({ line, err }, "failed to parse risk engine response");
      }
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      log.warn({ stderr: data.toString() }, "risk engine stderr");
    });

    this.process.on("exit", (code) => {
      log.warn({ code }, "risk engine process exited");
      for (const [, handler] of this.pending) {
        clearTimeout(handler.timer);
        handler.reject(new Error(`risk engine exited with code ${code}`));
      }
      this.pending.clear();
      this.process = null;

      // Auto-restart if not intentionally stopped
      if (!this.restarting) {
        this.handleCrash(code);
      }
    });

    log.info({ bin: this.binPath }, "risk engine started");
  }

  private async handleCrash(exitCode: number | null): Promise<void> {
    const log = getLogger();

    if (this.restartCount >= MAX_RESTART_ATTEMPTS) {
      log.error(
        { exitCode, restartCount: this.restartCount },
        "risk engine crashed too many times — halting trading",
      );
      this.onHalt?.();
      return;
    }

    this.restartCount++;
    log.warn(
      { exitCode, attempt: this.restartCount, delayMs: RESTART_DELAY_MS },
      "risk engine crashed — attempting restart",
    );

    this.restarting = true;
    await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));

    try {
      await this.start();
      // Re-initialize state
      if (this.initState) {
        if (this.initState.limits) {
          await this.configure(this.initState.limits);
        }
        for (const market of this.initState.markets) {
          await this.addMarket(market);
        }
        await this.initAccount(this.initState.equity);
      }
      log.info("risk engine restarted and state re-initialized");
    } catch (err) {
      log.error({ err }, "risk engine restart failed — halting trading");
      this.onHalt?.();
    } finally {
      this.restarting = false;
    }
  }

  /**
   * Save initialization state for re-initialization after restart.
   */
  saveInitState(state: NonNullable<RiskBridge["initState"]>): void {
    this.initState = state;
  }

  async send(cmd: RiskCommand): Promise<RiskResponse> {
    if (!this.process?.stdin) {
      throw new Error("risk engine not started");
    }

    const id = this.seq++;
    // WS1.5: Include seq in command
    const line = JSON.stringify({ ...cmd, seq: id }) + "\n";

    return new Promise<RiskResponse>((resolve, reject) => {
      // WS2.1: Timeout — reject if Rust engine doesn't respond in time
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`RISK_ENGINE_TIMEOUT: no response for seq ${id} within ${BRIDGE_TIMEOUT_MS}ms`);
        getLogger().error({ seq: id, command: cmd.command }, "risk engine timeout");
        reject(err);
      }, BRIDGE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });

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
    pending?: boolean;
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

  // ── Circuit breaker commands ────────────────────────────────────────

  async checkCircuit(): Promise<RiskResponse> {
    return this.send({ command: "check_circuit" });
  }

  async tripCircuit(): Promise<RiskResponse> {
    return this.send({ command: "trip_circuit" });
  }

  async resetCircuit(): Promise<RiskResponse> {
    return this.send({ command: "reset_circuit" });
  }

  async configureCircuit(config: {
    max_consecutive_losses: number;
    max_equity_drop_rate_bps: number;
    max_data_staleness_secs: number;
  }): Promise<RiskResponse> {
    return this.send({ command: "configure_circuit", payload: config });
  }

  // ── Pending order commands ──────────────────────────────────────────

  async confirmFill(market: string): Promise<RiskResponse> {
    return this.send({ command: "confirm_fill", payload: { market } });
  }

  async rollbackPending(market: string): Promise<RiskResponse> {
    return this.send({ command: "rollback_pending", payload: { market } });
  }

  // ── Loss/win tracking ───────────────────────────────────────────────

  async recordLoss(): Promise<RiskResponse> {
    return this.send({ command: "record_loss" });
  }

  async recordWin(): Promise<RiskResponse> {
    return this.send({ command: "record_win" });
  }

  stop(): void {
    this.restarting = true; // Prevent auto-restart on intentional stop
    if (this.process) {
      // Clear all pending timeouts
      for (const [, handler] of this.pending) {
        clearTimeout(handler.timer);
      }
      this.pending.clear();
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
  }
}
