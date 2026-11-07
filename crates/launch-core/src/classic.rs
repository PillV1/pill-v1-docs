//! Pill V1: fixed legacy-style reserves, exact-token trades, wallet-held SPL tokens.
//! Independent implementation; no claim of historical Pump bytecode equivalence.
use crate::{add, ceil_mul_div, mul_div, sub, Error, Result};
pub const SUPPLY: u64 = 1_000_000_000_000_000;
pub const SALE: u64 = 793_100_000_000_000;
pub const VIRTUAL_TOKENS: u64 = 1_073_000_000_000_000;
pub const VIRTUAL_SOL: u64 = 30_000_000_000;
pub const TRADE_FEE_BPS: u64 = 220;
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClassicCurve {
    pub sold: u64,
    pub quote: u64,
    pub fees: u64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Trade {
    pub tokens: u64,
    pub principal: u64,
    pub fee: u64,
    pub wallet_lamports: u64,
}
impl ClassicCurve {
    pub fn validate(&self) -> Result<()> {
        if self.sold > SALE {
            return Err(Error::InvalidConfig);
        }
        add(VIRTUAL_SOL, self.quote)?;
        Ok(())
    }
    pub fn buy(&mut self, tokens: u64, max_lamports: u64) -> Result<Trade> {
        self.validate()?;
        if self.sold == SALE {
            return Err(Error::Closed);
        }
        if tokens == 0 {
            return Err(Error::ZeroAmount);
        }
        if tokens > SALE - self.sold {
            return Err(Error::InsufficientReserves);
        }
        let principal = ceil_mul_div(
            add(VIRTUAL_SOL, self.quote)?,
            tokens,
            VIRTUAL_TOKENS - self.sold - tokens,
        )?;
        let fee = ceil_mul_div(principal, TRADE_FEE_BPS, 10_000)?;
        let wallet_lamports = add(principal, fee)?;
        if wallet_lamports > max_lamports {
            return Err(Error::Slippage);
        }
        let next = Self {
            sold: add(self.sold, tokens)?,
            quote: add(self.quote, principal)?,
            fees: add(self.fees, fee)?,
        };
        *self = next;
        Ok(Trade {
            tokens,
            principal,
            fee,
            wallet_lamports,
        })
    }
    pub fn sell(&mut self, tokens: u64, min_lamports: u64) -> Result<Trade> {
        self.validate()?;
        if self.sold == SALE {
            return Err(Error::Closed);
        }
        if tokens == 0 {
            return Err(Error::ZeroAmount);
        }
        if tokens > self.sold {
            return Err(Error::InsufficientReserves);
        }
        let principal = mul_div(
            add(VIRTUAL_SOL, self.quote)?,
            tokens,
            add(VIRTUAL_TOKENS - self.sold, tokens)?,
        )?;
        let fee = ceil_mul_div(principal, TRADE_FEE_BPS, 10_000)?;
        let wallet_lamports = sub(principal, fee)?;
        if wallet_lamports == 0 {
            return Err(Error::ZeroAmount);
        }
        if wallet_lamports < min_lamports {
            return Err(Error::Slippage);
        }
        let next = Self {
            sold: sub(self.sold, tokens)?,
            quote: sub(self.quote, principal)?,
            fees: add(self.fees, fee)?,
        };
        *self = next;
        Ok(Trade {
            tokens,
            principal,
            fee,
            wallet_lamports,
        })
    }
    /// Match terminal curve price; burn unused supply. Fees never become pool principal.
    pub fn migration(&self) -> Result<(u64, u64, u64)> {
        self.validate()?;
        if self.sold != SALE || self.quote == 0 {
            return Err(Error::Closed);
        }
        let tokens = mul_div(
            self.quote,
            VIRTUAL_TOKENS - self.sold,
            add(VIRTUAL_SOL, self.quote)?,
        )?;
        if tokens == 0 || tokens > SUPPLY - SALE {
            return Err(Error::InvalidConfig);
        }
        Ok((tokens, self.quote, SUPPLY - SALE - tokens))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_cannot_create_sol() {
        for tokens in [1_000_000, 1_000_000_000, SALE / 2, SALE - 1] {
            let mut c = ClassicCurve::default();
            let buy = c.buy(tokens, u64::MAX).unwrap();
            let sell = c.sell(tokens, 0).unwrap();
            assert!(sell.wallet_lamports < buy.wallet_lamports);
            assert_eq!(c.sold, 0);
            assert_eq!(buy.wallet_lamports - sell.wallet_lamports, c.quote + c.fees);
        }
    }
    #[test]
    fn completion_and_migration_preserve_liabilities() {
        let mut c = ClassicCurve::default();
        c.buy(SALE, u64::MAX).unwrap();
        assert_eq!(c.buy(1, u64::MAX), Err(Error::Closed));
        assert_eq!(c.sell(1, 0), Err(Error::Closed));
        let (tokens, quote, burn) = c.migration().unwrap();
        assert_eq!(tokens + burn + SALE, SUPPLY);
        assert_eq!(quote, c.quote);
        assert!(c.fees > 0);
    }
    #[test]
    fn failures_never_mutate() {
        let mut c = ClassicCurve::default();
        for (tokens, max) in [(0, u64::MAX), (SALE + 1, u64::MAX), (SALE, 1)] {
            let before = c;
            assert!(c.buy(tokens, max).is_err());
            assert_eq!(c, before);
        }
        c.buy(1_000_000_000, u64::MAX).unwrap();
        let before = c;
        assert!(c.sell(1_000_000_000, u64::MAX).is_err());
        assert_eq!(c, before);
        assert!(c.migration().is_err());
    }
    #[test]
    fn repeated_trades_keep_constant_product_and_sol_conservation() {
        let mut c = ClassicCurve::default();
        let mut deposited = 0u64;
        for _ in 0..1000 {
            let k = u128::from(VIRTUAL_TOKENS - c.sold) * u128::from(VIRTUAL_SOL + c.quote);
            deposited += c.buy(100_000_000_000, u64::MAX).unwrap().wallet_lamports;
            deposited -= c.sell(50_000_000_000, 0).unwrap().wallet_lamports;
            assert!(u128::from(VIRTUAL_TOKENS - c.sold) * u128::from(VIRTUAL_SOL + c.quote) >= k);
            assert_eq!(deposited, c.quote + c.fees);
        }
    }
}
