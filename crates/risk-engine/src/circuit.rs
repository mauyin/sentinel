use crate::types::{CircuitBreakerConfig, CircuitBreakerState, Decimal};

/// Circuit breaker: halts trading when safety thresholds are breached.
///
/// State machine: CLOSED (trading) → OPEN (halt) → HALF_OPEN (test)
///
/// Triggers (any one trips):
///   - consecutive_losses > max_consecutive_losses
///   - equity_drop_rate > max_equity_drop_rate_bps per hour
///   - data_staleness > max_data_staleness_secs
///   - manual trip
pub struct CircuitBreaker {
    pub state: CircuitBreakerState,
    pub config: CircuitBreakerConfig,
    pub consecutive_losses: u32,
    pub last_trip_reason: Option<String>,
    /// Equity snapshots for drop rate calculation: (epoch_secs, equity)
    equity_snapshots: Vec<(u64, Decimal)>,
    /// Last price update timestamp per market
    last_price_updates: Vec<(String, u64)>,
}

impl CircuitBreaker {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            state: CircuitBreakerState::Closed,
            config,
            consecutive_losses: 0,
            last_trip_reason: None,
            equity_snapshots: Vec::new(),
            last_price_updates: Vec::new(),
        }
    }

    /// Check if trading is allowed.
    pub fn is_trading_allowed(&self) -> bool {
        matches!(
            self.state,
            CircuitBreakerState::Closed | CircuitBreakerState::HalfOpen
        )
    }

    /// Record a trade loss. May trigger circuit breaker.
    pub fn record_loss(&mut self) -> CircuitBreakerState {
        self.consecutive_losses += 1;
        if self.consecutive_losses >= self.config.max_consecutive_losses {
            self.trip(format!(
                "consecutive_losses: {} >= {}",
                self.consecutive_losses, self.config.max_consecutive_losses
            ));
        }
        self.state
    }

    /// Record a trade win. Resets consecutive loss counter.
    /// If in HALF_OPEN state, transitions to CLOSED.
    pub fn record_win(&mut self) -> CircuitBreakerState {
        self.consecutive_losses = 0;
        if self.state == CircuitBreakerState::HalfOpen {
            self.state = CircuitBreakerState::Closed;
            self.last_trip_reason = None;
        }
        self.state
    }

    /// Record an equity snapshot for drop rate calculation.
    pub fn record_equity(&mut self, equity: Decimal, now_epoch_secs: u64) {
        self.equity_snapshots.push((now_epoch_secs, equity));
        // Keep only the last hour of snapshots
        let one_hour_ago = now_epoch_secs.saturating_sub(3600);
        self.equity_snapshots.retain(|(ts, _)| *ts >= one_hour_ago);
    }

    /// Check equity drop rate. If equity dropped > threshold over the last hour, trip.
    pub fn check_equity_drop_rate(&mut self, current_equity: Decimal, now_epoch_secs: u64) {
        if self.equity_snapshots.is_empty() {
            return;
        }

        // Find the oldest snapshot within the last hour
        let oldest = self.equity_snapshots.first();
        if let Some((_, oldest_equity)) = oldest {
            if oldest_equity.is_zero() || oldest_equity.is_negative() {
                return;
            }
            let drop = *oldest_equity - current_equity;
            if drop.is_positive() {
                let drop_bps = (drop.0 * 10_000) / oldest_equity.0;
                if drop_bps > self.config.max_equity_drop_rate_bps {
                    self.trip(format!(
                        "equity_drop_rate: {}bps/hr > max {}bps/hr",
                        drop_bps, self.config.max_equity_drop_rate_bps
                    ));
                }
            }
        }

        self.record_equity(current_equity, now_epoch_secs);
    }

    /// Record a price update timestamp for staleness tracking.
    pub fn record_price_update(&mut self, market: &str, now_epoch_secs: u64) {
        if let Some(entry) = self.last_price_updates.iter_mut().find(|(m, _)| m == market) {
            entry.1 = now_epoch_secs;
        } else {
            self.last_price_updates
                .push((market.to_string(), now_epoch_secs));
        }
    }

    /// Check if any market's data is stale. If so, trip.
    pub fn check_data_staleness(&mut self, now_epoch_secs: u64) {
        for (market, last_update) in &self.last_price_updates {
            let age = now_epoch_secs.saturating_sub(*last_update);
            if age > self.config.max_data_staleness_secs {
                self.trip(format!(
                    "data_staleness: market {} last update {}s ago > max {}s",
                    market, age, self.config.max_data_staleness_secs
                ));
                return;
            }
        }
    }

    /// Manually trip the circuit breaker.
    pub fn trip(&mut self, reason: String) {
        self.state = CircuitBreakerState::Open;
        self.last_trip_reason = Some(reason);
    }

    /// Reset the circuit breaker to HALF_OPEN for testing.
    /// From HALF_OPEN, a successful trade moves to CLOSED,
    /// and a failed trade moves back to OPEN.
    pub fn reset(&mut self) {
        match self.state {
            CircuitBreakerState::Open => {
                self.state = CircuitBreakerState::HalfOpen;
            }
            CircuitBreakerState::HalfOpen => {
                self.state = CircuitBreakerState::Closed;
                self.last_trip_reason = None;
                self.consecutive_losses = 0;
            }
            CircuitBreakerState::Closed => {
                // Already closed, no-op
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> CircuitBreakerConfig {
        CircuitBreakerConfig {
            max_consecutive_losses: 3,
            max_equity_drop_rate_bps: 500, // 5%/hr
            max_data_staleness_secs: 60,
        }
    }

    #[test]
    fn test_initial_state_closed() {
        let cb = CircuitBreaker::new(test_config());
        assert_eq!(cb.state, CircuitBreakerState::Closed);
        assert!(cb.is_trading_allowed());
    }

    #[test]
    fn test_consecutive_losses_trip() {
        let mut cb = CircuitBreaker::new(test_config());
        cb.record_loss();
        assert_eq!(cb.state, CircuitBreakerState::Closed);
        cb.record_loss();
        assert_eq!(cb.state, CircuitBreakerState::Closed);
        cb.record_loss(); // 3rd loss triggers trip
        assert_eq!(cb.state, CircuitBreakerState::Open);
        assert!(!cb.is_trading_allowed());
        assert!(cb.last_trip_reason.as_ref().unwrap().contains("consecutive_losses"));
    }

    #[test]
    fn test_win_resets_loss_counter() {
        let mut cb = CircuitBreaker::new(test_config());
        cb.record_loss();
        cb.record_loss();
        assert_eq!(cb.consecutive_losses, 2);
        cb.record_win();
        assert_eq!(cb.consecutive_losses, 0);
        // Now need 3 more losses to trip
        cb.record_loss();
        cb.record_loss();
        assert_eq!(cb.state, CircuitBreakerState::Closed);
    }

    #[test]
    fn test_manual_trip() {
        let mut cb = CircuitBreaker::new(test_config());
        cb.trip("manual".to_string());
        assert_eq!(cb.state, CircuitBreakerState::Open);
        assert_eq!(cb.last_trip_reason.as_ref().unwrap(), "manual");
    }

    #[test]
    fn test_reset_open_to_half_open() {
        let mut cb = CircuitBreaker::new(test_config());
        cb.trip("test".to_string());
        assert_eq!(cb.state, CircuitBreakerState::Open);
        cb.reset();
        assert_eq!(cb.state, CircuitBreakerState::HalfOpen);
        assert!(cb.is_trading_allowed());
    }

    #[test]
    fn test_half_open_win_to_closed() {
        let mut cb = CircuitBreaker::new(test_config());
        cb.trip("test".to_string());
        cb.reset(); // → HalfOpen
        cb.record_win();
        assert_eq!(cb.state, CircuitBreakerState::Closed);
        assert!(cb.last_trip_reason.is_none());
    }

    #[test]
    fn test_half_open_loss_to_open() {
        let mut config = test_config();
        config.max_consecutive_losses = 1; // trip on first loss
        let mut cb = CircuitBreaker::new(config);
        cb.trip("initial".to_string());
        cb.reset(); // → HalfOpen
        cb.consecutive_losses = 0;
        cb.record_loss(); // Should trip back to Open
        assert_eq!(cb.state, CircuitBreakerState::Open);
    }

    #[test]
    fn test_equity_drop_rate_trip() {
        let mut cb = CircuitBreaker::new(test_config());
        let start = 1000u64;
        // Record starting equity
        cb.record_equity(Decimal::from_f64(10000.0), start);
        // Check with 6% drop (> 5% threshold)
        cb.check_equity_drop_rate(Decimal::from_f64(9400.0), start + 1800);
        assert_eq!(cb.state, CircuitBreakerState::Open);
        assert!(cb.last_trip_reason.as_ref().unwrap().contains("equity_drop_rate"));
    }

    #[test]
    fn test_equity_drop_rate_ok() {
        let mut cb = CircuitBreaker::new(test_config());
        let start = 1000u64;
        cb.record_equity(Decimal::from_f64(10000.0), start);
        // 3% drop is under 5% threshold
        cb.check_equity_drop_rate(Decimal::from_f64(9700.0), start + 1800);
        assert_eq!(cb.state, CircuitBreakerState::Closed);
    }

    #[test]
    fn test_data_staleness_trip() {
        let mut cb = CircuitBreaker::new(test_config());
        cb.record_price_update("ETH-USD", 1000);
        // 61 seconds later, exceeds 60s threshold
        cb.check_data_staleness(1061);
        assert_eq!(cb.state, CircuitBreakerState::Open);
        assert!(cb.last_trip_reason.as_ref().unwrap().contains("data_staleness"));
    }

    #[test]
    fn test_data_staleness_ok() {
        let mut cb = CircuitBreaker::new(test_config());
        cb.record_price_update("ETH-USD", 1000);
        // 30 seconds is under 60s threshold
        cb.check_data_staleness(1030);
        assert_eq!(cb.state, CircuitBreakerState::Closed);
    }

    #[test]
    fn test_reset_from_closed_is_noop() {
        let mut cb = CircuitBreaker::new(test_config());
        assert_eq!(cb.state, CircuitBreakerState::Closed);
        cb.reset();
        assert_eq!(cb.state, CircuitBreakerState::Closed);
    }

    #[test]
    fn test_double_reset_closes() {
        let mut cb = CircuitBreaker::new(test_config());
        cb.trip("test".to_string());
        cb.reset(); // Open → HalfOpen
        cb.reset(); // HalfOpen → Closed
        assert_eq!(cb.state, CircuitBreakerState::Closed);
    }
}
