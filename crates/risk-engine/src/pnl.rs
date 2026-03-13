use crate::types::{Decimal, Fill, Position};

/// Calculate unrealized PnL for a position at current price.
/// Long:  (current_price - entry_price) * size
/// Short: (entry_price - current_price) * size
pub fn unrealized_pnl(position: &Position, current_price: Decimal) -> Decimal {
    let diff = current_price - position.entry_price;
    let signed = Decimal(diff.0 * position.side.sign());
    signed.mul(position.size)
}

/// Process a fill against an existing position (or create new).
/// Returns (updated_position_or_none, realized_pnl).
///
/// Cases:
/// 1. No existing position → new position, zero realized PnL
/// 2. Same side → increase position, weighted average entry
/// 3. Opposite side, partial close → reduce position, realized PnL
/// 4. Opposite side, full close → close position, realized PnL
/// 5. Opposite side, flip → close + open new, realized PnL from close portion
pub fn process_fill(
    existing: Option<&Position>,
    fill: &Fill,
) -> (Option<Position>, Decimal) {
    let existing = match existing {
        Some(p) => p,
        None => {
            // Case 1: New position
            let pos = Position {
                market: fill.market.clone(),
                side: fill.side,
                size: fill.size,
                entry_price: fill.price,
                leverage: Decimal::from_f64(1.0),
                unrealized_pnl: Decimal::ZERO,
            };
            return (Some(pos), Decimal::ZERO);
        }
    };

    if existing.side == fill.side {
        // Case 2: Same side → weighted average entry
        let new_size = existing.size + fill.size;
        let weighted_entry = weighted_avg_entry(
            existing.entry_price,
            existing.size,
            fill.price,
            fill.size,
        );
        let pos = Position {
            market: existing.market.clone(),
            side: existing.side,
            size: new_size,
            entry_price: weighted_entry,
            leverage: existing.leverage,
            unrealized_pnl: Decimal::ZERO,
        };
        return (Some(pos), Decimal::ZERO);
    }

    // Opposite side: close (partially or fully) then maybe flip
    let close_size = fill.size.min(existing.size);
    let remaining_existing = existing.size - close_size;
    let remaining_fill = fill.size - close_size;

    // Realized PnL from the closed portion
    let price_diff = fill.price - existing.entry_price;
    let signed_diff = Decimal(price_diff.0 * existing.side.sign());
    let realized = signed_diff.mul(close_size) - fill.fee;

    if remaining_existing.is_positive() {
        // Case 3: Partial close — position reduced
        let pos = Position {
            market: existing.market.clone(),
            side: existing.side,
            size: remaining_existing,
            entry_price: existing.entry_price,
            leverage: existing.leverage,
            unrealized_pnl: Decimal::ZERO,
        };
        (Some(pos), realized)
    } else if remaining_fill.is_positive() {
        // Case 5: Flip — close existing + open new in opposite direction
        let pos = Position {
            market: fill.market.clone(),
            side: fill.side,
            size: remaining_fill,
            entry_price: fill.price,
            leverage: Decimal::from_f64(1.0),
            unrealized_pnl: Decimal::ZERO,
        };
        (Some(pos), realized)
    } else {
        // Case 4: Exact close
        (None, realized)
    }
}

