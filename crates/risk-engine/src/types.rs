use serde::{Deserialize, Serialize};

/// Fixed-point decimal: value stored as integer with 8 decimal places.
/// e.g., 1.50000000 USD = 150_000_000
pub const DECIMALS: u32 = 8;
pub const SCALE: i128 = 10i128.pow(DECIMALS);

/// Fixed-point wrapper for financial calculations.
/// All values are i128 scaled by 10^8.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Decimal(pub i128);

impl Decimal {
    pub const ZERO: Self = Self(0);

    pub fn from_f64(v: f64) -> Self {
        Self((v * SCALE as f64) as i128)
    }

    pub fn to_f64(self) -> f64 {
        self.0 as f64 / SCALE as f64
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

    pub fn is_positive(self) -> bool {
        self.0 > 0
    }

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn min(self, other: Self) -> Self {
        Self(self.0.min(other.0))
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub market: String,
    pub side: Side,
    pub size: Decimal,
    pub entry_price: Decimal,
    pub leverage: Decimal,
    pub unrealized_pnl: Decimal,
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
        self.positions.iter().fold(Decimal::ZERO, |acc, p| acc + p.unrealized_pnl)
    }

    pub fn effective_equity(&self) -> Decimal {
        self.equity + self.total_unrealized_pnl()
    }
}

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
#[serde(tag = "command", content = "payload", rename_all = "snake_case")]
pub enum Command {
    ValidateTrade(TradeRequest),
    ProcessFill(Fill),
    UpdatePrice(PriceUpdate),
    GetState,
    Configure(RiskLimits),
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
    },
    PriceUpdated {
        unrealized_pnl: Decimal,
        effective_equity: Decimal,
    },
    State {
        account: Account,
        limits: RiskLimits,
        daily_volume: Decimal,
    },
    Configured,
    Error {
        message: String,
    },
}
