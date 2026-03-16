use crate::circuit::CircuitBreaker;
use crate::limits::LimitTracker;
use crate::margin;
use crate::pnl;
use crate::types::*;

/// The risk engine: maintains account state, validates trades, processes fills.
pub struct RiskEngine {
    pub account: Account,
    pub limit_tracker: LimitTracker,
    pub market_configs: Vec<(String, MarketConfig)>,
    pub prices: Vec<(String, Decimal)>,
    pub circuit_breaker: CircuitBreaker,
}

impl RiskEngine {
    pub fn new() -> Self {
        let limits = RiskLimits::default();
        Self {
            account: Account::new(Decimal::ZERO),
            limit_tracker: LimitTracker::new(limits),
            market_configs: Vec::new(),
            prices: Vec::new(),
            circuit_breaker: CircuitBreaker::new(CircuitBreakerConfig::default()),
        }
    }

    pub fn with_account(mut self, equity: Decimal) -> Self {
        self.account = Account::new(equity);
        self
    }

    pub fn with_market(mut self, config: MarketConfig) -> Self {
        let symbol = config.symbol.clone();
        self.market_configs.push((symbol, config));
        self
    }

    pub fn handle(&mut self, cmd: Command) -> Response {
        match cmd {
            Command::ValidateTrade(req) => self.validate_trade(req),
            Command::ProcessFill(fill) => self.process_fill(fill),
            Command::UpdatePrice(update) => self.update_price(update),
            Command::GetState => self.get_state(),
            Command::Configure(limits) => self.configure(limits),
            Command::AddMarket(config) => self.add_market(config),
            Command::InitAccount(init) => self.init_account(init),
            Command::CheckCircuit => self.check_circuit(),
            Command::TripCircuit => self.trip_circuit(),
            Command::ResetCircuit => self.reset_circuit(),
            Command::ConfigureCircuit(config) => self.configure_circuit(config),
            Command::ConfirmFill(req) => self.confirm_fill(req.market),
            Command::RollbackPending(req) => self.rollback_pending(req.market),
            Command::RecordLoss => self.record_loss(),
            Command::RecordWin => self.record_win(),
        }
    }

    fn validate_trade(&mut self, trade: TradeRequest) -> Response {
        let now = current_epoch_secs();

        // Input validation (WS1.2)
        if let Err(reason) = validate_trade_input(&trade) {
            return Response::Rejected { reason };
        }

        // Circuit breaker check (WS1.3)
        if !self.circuit_breaker.is_trading_allowed() {
            return Response::Rejected {
                reason: format!(
                    "circuit_breaker_{:?}: {}",
                    self.circuit_breaker.state,
                    self.circuit_breaker
                        .last_trip_reason
                        .as_deref()
                        .unwrap_or("unknown")
                ),
            };
        }

        // Find market config index to avoid holding a borrow across mutable operations
        let config_idx = self.market_configs.iter().position(|(m, _)| m == &trade.market);
        let config_idx = match config_idx {
            Some(i) => i,
            None => {
                return Response::Rejected {
                    reason: format!("unknown_market: {}", trade.market),
                };
            }
        };

        // 1. Check risk limits (size, volume, drawdown, cooldown)
        // WS1.7: check_trade now resets daily volume if needed
        if let Err(reason) = self
            .limit_tracker
            .check_trade(&trade, &self.account, now)
        {
            return Response::Rejected { reason };
        }

        let config = &self.market_configs[config_idx].1;

        // 2. Check margin
        let (passes, margin_required, free_after) = margin::pre_trade_check(
            &self.account,
            &trade,
            config,
            &self.prices,
            &self.market_configs,
        );

        if !passes {
            return Response::Rejected {
                reason: format!(
                    "insufficient_margin: required {} but free collateral after trade would be {}",
                    margin_required, free_after
                ),
            };
        }

        // 3. Check leverage
        if trade.leverage.0 > config.max_leverage.0 {
            return Response::Rejected {
                reason: format!(
                    "max_leverage_exceeded: requested {} > max {}",
                    trade.leverage, config.max_leverage
                ),
            };
        }

        // 4. Check min size
        if trade.size.0 < config.min_size.0 {
            return Response::Rejected {
                reason: format!("below_min_size: {} < {}", trade.size, config.min_size),
            };
        }

        Response::Approved {
            margin_required,
            free_collateral: free_after,
        }
    }