/// Weighted average entry price when adding to a position.
/// new_entry = (old_entry * old_size + new_price * new_size) / (old_size + new_size)
pub fn weighted_avg_entry(
    old_entry: Decimal,
    old_size: Decimal,
    new_price: Decimal,
    new_size: Decimal,
) -> Decimal {
    let total_size = old_size + new_size;
    if total_size.is_zero() {
        return Decimal::ZERO;
    }
    let total_cost = old_entry.mul(old_size) + new_price.mul(new_size);
    total_cost.div(total_size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Side;

    #[test]
    fn test_unrealized_pnl_long_profit() {
        let pos = Position {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(2.0),
            entry_price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
            unrealized_pnl: Decimal::ZERO,
        };
        let pnl = unrealized_pnl(&pos, Decimal::from_f64(3100.0));
        // (3100 - 3000) * 2 = 200
        assert_eq!(pnl.to_f64(), 200.0);
    }

    #[test]
    fn test_unrealized_pnl_long_loss() {
        let pos = Position {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            entry_price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
            unrealized_pnl: Decimal::ZERO,
        };
        let pnl = unrealized_pnl(&pos, Decimal::from_f64(2900.0));
        // (2900 - 3000) * 1 = -100
        assert_eq!(pnl.to_f64(), -100.0);
    }

    #[test]
    fn test_unrealized_pnl_short_profit() {
        let pos = Position {
            market: "ETH-USD".to_string(),
            side: Side::Short,
            size: Decimal::from_f64(1.5),
            entry_price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
            unrealized_pnl: Decimal::ZERO,
        };
        let pnl = unrealized_pnl(&pos, Decimal::from_f64(2800.0));
        // (3000 - 2800) * 1.5 = 300
        assert_eq!(pnl.to_f64(), 300.0);
    }

    #[test]
    fn test_new_position_from_fill() {
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3000.0),
            fee: Decimal::from_f64(3.0),
        };
        let (pos, realized) = process_fill(None, &fill);
        assert!(pos.is_some());
        let pos = pos.unwrap();
        assert_eq!(pos.size.to_f64(), 1.0);
        assert_eq!(pos.entry_price.to_f64(), 3000.0);
        assert_eq!(realized.to_f64(), 0.0);
    }

    #[test]
    fn test_add_to_position_same_side() {
        let existing = Position {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            entry_price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
            unrealized_pnl: Decimal::ZERO,
        };
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3200.0),
            fee: Decimal::ZERO,
        };
        let (pos, realized) = process_fill(Some(&existing), &fill);
        let pos = pos.unwrap();
        assert_eq!(pos.size.to_f64(), 2.0);
        // Weighted avg: (3000*1 + 3200*1) / 2 = 3100
        assert_eq!(pos.entry_price.to_f64(), 3100.0);
        assert_eq!(realized.to_f64(), 0.0);
    }

    #[test]
    fn test_partial_close() {
        let existing = Position {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(2.0),
            entry_price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
            unrealized_pnl: Decimal::ZERO,
        };
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Short,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3200.0),
            fee: Decimal::from_f64(3.2),
        };
        let (pos, realized) = process_fill(Some(&existing), &fill);
        let pos = pos.unwrap();
        assert_eq!(pos.size.to_f64(), 1.0);
        assert_eq!(pos.side, Side::Long);
        // Realized: (3200 - 3000) * 1 - 3.2 = 196.8
        assert_eq!(realized.to_f64(), 196.8);
    }

    #[test]
    fn test_full_close() {
        let existing = Position {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            entry_price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
            unrealized_pnl: Decimal::ZERO,
        };
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Short,
            size: Decimal::from_f64(1.0),
            price: Decimal::from_f64(3500.0),
            fee: Decimal::ZERO,
        };
        let (pos, realized) = process_fill(Some(&existing), &fill);
        assert!(pos.is_none());
        // Realized: (3500 - 3000) * 1 = 500
        assert_eq!(realized.to_f64(), 500.0);
    }

    #[test]
    fn test_position_flip() {
        let existing = Position {
            market: "ETH-USD".to_string(),
            side: Side::Long,
            size: Decimal::from_f64(1.0),
            entry_price: Decimal::from_f64(3000.0),
            leverage: Decimal::from_f64(1.0),
            unrealized_pnl: Decimal::ZERO,
        };
        let fill = Fill {
            market: "ETH-USD".to_string(),
            side: Side::Short,
            size: Decimal::from_f64(2.0),
            price: Decimal::from_f64(2800.0),
            fee: Decimal::ZERO,
        };
        let (pos, realized) = process_fill(Some(&existing), &fill);
        let pos = pos.unwrap();
        // Flipped to short with size 1.0 at 2800
        assert_eq!(pos.side, Side::Short);
        assert_eq!(pos.size.to_f64(), 1.0);
        assert_eq!(pos.entry_price.to_f64(), 2800.0);
        // Realized from closing long: (2800 - 3000) * 1 = -200
        assert_eq!(realized.to_f64(), -200.0);
    }

    #[test]
    fn test_weighted_avg_entry() {
        let avg = weighted_avg_entry(
            Decimal::from_f64(100.0),
            Decimal::from_f64(2.0),
            Decimal::from_f64(200.0),
            Decimal::from_f64(3.0),
        );
        // (100*2 + 200*3) / 5 = 800/5 = 160
        assert_eq!(avg.to_f64(), 160.0);
    }
}
