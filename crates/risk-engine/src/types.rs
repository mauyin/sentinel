use serde::{Deserialize, Serialize};

/// Fixed-point decimal: value stored as integer with 8 decimal places.
/// e.g., 1.50000000 USD = 150_000_000
pub const DECIMALS: u32 = 8;
pub const SCALE: i128 = 10i128.pow(DECIMALS);

// ---------------------------------------------------------------------------
// Arithmetic error types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArithmeticError {
    Overflow,
    DivisionByZero,
    Underflow,
}

impl std::fmt::Display for ArithmeticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Overflow => write!(f, "arithmetic_overflow"),
            Self::DivisionByZero => write!(f, "division_by_zero"),
            Self::Underflow => write!(f, "arithmetic_underflow"),
        }
    }
}

impl std::error::Error for ArithmeticError {}

// ---------------------------------------------------------------------------
// Fixed-point decimal
// ---------------------------------------------------------------------------

/// Fixed-point wrapper for financial calculations.
/// All values are i128 scaled by 10^8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Decimal(pub i128);

impl<'de> Deserialize<'de> for Decimal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct DecimalVisitor;

        impl<'de> serde::de::Visitor<'de> for DecimalVisitor {
            type Value = Decimal;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                write!(f, "a number (float or integer)")
            }

            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Decimal, E> {
                Ok(Decimal::from_f64(v))
            }

            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Decimal, E> {
                Ok(Decimal(v as i128 * SCALE))
            }

            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Decimal, E> {
                Ok(Decimal(v as i128 * SCALE))
            }

            fn visit_i128<E: serde::de::Error>(self, v: i128) -> Result<Decimal, E> {
                Ok(Decimal(v))
            }
        }

        deserializer.deserialize_any(DecimalVisitor)
    }
}

impl Decimal {
    pub const ZERO: Self = Self(0);

    pub fn from_f64(v: f64) -> Self {
        Self((v * SCALE as f64) as i128)
    }

    pub fn to_f64(self) -> f64 {
        self.0 as f64 / SCALE as f64
    }

    pub fn abs(self) -> Self {
        Self(self.0.abs())
    }

    pub fn mul(self, other: Self) -> Self {
        Self(self.0 * other.0 / SCALE)
    }

    pub fn div(self, other: Self) -> Self {
        if other.0 == 0 {
            return Self(0);
        }
        Self(self.0 * SCALE / other.0)
    }

    /// Checked multiplication — returns Err on i128 overflow.
    pub fn checked_mul(self, other: Self) -> Result<Self, ArithmeticError> {
        let numerator = self
            .0
            .checked_mul(other.0)
            .ok_or(ArithmeticError::Overflow)?;
        Ok(Self(numerator / SCALE))
    }

    /// Checked division — returns Err on division by zero or overflow.
    pub fn checked_div(self, other: Self) -> Result<Self, ArithmeticError> {
        if other.0 == 0 {
            return Err(ArithmeticError::DivisionByZero);
        }
        let numerator = self
            .0
            .checked_mul(SCALE)
            .ok_or(ArithmeticError::Overflow)?;
        Ok(Self(numerator / other.0))
    }

    pub fn is_positive(self) -> bool {
        self.0 > 0
    }

    pub fn is_negative(self) -> bool {
        self.0 < 0
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn min(self, other: Self) -> Self {
        Self(self.0.min(other.0))
    }

    pub fn max(self, other: Self) -> Self {
        Self(self.0.max(other.0))
    }
}

impl std::ops::Add for Decimal {
    type Output = Self;
    fn add(self, rhs: Self) -> Self {
        Self(self.0 + rhs.0)
    }
}

impl std::ops::Sub for Decimal {
    type Output = Self;
    fn sub(self, rhs: Self) -> Self {
        Self(self.0 - rhs.0)
    }
}

impl std::ops::Neg for Decimal {
    type Output = Self;
    fn neg(self) -> Self {
        Self(-self.0)
    }
}

impl std::fmt::Display for Decimal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let whole = self.0 / SCALE;
        let frac = (self.0 % SCALE).abs();
        write!(f, "{}.{:08}", whole, frac)
    }
}

// ---------------------------------------------------------------------------
// Core enums
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Long,
    Short,
}