    fn process_fill(&mut self, fill: Fill) -> Response {
        let now = current_epoch_secs();

        // Input validation (WS1.2)
        if let Err(reason) = validate_fill_input(&fill) {
            return Response::Error {
                message: reason,
            };
        }

        let is_pending = fill.pending;

        // Find existing position for this market (only confirmed positions)
        let existing = self
            .account
            .positions
            .iter()
            .find(|p| p.market == fill.market && p.state == PositionState::Confirmed);

        let (new_pos, realized) = pnl::process_fill(existing, &fill);

        // Remove old confirmed position for this market
        self.account
            .positions
            .retain(|p| !(p.market == fill.market && p.state == PositionState::Confirmed));

        // Add new position if any
        if let Some(mut pos) = new_pos {
            if is_pending {
                pos.state = PositionState::Pending;
            }
            self.account.positions.push(pos);
        }

        // Update account (pending positions don't affect realized PnL)
        if !is_pending {
            self.account.realized_pnl = self.account.realized_pnl + realized;
            self.account.equity = self.account.equity + realized - fill.fee;
        } else {
            // Pending: only deduct the fee, don't book realized PnL yet
            self.account.equity = self.account.equity - fill.fee;
        }

        // Update peak equity
        let effective = self.account.effective_equity();
        if effective.0 > self.account.peak_equity.0 {
            self.account.peak_equity = effective;
        }

        // Record in limit tracker
        let notional = fill.size.mul(fill.price);
        self.limit_tracker.record_trade(notional, now);

        Response::FillProcessed {
            realized_pnl: realized,
            equity: self.account.equity,
            pending: is_pending,
        }
    }

    fn update_price(&mut self, update: PriceUpdate) -> Response {
        let now = current_epoch_secs();

        // Input validation (WS1.2)
        if let Err(reason) = validate_price_input(&update) {
            return Response::Error {
                message: reason,
            };
        }

        // Update cached price
        if let Some(entry) = self.prices.iter_mut().find(|(m, _)| *m == update.market) {
            entry.1 = update.price;
        } else {
            self.prices.push((update.market.clone(), update.price));
        }

        // Update unrealized PnL for matching positions
        for pos in &mut self.account.positions {
            if pos.market == update.market {
                pos.unrealized_pnl = pnl::unrealized_pnl(pos, update.price);
            }
        }

        // Update peak equity
        let effective = self.account.effective_equity();
        if effective.0 > self.account.peak_equity.0 {
            self.account.peak_equity = effective;
        }

        // Record price update for staleness tracking (WS1.3)
        self.circuit_breaker
            .record_price_update(&update.market, now);

        // Check equity drop rate (WS1.3)
        self.circuit_breaker
            .check_equity_drop_rate(effective, now);

        // Liquidation detection (WS1.6)
        let liquidation_response = self.check_liquidation();

        // If there's a liquidation warning, return it instead
        if let Some(warning) = liquidation_response {
            return warning;
        }

        Response::PriceUpdated {
            unrealized_pnl: self.account.total_unrealized_pnl(),
            effective_equity: effective,
        }
    }

    fn get_state(&self) -> Response {
        Response::State {
            account: self.account.clone(),
            limits: self.limit_tracker.limits.clone(),
            daily_volume: self.limit_tracker.daily_volume,
            circuit_breaker: self.circuit_breaker.state,
        }
    }

    fn configure(&mut self, limits: RiskLimits) -> Response {
        self.limit_tracker.limits = limits;
        Response::Configured
    }

    fn add_market(&mut self, config: MarketConfig) -> Response {
        let symbol = config.symbol.clone();
        self.market_configs.retain(|(m, _)| m != &symbol);
        self.market_configs.push((symbol.clone(), config));
        Response::MarketAdded { symbol }
    }

    fn init_account(&mut self, init: AccountInit) -> Response {
        self.account = Account::new(init.equity);
        Response::AccountInitialized {
            equity: init.equity,
        }
    }

    // ── Circuit breaker commands ──────────────────────────────────────────

    fn check_circuit(&mut self) -> Response {
        let now = current_epoch_secs();
        // Also check data staleness when circuit is queried
        self.circuit_breaker.check_data_staleness(now);
        Response::CircuitState {
            state: self.circuit_breaker.state,
            consecutive_losses: self.circuit_breaker.consecutive_losses,
            last_trip_reason: self.circuit_breaker.last_trip_reason.clone(),
        }
    }

    fn trip_circuit(&mut self) -> Response {
        self.circuit_breaker.trip("manual_trip".to_string());
        Response::CircuitTripped {
            reason: "manual_trip".to_string(),
        }
    }

