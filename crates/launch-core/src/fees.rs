//! Deterministic fee-mode accounting; no price oracle or off-chain trust.
use crate::{add, mul_div, sub, Config, Curve, Error, Result};
pub const SCALE: u128 = 1u128 << 64;
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Rewards {
    pub index: u128,
    pub waiting: u64,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Entitlement {
    pub checkpoint: u128,
    pub fractional: u128,
    pub claimable: u64,
}
impl Entitlement {
    pub fn settle(&mut self, rewards: Rewards, balance: u64) -> Result<()> {
        let delta = rewards
            .index
            .checked_sub(self.checkpoint)
            .ok_or(Error::Arithmetic)?;
        let scaled = delta
            .checked_mul(u128::from(balance))
            .and_then(|x| x.checked_add(self.fractional))
            .ok_or(Error::Arithmetic)?;
        let whole = u64::try_from(scaled / SCALE).map_err(|_| Error::Arithmetic)?;
        let next = Self {
            checkpoint: rewards.index,
            fractional: scaled % SCALE,
            claimable: add(self.claimable, whole)?,
        };
        *self = next;
        Ok(())
    }
}
impl Rewards {
    pub fn distribute(&mut self, fee: u64, held: u64) -> Result<()> {
        let budget = add(self.waiting, fee)?;
        if held == 0 {
            self.waiting = budget;
            return Ok(());
        }
        let delta = u128::from(budget)
            .checked_mul(SCALE)
            .ok_or(Error::Arithmetic)?
            / u128::from(held);
        // Per-distribution floor dust remains in the fee vault; never allocate it twice.
        let next = Self {
            index: self.index.checked_add(delta).ok_or(Error::Arithmetic)?,
            waiting: 0,
        };
        *self = next;
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BurnPlan {
    pub quote: u64,
    pub tokens: u64,
}
pub fn burn_plan(c: Config, curve: Curve, max_quote: u64, min_tokens: u64) -> Result<BurnPlan> {
    c.validate()?;
    if curve.graduated || curve.quote >= c.target_quote {
        return Err(Error::Closed);
    }
    let quote = max_quote
        .min(curve.coin_fees)
        .min(c.target_quote - curve.quote);
    if quote == 0 {
        return Err(Error::ZeroAmount);
    }
    let tokens = mul_div(
        sub(c.virtual_tokens, curve.sold)?,
        quote,
        add(add(c.virtual_quote, curve.quote)?, quote)?,
    )?;
    if tokens == 0 {
        return Err(Error::ZeroAmount);
    }
    if tokens < min_tokens {
        return Err(Error::Slippage);
    }
    if tokens > sub(c.sale_tokens, curve.sold)? {
        return Err(Error::InsufficientReserves);
    }
    Ok(BurnPlan { quote, tokens })
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidityPlan {
    pub pool_quote: u64,
    pub pool_tokens: u64,
    pub coin_fees_used: u64,
    pub unallocated_tokens: u64,
}
pub fn liquidity_plan(c: Config, curve: Curve) -> Result<LiquidityPlan> {
    let base = curve.migration(c)?;
    let available = sub(c.supply, curve.sold)?;
    let maximum_quote = mul_div(
        available,
        add(c.virtual_quote, curve.quote)?,
        sub(c.virtual_tokens, curve.sold)?,
    )?;
    let extra = curve
        .coin_fees
        .min(maximum_quote.saturating_sub(base.pool_quote));
    let pool_quote = add(base.pool_quote, extra)?;
    let pool_tokens = mul_div(
        pool_quote,
        sub(c.virtual_tokens, curve.sold)?,
        add(c.virtual_quote, curve.quote)?,
    )?;
    Ok(LiquidityPlan {
        pool_quote,
        pool_tokens,
        coin_fees_used: extra,
        unallocated_tokens: sub(available, pool_tokens)?,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_sold_reserve_returns_error_without_panicking() {
        let c = Config {
            supply: 1_000_000_000_000_000,
            sale_tokens: 800_000_000_000_000,
            virtual_tokens: 1_000_000_000_000_000,
            virtual_quote: 30_000_000_000,
            target_quote: 85_000_000_000,
            max_wallet_bps: 400,
            start_slot: 100,
            protection_slots: 4,
        };
        let curve = Curve {
            sold: c.sale_tokens + 1,
            coin_fees: 1000,
            ..Curve::default()
        };
        assert_eq!(
            burn_plan(c, curve, 1000, 0),
            Err(Error::InsufficientReserves)
        );
    }
    #[test]
    fn no_holders_wait_then_allocate() {
        let mut r = Rewards::default();
        r.distribute(100, 0).unwrap();
        assert_eq!(r.waiting, 100);
        r.distribute(100, 10).unwrap();
        let mut e = Entitlement::default();
        e.settle(r, 10).unwrap();
        assert_eq!(e.claimable, 200);
        assert_eq!(r.waiting, 0);
    }
    #[test]
    fn changing_balances_does_not_steal_old_rewards() {
        let mut r = Rewards::default();
        let mut alice = Entitlement::default();
        let mut bob = Entitlement::default();
        r.distribute(100, 10).unwrap();
        alice.settle(r, 10).unwrap();
        bob.settle(r, 0).unwrap();
        r.distribute(200, 20).unwrap();
        alice.settle(r, 10).unwrap();
        bob.settle(r, 10).unwrap();
        assert_eq!((alice.claimable, bob.claimable), (200, 100));
    }
    #[test]
    fn rounding_never_creates_money() {
        for holders in 1..50 {
            let mut r = Rewards::default();
            let mut e = vec![Entitlement::default(); holders];
            let mut funded = 0;
            for fee in 1..100 {
                funded += fee;
                r.distribute(fee, holders as u64).unwrap();
                for x in &mut e {
                    x.settle(r, 1).unwrap()
                }
                assert!(e.iter().map(|x| x.claimable).sum::<u64>() <= funded)
            }
        }
    }
    #[test]
    fn settling_twice_cannot_double_claim() {
        let mut r = Rewards::default();
        r.distribute(1234, 3).unwrap();
        let mut e = Entitlement::default();
        e.settle(r, 3).unwrap();
        let first = e;
        e.settle(r, 3).unwrap();
        assert_eq!(first, e);
    }
    #[test]
    fn overflows_are_atomic() {
        let r = Rewards {
            index: u128::MAX,
            waiting: 0,
        };
        let mut e = Entitlement::default();
        assert_eq!(e.settle(r, u64::MAX), Err(Error::Arithmetic));
        assert_eq!(e, Entitlement::default());
    }
}
