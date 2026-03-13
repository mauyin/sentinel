use crate::types::{Account, Decimal, RiskLimits, TradeRequest};

/// Track daily volume and enforce time-based cooldowns.
#[derive(Debug, Clone)]
pub struct LimitTracker {
    pub limits: RiskLimits,
    pub daily_volume: Decimal,
    pub last_trade_epoch_secs: u64,
    pub day_start_epoch_secs: u64,
}

impl LimitTracker {
    pub fn new(limits: RiskLimits) -> Self {
        Self {
            limits,
            daily_volume: Decimal::ZERO,
            last_trade_epoch_secs: 0,
            day_start_epoch_secs: current_day_start(),
        }
    }

    #[cfg(test)]
    pub fn new_with_time(limits: RiskLimits, now_epoch_secs: u64) -> Self {
        Self {
            limits,
            daily_volume: Decimal::ZERO,
            last_trade_epoch_secs: 0,
            day_start_epoch_secs: day_start(now_epoch_secs),
        }
    }

    /// Check all limits before a trade. Returns Ok(()) or Err(reason).
    pub fn check_trade(
        &self,
        trade: &TradeRequest,
        account: &Account,
        now_epoch_secs: u64,
    ) -> Result<(), String> {
        self.maybe_check_day_reset(now_epoch_secs);

        // 1. Max single trade size
        let notional = trade.size.mul(trade.price);
        if notional.0 > self.limits.max_trade_size_usd.0 {
            return Err(format!(
                "trade_size_exceeded: notional {} > max {}",
                notional, self.limits.max_trade_size_usd
            ));
        }

        // 2. Max daily volume
        let projected_volume = self.effective_daily_volume(now_epoch_secs) + notional;
        if projected_volume.0 > self.limits.max_daily_volume_usd.0 {
            return Err(format!(
                "daily_volume_exceeded: projected {} > max {}",
                projected_volume, self.limits.max_daily_volume_usd
            ));
        }

        // 3. Drawdown check
        let drawdown = self.drawdown_bps(account);
        if drawdown > self.limits.max_drawdown_bps {
            return Err(format!(
                "max_drawdown_exceeded: drawdown {}bps > max {}bps",
                drawdown, self.limits.max_drawdown_bps
            ));
        }

        // 4. Cooldown timer
        if self.last_trade_epoch_secs > 0 {
            let elapsed = now_epoch_secs.saturating_sub(self.last_trade_epoch_secs);
            if elapsed < self.limits.cooldown_seconds {
                let remaining = self.limits.cooldown_seconds - elapsed;
                return Err(format!(
                    "cooldown_active: {}s remaining",
                    remaining
                ));
            }
        }

        Ok(())
    }

    /// Record a trade execution.
    pub fn record_trade(&mut self, notional: Decimal, now_epoch_secs: u64) {
        self.maybe_reset_day(now_epoch_secs);
        self.daily_volume = self.daily_volume + notional;
        self.last_trade_epoch_secs = now_epoch_secs;
    }

    /// Current drawdown from peak equity in basis points.
    pub fn drawdown_bps(&self, account: &Account) -> i128 {
        if account.peak_equity.is_zero() {
            return 0;
        }
        let effective = account.effective_equity();
        if effective.0 >= account.peak_equity.0 {
            return 0;
        }
        let drop = account.peak_equity - effective;
        (drop.0 * 10_000) / account.peak_equity.0
    }

    fn effective_daily_volume(&self, now_epoch_secs: u64) -> Decimal {
        if is_new_day(self.day_start_epoch_secs, now_epoch_secs) {
            Decimal::ZERO
        } else {
            self.daily_volume
        }
    }

    fn maybe_check_day_reset(&self, _now_epoch_secs: u64) {
        // Immutable check — actual reset happens in maybe_reset_day
    }

    fn maybe_reset_day(&mut self, now_epoch_secs: u64) {
        if is_new_day(self.day_start_epoch_secs, now_epoch_secs) {
            self.daily_volume = Decimal::ZERO;
            self.day_start_epoch_secs = day_start(now_epoch_secs);
        }
    }
}

fn current_day_start() -> u64 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    day_start(now)
}

fn day_start(epoch_secs: u64) -> u64 {
    epoch_secs - (epoch_secs % 86400)
}

