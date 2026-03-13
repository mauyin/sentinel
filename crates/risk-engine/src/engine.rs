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
}

impl RiskEngine {
    pub fn new() -> Self {
        let limits = RiskLimits::default();
        Self {
            account: Account::new(Decimal::ZERO),
            limit_tracker: LimitTracker::new(limits),
            market_configs: Vec::new(),
            prices: Vec::new(),
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
        }
    }

    fn validate_trade(&self, trade: TradeRequest) -> Response {
        let now = current_epoch_secs();

        // Find market config (or use default)
        let config = self.find_config(&trade.market);
        let config = match config {
            Some(c) => c,
            None => {
                return Response::Rejected {
                    reason: format!("unknown_market: {}", trade.market),
                };
            }
        };

        // 1. Check risk limits (size, volume, drawdown, cooldown)
        if let Err(reason) = self.limit_tracker.check_trade(&trade, &self.account, now) {
            return Response::Rejected { reason };
        }

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
                reason: format!(
                    "below_min_size: {} < {}",
                    trade.size, config.min_size
                ),
            };
        }

        Response::Approved {
            margin_required,
            free_collateral: free_after,
        }
    }

    fn process_fill(&mut self, fill: Fill) -> Response {
        let now = current_epoch_secs();

        // Find existing position for this market
        let existing = self.account.positions.iter().find(|p| p.market == fill.market);

        let (new_pos, realized) = pnl::process_fill(existing, &fill);

        // Remove old position for this market
        self.account.positions.retain(|p| p.market != fill.market);

        // Add new position if any
        if let Some(pos) = new_pos {
            self.account.positions.push(pos);
        }

        // Update account
        self.account.realized_pnl = self.account.realized_pnl + realized;
        self.account.equity = self.account.equity + realized - fill.fee;

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
        }
    }

    fn update_price(&mut self, update: PriceUpdate) -> Response {
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
        }
    }

    fn configure(&mut self, limits: RiskLimits) -> Response {
        self.limit_tracker.limits = limits;
        Response::Configured
    }

    fn find_config(&self, market: &str) -> Option<&MarketConfig> {
        self.market_configs.iter().find(|(m, _)| m == market).map(|(_, c)| c)
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
            Response::Approved { margin_required, .. } => {
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
        };
        engine.handle(Command::ProcessFill(fill));

        // Price goes up
        let response = engine.handle(Command::UpdatePrice(PriceUpdate {
            market: "ETH-USD".to_string(),
            price: Decimal::from_f64(3100.0),
        }));

        match response {
            Response::PriceUpdated { unrealized_pnl, effective_equity } => {
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
        assert_eq!(engine.limit_tracker.limits.max_trade_size_usd.to_f64(), 50.0);
    }

    #[test]
    fn test_get_state() {
        let mut engine = test_engine();
        let response = engine.handle(Command::GetState);
        match response {
            Response::State { account, .. } => {
                assert_eq!(account.equity.to_f64(), 10000.0);
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
        };
        engine.handle(Command::ProcessFill(fill));
        assert_eq!(engine.account.positions.len(), 1);
        assert_eq!(engine.account.equity.to_f64(), 9998.5); // 10000 - 1.5 fee

        // 2. Price moves up
        engine.handle(Command::UpdatePrice(PriceUpdate {
            market: "ETH-USD".to_string(),
            price: Decimal::from_f64(3200.0),
        }));
        // Unrealized: (3200 - 3000) * 0.5 = 100
        assert_eq!(engine.account.positions[0].unrealized_pnl.to_f64(), 100.0);

        // 3. Close position
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Short,
            size: Decimal::from_f64(0.5),
            price: Decimal::from_f64(3200.0),
            fee: Decimal::from_f64(1.6),
        };
        let response = engine.handle(Command::ProcessFill(fill));
        match response {
            Response::FillProcessed { realized_pnl, equity } => {
                // Realized: (3200 - 3000) * 0.5 - 1.6 = 98.4
                assert_eq!(realized_pnl.to_f64(), 98.4);
                // Equity: 9998.5 + 98.4 - 1.6 = 10095.3
                assert_eq!(equity.to_f64(), 10095.3);
            }
            other => panic!("Expected FillProcessed, got {:?}", other),
        }
        assert_eq!(engine.account.positions.len(), 0);
    }
}