    fn reset_circuit(&mut self) -> Response {
        self.circuit_breaker.reset();
        Response::CircuitReset
    }

    fn configure_circuit(&mut self, config: CircuitBreakerConfig) -> Response {
        self.circuit_breaker.config = config;
        Response::CircuitConfigured
    }

    fn record_loss(&mut self) -> Response {
        let state = self.circuit_breaker.record_loss();
        Response::LossRecorded {
            consecutive_losses: self.circuit_breaker.consecutive_losses,
            circuit_state: state,
        }
    }

    fn record_win(&mut self) -> Response {
        self.circuit_breaker.record_win();
        Response::WinRecorded {
            consecutive_losses: self.circuit_breaker.consecutive_losses,
        }
    }

    // ── Pending order commands ────────────────────────────────────────────

    fn confirm_fill(&mut self, market: String) -> Response {
        let pos = self
            .account
            .positions
            .iter_mut()
            .find(|p| p.market == market && p.state == PositionState::Pending);

        match pos {
            Some(p) => {
                p.state = PositionState::Confirmed;
                Response::FillConfirmed {
                    market,
                    equity: self.account.equity,
                }
            }
            None => Response::Error {
                message: format!("no pending position for market: {}", market),
            },
        }
    }

    fn rollback_pending(&mut self, market: String) -> Response {
        let pending = self
            .account
            .positions
            .iter()
            .find(|p| p.market == market && p.state == PositionState::Pending)
            .cloned();

        match pending {
            Some(_pos) => {
                self.account
                    .positions
                    .retain(|p| !(p.market == market && p.state == PositionState::Pending));

                Response::PendingRolledBack {
                    market,
                    equity: self.account.equity,
                }
            }
            None => Response::Error {
                message: format!("no pending position for market: {}", market),
            },
        }
    }

    // ── Liquidation detection ────────────────────────────────────────────

    fn check_liquidation(&self) -> Option<Response> {
        let effective = self.account.effective_equity();
        let total_maint =
            margin::total_maintenance_margin(&self.account, &self.prices, &self.market_configs);

        if total_maint.0 > 0 && effective.0 < total_maint.0 {
            let at_risk: Vec<String> = self
                .account
                .positions
                .iter()
                .filter(|p| p.state == PositionState::Confirmed)
                .map(|p| p.market.clone())
                .collect();

            if !at_risk.is_empty() {
                return Some(Response::LiquidationWarning {
                    positions: at_risk,
                    effective_equity: effective,
                    maintenance_margin: total_maint,
                });
            }
        }

        None
    }

    pub(crate) fn find_config(&self, market: &str) -> Option<&MarketConfig> {
        self.market_configs
            .iter()
            .find(|(m, _)| m == market)
            .map(|(_, c)| c)
    }
}

