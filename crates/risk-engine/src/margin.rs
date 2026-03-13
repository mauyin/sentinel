use crate::types::{Account, Decimal, MarketConfig, Position, TradeRequest};

/// Calculate initial margin required for a new trade.
/// initial_margin = notional_value * initial_margin_rate
/// notional_value = size * price
pub fn initial_margin(trade: &TradeRequest, config: &MarketConfig) -> Decimal {
    let notional = trade.size.mul(trade.price);
    notional.mul(config.initial_margin_rate())
}

/// Calculate maintenance margin for an existing position.
/// maintenance_margin = notional_value * maintenance_margin_rate
pub fn maintenance_margin(position: &Position, current_price: Decimal, config: &MarketConfig) -> Decimal {
    let notional = position.size.mul(current_price);
    notional.mul(config.maintenance_margin_rate())
}

/// Calculate total maintenance margin across all positions.
pub fn total_maintenance_margin(account: &Account, prices: &[(String, Decimal)], configs: &[(String, MarketConfig)]) -> Decimal {
    account.positions.iter().fold(Decimal::ZERO, |acc, pos| {
        let price = prices.iter()
            .find(|(m, _)| *m == pos.market)
            .map(|(_, p)| *p)
            .unwrap_or(pos.entry_price);
        let config = configs.iter()
            .find(|(m, _)| *m == pos.market)
            .map(|(_, c)| c);
        match config {
            Some(c) => acc + maintenance_margin(pos, price, c),
            None => acc,
        }
    })
}

/// Free collateral = effective_equity - total_maintenance_margin
pub fn free_collateral(account: &Account, prices: &[(String, Decimal)], configs: &[(String, MarketConfig)]) -> Decimal {
    let effective = account.effective_equity();
    let maint = total_maintenance_margin(account, prices, configs);
    effective - maint
}

/// Check if account has sufficient margin for a new trade.
/// Returns (passes, margin_required, free_after_trade)
pub fn pre_trade_check(
    account: &Account,
    trade: &TradeRequest,
    config: &MarketConfig,
    prices: &[(String, Decimal)],
    configs: &[(String, MarketConfig)],
) -> (bool, Decimal, Decimal) {
    let required = initial_margin(trade, config);
    let free = free_collateral(account, prices, configs);
    let free_after = free - required;
    (free_after.0 >= 0, required, free_after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Side;

    fn test_config() -> MarketConfig {
        MarketConfig {
            symbol: "ETH-USD".to_string(),
            initial_margin_bps: 1000,     // 10%
            maintenance_margin_bps: 500,  // 5%
            max_leverage: Decimal::from_f64(10.0),
            tick_size: Decimal::from_f64(0.01),
            min_size: Decimal::from_f64(0.001),
        }
    }

    #[test]
    fn test_initial_margin() {
        let trade = TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(5.0),
        };
        let config = test_config();
        let margin = initial_margin(&trade, &config);
        // 1.0 * 3000.0 * 0.10 = 300.0
        assert_eq!(margin.to_f64(), 300.0);
    }

    #[test]
    fn test_maintenance_margin() {
        let pos = Position {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(2.0),
            entry_price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(5.0),
            unrealized_pnl: Decimal::ZERO,
        };
        let config = test_config();
        let margin = maintenance_margin(&pos, Decimal::from_f64(3100.0), &config);
        // 2.0 * 3100.0 * 0.05 = 310.0
        assert_eq!(margin.to_f64(), 310.0);
    }

    #[test]
    fn test_free_collateral_no_positions() {
        let account = Account::new(Decimal::from_f64(10000.0));
        let free = free_collateral(&account, &[], &[]);
        assert_eq!(free.to_f64(), 10000.0);
    }

    #[test]
    fn test_pre_trade_check_passes() {
        let account = Account::new(Decimal::from_f64(10000.0));
        let trade = TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(5.0),
        };
        let config = test_config();
        let (passes, required, _) = pre_trade_check(&account, &trade, &config, &[], &[]);
        assert!(passes);
        assert_eq!(required.to_f64(), 300.0);
    }

    #[test]
    fn test_pre_trade_check_fails_insufficient_margin() {
        let account = Account::new(Decimal::from_f64(100.0));
        let trade = TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(5.0),
        };
        let config = test_config();
        let (passes, required, _) = pre_trade_check(&account, &trade, &config, &[], &[]);
        assert!(!passes);
        assert_eq!(required.to_f64(), 300.0);
    }
}