impl Side {
    pub fn sign(self) -> i128 {
        match self {
            Side::Long => 1,
            Side::Short => -1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PositionState {
    Confirmed,
    Pending,
}

impl Default for PositionState {
    fn default() -> Self {
        Self::Confirmed
    }
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CircuitBreakerState {
    /// Trading allowed
    Closed,
    /// Trading halted
    Open,
    /// Testing with reduced size
    HalfOpen,
}

impl Default for CircuitBreakerState {
    fn default() -> Self {
        Self::Closed
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CircuitBreakerConfig {
    pub max_consecutive_losses: u32,
    /// Max equity drop rate in bps per hour
    pub max_equity_drop_rate_bps: i128,
    /// Max data staleness in seconds
    pub max_data_staleness_secs: u64,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            max_consecutive_losses: 5,
            max_equity_drop_rate_bps: 1000, // 10% per hour
            max_data_staleness_secs: 300,   // 5 minutes
        }
    }
}

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub market: String,
    pub side: Side,
    pub size: Decimal,
    pub entry_price: Decimal,
    pub leverage: Decimal,
    pub unrealized_pnl: Decimal,
    #[serde(default)]
    pub state: PositionState,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketConfig {
    pub symbol: String,
    pub initial_margin_bps: i128,
    pub maintenance_margin_bps: i128,
    pub max_leverage: Decimal,
    pub tick_size: Decimal,
    pub min_size: Decimal,
}

impl MarketConfig {
    pub fn initial_margin_rate(&self) -> Decimal {
        Decimal(self.initial_margin_bps * SCALE / 10_000)
    }

    pub fn maintenance_margin_rate(&self) -> Decimal {
        Decimal(self.maintenance_margin_bps * SCALE / 10_000)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub equity: Decimal,
    pub positions: Vec<Position>,
    pub realized_pnl: Decimal,
    pub peak_equity: Decimal,
}

impl Account {
    pub fn new(equity: Decimal) -> Self {
        Self {
            equity,
            positions: Vec::new(),
            realized_pnl: Decimal::ZERO,
            peak_equity: equity,
        }
    }

    pub fn total_unrealized_pnl(&self) -> Decimal {
        self.positions
            .iter()
            .fold(Decimal::ZERO, |acc, p| acc + p.unrealized_pnl)
    }

    pub fn effective_equity(&self) -> Decimal {
        self.equity + self.total_unrealized_pnl()
    }
}

// ---------------------------------------------------------------------------
// Request/response payloads
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeRequest {
    pub market: String,
    pub side: Side,
    pub size: Decimal,
    pub price: Decimal,
    pub leverage: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub market: String,
    pub side: Side,
    pub size: Decimal,
    pub price: Decimal,
    pub fee: Decimal,
    #[serde(default)]
    pub pending: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskLimits {
    pub max_trade_size_usd: Decimal,
    pub max_daily_volume_usd: Decimal,
    pub max_drawdown_bps: i128,
    pub cooldown_seconds: u64,
}

impl Default for RiskLimits {
    fn default() -> Self {
        Self {
            max_trade_size_usd: Decimal::from_f64(100.0),
            max_daily_volume_usd: Decimal::from_f64(500.0),
            max_drawdown_bps: 1000, // 10%
            cooldown_seconds: 60,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceUpdate {
    pub market: String,
    pub price: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInit {
    pub equity: Decimal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketRef {
    pub market: String,
}

// ---------------------------------------------------------------------------
// IPC command / response
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "command", content = "payload", rename_all = "snake_case")]
pub enum Command {
    ValidateTrade(TradeRequest),
    ProcessFill(Fill),
    UpdatePrice(PriceUpdate),
    GetState,
    Configure(RiskLimits),
    AddMarket(MarketConfig),
    InitAccount(AccountInit),
    // Circuit breaker
    CheckCircuit,
    TripCircuit,
    ResetCircuit,
    ConfigureCircuit(CircuitBreakerConfig),
    // Pending order management
    ConfirmFill(MarketRef),
    RollbackPending(MarketRef),
    // Loss/win tracking for circuit breaker
    RecordLoss,
    RecordWin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum Response {
    Approved {
        margin_required: Decimal,
        free_collateral: Decimal,
    },
    Rejected {
        reason: String,
    },
    FillProcessed {
        realized_pnl: Decimal,
        equity: Decimal,
        #[serde(default)]
        pending: bool,
    },
    PriceUpdated {
        unrealized_pnl: Decimal,
        effective_equity: Decimal,
    },
    State {
        account: Account,
        limits: RiskLimits,
        daily_volume: Decimal,
        circuit_breaker: CircuitBreakerState,
    },
    Configured,
    MarketAdded {
        symbol: String,
    },
    AccountInitialized {
        equity: Decimal,
    },
    Error {
        message: String,
    },
    // Circuit breaker responses
    CircuitState {
        state: CircuitBreakerState,
        consecutive_losses: u32,
        last_trip_reason: Option<String>,
    },
    CircuitTripped {
        reason: String,
    },
    CircuitReset,
    CircuitConfigured,
    // Pending order responses
    FillConfirmed {
        market: String,
        equity: Decimal,
    },
    PendingRolledBack {
        market: String,
        equity: Decimal,
    },
    // Liquidation warning
    LiquidationWarning {
        positions: Vec<String>,
        effective_equity: Decimal,
        maintenance_margin: Decimal,
    },
    // Loss/win tracking
    LossRecorded {
        consecutive_losses: u32,
        circuit_state: CircuitBreakerState,
    },
    WinRecorded {
        consecutive_losses: u32,
    },
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/// Validate a trade request for obviously invalid inputs.
pub fn validate_trade_input(trade: &TradeRequest) -> Result<(), String> {
    if trade.size.is_negative() || trade.size.is_zero() {
        return Err(format!(
            "invalid_input: size must be positive, got {}",
            trade.size
        ));
    }
    if trade.price.is_negative() || trade.price.is_zero() {
        return Err(format!(
            "invalid_input: price must be positive, got {}",
            trade.price
        ));
    }
    if trade.leverage.is_negative() || trade.leverage.is_zero() {
        return Err(format!(
            "invalid_input: leverage must be positive, got {}",
            trade.leverage
        ));
    }
    Ok(())
}

/// Validate a fill for obviously invalid inputs.
pub fn validate_fill_input(fill: &Fill) -> Result<(), String> {
    if fill.size.is_negative() || fill.size.is_zero() {
        return Err(format!(
            "invalid_input: size must be positive, got {}",
            fill.size
        ));
    }
    if fill.price.is_negative() || fill.price.is_zero() {
        return Err(format!(
            "invalid_input: price must be positive, got {}",
            fill.price
        ));
    }
    if fill.fee.is_negative() {
        return Err(format!(
            "invalid_input: fee must be non-negative, got {}",
            fill.fee
        ));
    }
    Ok(())
}

/// Validate a price update for obviously invalid inputs.
pub fn validate_price_input(update: &PriceUpdate) -> Result<(), String> {
    if update.price.is_negative() || update.price.is_zero() {
        return Err(format!(
            "invalid_input: price must be positive, got {}",
            update.price
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checked_mul_normal() {
        let a = Decimal::from_f64(100.0);
        let b = Decimal::from_f64(50.0);
        let result = a.checked_mul(b).unwrap();
        assert_eq!(result.to_f64(), 5000.0);
    }

    #[test]
    fn test_checked_mul_overflow() {
        // Values large enough to overflow i128 during intermediate multiplication
        let a = Decimal(i128::MAX / 2);
        let b = Decimal(3 * SCALE);
        assert!(a.checked_mul(b).is_err());
    }

    #[test]
    fn test_checked_div_normal() {
        let a = Decimal::from_f64(100.0);
        let b = Decimal::from_f64(4.0);
        let result = a.checked_div(b).unwrap();
        assert_eq!(result.to_f64(), 25.0);
    }

    #[test]
    fn test_checked_div_by_zero() {
        let a = Decimal::from_f64(100.0);
        let b = Decimal::ZERO;
        assert_eq!(a.checked_div(b), Err(ArithmeticError::DivisionByZero));
    }

    #[test]
    fn test_checked_div_overflow() {
        let a = Decimal(i128::MAX / 2);
        let b = Decimal(1); // very small divisor causes overflow in numerator
        assert!(a.checked_div(b).is_err());
    }

    #[test]
    fn test_validate_trade_input_negative_size() {
        let trade = TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(-1.0),
            price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
        };
        assert!(validate_trade_input(&trade).is_err());
    }

    #[test]
    fn test_validate_trade_input_zero_price() {
        let trade = TradeRequest {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::ZERO,
            leverage: Decimal::from_f64(1.0),
        };
        assert!(validate_trade_input(&trade).is_err());
    }

    #[test]
    fn test_validate_fill_input_negative_fee() {
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::from_f64(-1.0),
            pending: false,
        };
        assert!(validate_fill_input(&fill).is_err());
    }

    #[test]
    fn test_validate_price_input_zero() {
        let update = PriceUpdate {
            market: "ETH-USD".to_string(),
            price: Decimal::ZERO,
        };
        assert!(validate_price_input(&update).is_err());
    }

    #[test]
    fn test_decimal_abs() {
        assert_eq!(Decimal::from_f64(-5.0).abs(), Decimal::from_f64(5.0));
        assert_eq!(Decimal::from_f64(5.0).abs(), Decimal::from_f64(5.0));
        assert_eq!(Decimal::ZERO.abs(), Decimal::ZERO);
    }

    #[test]
    fn test_position_state_default() {
        let state = PositionState::default();
        assert_eq!(state, PositionState::Confirmed);
    }

    #[test]
    fn test_circuit_breaker_state_default() {
        let state = CircuitBreakerState::default();
        assert_eq!(state, CircuitBreakerState::Closed);
    }

    #[test]
    fn test_fill_pending_default() {
        let json = r#"{"market":"ETH-USD","side":"long","size":1.0,"price":3000.0,"fee":0.0}"#;
        let fill: Fill = serde_json::from_str(json).unwrap();
        assert!(!fill.pending);
    }

    #[test]
    fn test_fill_pending_true() {
        let json = r#"{"market":"ETH-USD","side":"long","size":1.0,"price":3000.0,"fee":0.0,"pending":true}"#;
        let fill: Fill = serde_json::from_str(json).unwrap();
        assert!(fill.pending);
    }
}