fn current_epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_engine() -> RiskEngine {
        let config = MarketConfig {
            symbol: "ETH-USD".to_string(),
            initial_margin_bps: 1000,
            maintenance_margin_bps: 500,
            max_leverage: Decimal::from_f64(10.0),
            tick_size: Decimal::from_f64(0.01),
            min_size: Decimal::from_f64(0.001),
        };

        RiskEngine::new()
            .with_account(Decimal::from_f64(10000.0))
            .with_market(config)
    }

    #[test]
    fn test_validate_and_execute_trade() {
        let mut engine = test_engine();

        // Validate
        let trade = TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(0.01),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
        };

        let response = engine.handle(Command::ValidateTrade(trade));
        match &response {
            Response::Approved {
                margin_required, ..
            } => {
                // 0.01 * 3000 * 0.10 = 3.0
                assert_eq!(margin_required.to_f64(), 3.0);
            }
            other => panic!("Expected Approved, got {:?}", other),
        }

        // Process fill
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(0.01),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::from_f64(0.3),
            pending: false,
        };

        let response = engine.handle(Command::ProcessFill(fill));
        match &response {
            Response::FillProcessed { equity, .. } => {
                // 10000 - 0.3 fee = 9999.7
                assert_eq!(equity.to_f64(), 9999.7);
            }
            other => panic!("Expected FillProcessed, got {:?}", other),
        }

        assert_eq!(engine.account.positions.len(), 1);
    }

    #[test]
    fn test_reject_unknown_market() {
        let mut engine = test_engine();
        let trade = TradeRequest {
            market: "DOGE-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(0.1),
            leverage: Decimal::from_f64(1.0),
        };
        let response = engine.handle(Command::ValidateTrade(trade));
        assert!(matches!(response, Response::Rejected { .. }));
    }

    #[test]
    fn test_reject_insufficient_margin() {
        let config = MarketConfig {
            symbol: "ETH-USD".to_string(),
            initial_margin_bps: 1000,
            maintenance_margin_bps: 500,
            max_leverage: Decimal::from_f64(10.0),
            tick_size: Decimal::from_f64(0.01),
            min_size: Decimal::from_f64(0.001),
        };

        let mut engine = RiskEngine::new()
            .with_account(Decimal::from_f64(10.0)) // Only $10
            .with_market(config);

        // Configure with no cooldown for testing
        engine.limit_tracker.limits.max_trade_size_usd = Decimal::from_f64(100000.0);
        engine.limit_tracker.limits.max_daily_volume_usd = Decimal::from_f64(100000.0);
        engine.limit_tracker.limits.cooldown_seconds = 0;

        let trade = TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0), // Needs $300 margin
            leverage: Decimal::from_f64(1.0),
        };
        let response = engine.handle(Command::ValidateTrade(trade));
        match response {
            Response::Rejected { reason } => {
                assert!(reason.contains("insufficient_margin"));
            }
            other => panic!("Expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn test_price_update_affects_pnl() {
        let mut engine = test_engine();
        engine.limit_tracker.limits.cooldown_seconds = 0;

        // Open position
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::ZERO,
            pending: false,
        };
        engine.handle(Command::ProcessFill(fill));

        // Price goes up
        let response = engine.handle(Command::UpdatePrice(PriceUpdate {
            market: "ETH-USD".to_string(),
            price: Decimal::from_f64(3100.0),
        }));

        match response {
            Response::PriceUpdated {
                unrealized_pnl,
                effective_equity,
            } => {
                assert_eq!(unrealized_pnl.to_f64(), 100.0);
                assert_eq!(effective_equity.to_f64(), 10100.0);
            }
            other => panic!("Expected PriceUpdated, got {:?}", other),
        }
    }

    #[test]
    fn test_configure_limits() {
        let mut engine = test_engine();
        let new_limits = RiskLimits {
            max_trade_size_usd: Decimal::from_f64(50.0),
            max_daily_volume_usd: Decimal::from_f64(200.0),
            max_drawdown_bps: 500,
            cooldown_seconds: 30,
        };
        let response = engine.handle(Command::Configure(new_limits));
        assert!(matches!(response, Response::Configured));
        assert_eq!(
            engine.limit_tracker.limits.max_trade_size_usd.to_f64(),
            50.0
        );
    }

    #[test]
    fn test_add_market_command() {
        let mut engine = RiskEngine::new();
        let config = MarketConfig {
            symbol: "BTC-USD".to_string(),
            initial_margin_bps: 500,
            maintenance_margin_bps: 250,
            max_leverage: Decimal::from_f64(20.0),
            tick_size: Decimal::from_f64(0.01),
            min_size: Decimal::from_f64(0.0001),
        };
        let response = engine.handle(Command::AddMarket(config));
        match response {
            Response::MarketAdded { symbol } => assert_eq!(symbol, "BTC-USD"),
            other => panic!("Expected MarketAdded, got {:?}", other),
        }
        assert!(engine.find_config("BTC-USD").is_some());
    }

    #[test]
    fn test_add_market_idempotent() {
        let mut engine = RiskEngine::new();
        let config1 = MarketConfig {
            symbol: "ETH-USD".to_string(),
            initial_margin_bps: 1000,
            maintenance_margin_bps: 500,
            max_leverage: Decimal::from_f64(10.0),
            tick_size: Decimal::from_f64(0.01),
            min_size: Decimal::from_f64(0.001),
        };
        engine.handle(Command::AddMarket(config1));

        let config2 = MarketConfig {
            symbol: "ETH-USD".to_string(),
            initial_margin_bps: 2000,
            maintenance_margin_bps: 1000,
            max_leverage: Decimal::from_f64(5.0),
            tick_size: Decimal::from_f64(0.01),
            min_size: Decimal::from_f64(0.001),
        };
        engine.handle(Command::AddMarket(config2));

        let configs: Vec<_> = engine
            .market_configs
            .iter()
            .filter(|(m, _)| m == "ETH-USD")
            .collect();
        assert_eq!(configs.len(), 1);
        assert_eq!(configs[0].1.initial_margin_bps, 2000);
    }

    #[test]
    fn test_init_account_command() {
        let mut engine = RiskEngine::new();
        assert!(engine.account.equity.is_zero());

        let response = engine.handle(Command::InitAccount(AccountInit {
            equity: Decimal::from_f64(5000.0),
        }));
        match response {
            Response::AccountInitialized { equity } => {
                assert_eq!(equity.to_f64(), 5000.0);
            }
            other => panic!("Expected AccountInitialized, got {:?}", other),
        }
        assert_eq!(engine.account.equity.to_f64(), 5000.0);
        assert_eq!(engine.account.peak_equity.to_f64(), 5000.0);
    }

    #[test]
    fn test_full_init_then_trade() {
        let mut engine = RiskEngine::new();

        engine.handle(Command::InitAccount(AccountInit {
            equity: Decimal::from_f64(10000.0),
        }));

        engine.handle(Command::AddMarket(MarketConfig {
            symbol: "ETH-USDC-BASE".to_string(),
            initial_margin_bps: 1000,
            maintenance_margin_bps: 500,
            max_leverage: Decimal::from_f64(10.0),
            tick_size: Decimal::from_f64(0.01),
            min_size: Decimal::from_f64(1.0),
        }));

        engine.handle(Command::Configure(RiskLimits {
            max_trade_size_usd: Decimal::from_f64(10000.0),
            max_daily_volume_usd: Decimal::from_f64(50000.0),
            max_drawdown_bps: 1000,
            cooldown_seconds: 0,
        }));

        let response = engine.handle(Command::ValidateTrade(TradeRequest {
            market: "ETH-USDC-BASE".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
        }));
        match response {
            Response::Approved {
                margin_required, ..
            } => {
                assert_eq!(margin_required.to_f64(), 300.0);
            }
            other => panic!("Expected Approved, got {:?}", other),
        }
    }

    #[test]
    fn test_get_state() {
        let mut engine = test_engine();
        let response = engine.handle(Command::GetState);
        match response {
            Response::State { account, circuit_breaker, .. } => {
                assert_eq!(account.equity.to_f64(), 10000.0);
                assert_eq!(circuit_breaker, CircuitBreakerState::Closed);
            }
            other => panic!("Expected State, got {:?}", other),
        }
    }

    #[test]
    fn test_full_trade_lifecycle() {
        let mut engine = test_engine();
        engine.limit_tracker.limits.cooldown_seconds = 0;

        // 1. Open long
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(0.5),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::from_f64(1.5),
            pending: false,
        };
        engine.handle(Command::ProcessFill(fill));
        assert_eq!(engine.account.positions.len(), 1);
        assert_eq!(engine.account.equity.to_f64(), 9998.5);

        // 2. Price moves up
        engine.handle(Command::UpdatePrice(PriceUpdate {
            market: "ETH-USD".to_string(),
            price: Decimal::from_f64(3200.0),
        }));
        assert_eq!(
            engine.account.positions[0].unrealized_pnl.to_f64(),
            100.0
        );

        // 3. Close position
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Short,
            size: Decimal::from_f64(0.5),
            price: Decimal::from_f64(3200.0),
            fee: Decimal::from_f64(1.6),
            pending: false,
        };
        let response = engine.handle(Command::ProcessFill(fill));
        match response {
            Response::FillProcessed {
                realized_pnl,
                equity,
                ..
            } => {
                assert_eq!(realized_pnl.to_f64(), 98.4);
                assert_eq!(equity.to_f64(), 10095.3);
            }
            other => panic!("Expected FillProcessed, got {:?}", other),
        }
        assert_eq!(engine.account.positions.len(), 0);
    }

    // ── Input validation tests (WS1.2) ───────────────────────────────────

    #[test]
    fn test_reject_negative_size() {
        let mut engine = test_engine();
        let response = engine.handle(Command::ValidateTrade(TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(-1.0),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
        }));
        match response {
            Response::Rejected { reason } => {
                assert!(reason.contains("invalid_input"));
            }
            other => panic!("Expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn test_reject_zero_price() {
        let mut engine = test_engine();
        let response = engine.handle(Command::ValidateTrade(TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(0.01),
            price: Decimal::ZERO,
            leverage: Decimal::from_f64(1.0),
        }));
        match response {
            Response::Rejected { reason } => {
                assert!(reason.contains("invalid_input"));
            }
            other => panic!("Expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn test_reject_negative_fee_in_fill() {
        let mut engine = test_engine();
        let response = engine.handle(Command::ProcessFill(Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::from_f64(-1.0),
            pending: false,
        }));
        match response {
            Response::Error { message } => {
                assert!(message.contains("invalid_input"));
            }
            other => panic!("Expected Error, got {:?}", other),
        }
    }

    // ── Circuit breaker tests (WS1.3) ────────────────────────────────────

    #[test]
    fn test_circuit_breaker_blocks_trade() {
        let mut engine = test_engine();
        engine.handle(Command::TripCircuit);

        let response = engine.handle(Command::ValidateTrade(TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(0.01),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
        }));
        match response {
            Response::Rejected { reason } => {
                assert!(reason.contains("circuit_breaker"));
            }
            other => panic!("Expected Rejected, got {:?}", other),
        }
    }

    #[test]
    fn test_circuit_breaker_reset_flow() {
        let mut engine = test_engine();
        engine.handle(Command::TripCircuit);

        // Reset to HalfOpen
        engine.handle(Command::ResetCircuit);
        assert_eq!(engine.circuit_breaker.state, CircuitBreakerState::HalfOpen);

        // Trading should be allowed in HalfOpen
        let response = engine.handle(Command::ValidateTrade(TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(0.01),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
        }));
        assert!(matches!(response, Response::Approved { .. }));
    }

    #[test]
    fn test_consecutive_losses_trip_circuit() {
        let mut engine = test_engine();
        engine.circuit_breaker.config.max_consecutive_losses = 2;

        engine.handle(Command::RecordLoss);
        assert_eq!(engine.circuit_breaker.state, CircuitBreakerState::Closed);
        engine.handle(Command::RecordLoss);
        assert_eq!(engine.circuit_breaker.state, CircuitBreakerState::Open);
    }

    // ── Pending order tests (WS1.4) ─────────────────────────────────────

    #[test]
    fn test_pending_fill_lifecycle() {
        let mut engine = test_engine();
        engine.limit_tracker.limits.cooldown_seconds = 0;

        // Process fill as pending
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(0.01),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::from_f64(0.3),
            pending: true,
        };
        let response = engine.handle(Command::ProcessFill(fill));
        match &response {
            Response::FillProcessed { pending, .. } => {
                assert!(*pending);
            }
            other => panic!("Expected FillProcessed, got {:?}", other),
        }

        // Position should be Pending
        assert_eq!(engine.account.positions.len(), 1);
        assert_eq!(
            engine.account.positions[0].state,
            PositionState::Pending
        );

        // Confirm the fill
        let response = engine.handle(Command::ConfirmFill(MarketRef {
            market: "ETH-USD".to_string(),
        }));
        assert!(matches!(response, Response::FillConfirmed { .. }));
        assert_eq!(
            engine.account.positions[0].state,
            PositionState::Confirmed
        );
    }

    #[test]
    fn test_pending_fill_rollback() {
        let mut engine = test_engine();
        engine.limit_tracker.limits.cooldown_seconds = 0;

        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(0.01),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::from_f64(0.3),
            pending: true,
        };
        engine.handle(Command::ProcessFill(fill));
        assert_eq!(engine.account.positions.len(), 1);

        // Rollback
        let response = engine.handle(Command::RollbackPending(MarketRef {
            market: "ETH-USD".to_string(),
        }));
        assert!(matches!(response, Response::PendingRolledBack { .. }));
        assert_eq!(engine.account.positions.len(), 0);
    }

    // ── Liquidation detection test (WS1.6) ──────────────────────────────

    #[test]
    fn test_liquidation_warning() {
        let mut engine = test_engine();
        engine.limit_tracker.limits.cooldown_seconds = 0;

        // Open a large leveraged position
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(10.0),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::ZERO,
            pending: false,
        };
        engine.handle(Command::ProcessFill(fill));

        // Price drops dramatically — should trigger liquidation warning
        // Position: 10 ETH @ 3000, maintenance = 10 * 1000 * 0.05 = 500
        // Unrealized PnL at 1000: (1000 - 3000) * 10 = -20000
        // Effective equity: 10000 - 20000 = -10000 < 500 maintenance
        let response = engine.handle(Command::UpdatePrice(PriceUpdate {
            market: "ETH-USD".to_string(),
            price: Decimal::from_f64(1000.0),
        }));

        match response {
            Response::LiquidationWarning {
                positions,
                effective_equity,
                ..
            } => {
                assert_eq!(positions.len(), 1);
                assert_eq!(positions[0], "ETH-USD");
                assert!(effective_equity.is_negative());
            }
            other => panic!("Expected LiquidationWarning, got {:?}", other),
        }
    }
}