fn is_new_day(day_start_epoch: u64, now_epoch: u64) -> bool {
    now_epoch >= day_start_epoch + 86400
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Account, Side};

    fn default_limits() -> RiskLimits {
        RiskLimits {
            max_trade_size_usd: Decimal::from_f64(100.0),
            max_daily_volume_usd: Decimal::from_f64(500.0),
            max_drawdown_bps: 1000, // 10%
            cooldown_seconds: 60,
        }
    }

    fn test_trade(size: f64, price: f64) -> TradeRequest {
        TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(size),
            price: Decimal::from_f64(price),
            leverage: Decimal::from_f64(1.0),
        }
    }

    #[test]
    fn test_trade_within_limits() {
        let tracker = LimitTracker::new(default_limits());
        let account = Account::new(Decimal::from_f64(1000.0));
        let trade = test_trade(0.01, 3000.0); // notional = $30
        let result = tracker.check_trade(&trade, &account, 1000);
        assert!(result.is_ok());
    }

    #[test]
    fn test_trade_exceeds_max_size() {
        let tracker = LimitTracker::new(default_limits());
        let account = Account::new(Decimal::from_f64(1000.0));
        let trade = test_trade(1.0, 3000.0); // notional = $3000
        let result = tracker.check_trade(&trade, &account, 1000);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("trade_size_exceeded"));
    }

    #[test]
    fn test_daily_volume_limit() {
        let now = 86400 + 100;
        let mut tracker = LimitTracker::new_with_time(default_limits(), now);
        let account = Account::new(Decimal::from_f64(10000.0));

        // Record previous trades totaling $450
        tracker.record_trade(Decimal::from_f64(450.0), now);

        // Next trade of $60 should exceed daily limit of $500
        let trade = test_trade(0.02, 3000.0); // notional = $60
        let result = tracker.check_trade(&trade, &account, now + 61);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("daily_volume_exceeded"));
    }

    #[test]
    fn test_daily_volume_resets_on_new_day() {
        let day1 = 86400 + 100;
        let mut tracker = LimitTracker::new_with_time(default_limits(), day1);
        let account = Account::new(Decimal::from_f64(10000.0));

        // Fill up daily volume
        tracker.record_trade(Decimal::from_f64(490.0), day1);

        // Next day: should be reset
        let day2 = day1 + 86400;
        let trade = test_trade(0.03, 3000.0); // notional = $90
        let result = tracker.check_trade(&trade, &account, day2);
        assert!(result.is_ok());
    }

    #[test]
    fn test_cooldown_enforcement() {
        let now = 86400 + 100;
        let mut tracker = LimitTracker::new_with_time(default_limits(), now);
        let account = Account::new(Decimal::from_f64(10000.0));

        tracker.record_trade(Decimal::from_f64(50.0), now);

        // Try again 30s later (cooldown is 60s)
        let trade = test_trade(0.01, 3000.0);
        let result = tracker.check_trade(&trade, &account, now + 30);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("cooldown_active"));

        // Try again 61s later (should pass)
        let result = tracker.check_trade(&trade, &account, now + 61);
        assert!(result.is_ok());
    }

    #[test]
    fn test_drawdown_check() {
        let mut account = Account::new(Decimal::from_f64(1000.0));
        account.peak_equity = Decimal::from_f64(1000.0);
        // Simulate loss: equity drops to 850 (15% drawdown = 1500 bps)
        account.equity = Decimal::from_f64(850.0);

        let tracker = LimitTracker::new(default_limits());
        let trade = test_trade(0.01, 3000.0);
        let result = tracker.check_trade(&trade, &account, 1000);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("max_drawdown_exceeded"));
    }

    #[test]
    fn test_drawdown_within_limit() {
        let mut account = Account::new(Decimal::from_f64(1000.0));
        account.peak_equity = Decimal::from_f64(1000.0);
        // 5% drawdown = 500 bps (under 1000 bps limit)
        account.equity = Decimal::from_f64(950.0);

        let tracker = LimitTracker::new(default_limits());
        let trade = test_trade(0.01, 3000.0);
        let result = tracker.check_trade(&trade, &account, 1000);
        assert!(result.is_ok());
    }
}
