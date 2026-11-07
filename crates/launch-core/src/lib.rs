//! Integer-only curve accounting. Amounts are raw token units and lamports.
//! No RPC, signer, clock, floating-point arithmetic, or administrator overrides.
pub mod classic;
pub mod fees;
pub mod vesting;
pub const BPS: u64 = 10_000;
pub const MAX_GRADUATION_SETUP_LAMPORTS: u64 = 50_000_000;
pub const FEE_BPS: u64 = 250;
pub const PLATFORM_FEE_BPS: u64 = 220;
pub const SNIPER_FEE_BPS: u64 = 9_900;
pub const DEV_LOCK_SECONDS: i64 = 86_400;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Arithmetic,
    InvalidConfig,
    ZeroAmount,
    Slippage,
    Closed,
    InsufficientReserves,
    Cap,
    Locked,
    Expired,
}
pub type Result<T> = core::result::Result<T, Error>;
fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(Error::Arithmetic)
}
fn sub(a: u64, b: u64) -> Result<u64> {
    a.checked_sub(b).ok_or(Error::InsufficientReserves)
}
pub fn mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    if c == 0 {
        return Err(Error::Arithmetic);
    }
    u64::try_from(u128::from(a) * u128::from(b) / u128::from(c)).map_err(|_| Error::Arithmetic)
}
pub fn ceil_mul_div(a: u64, b: u64, c: u64) -> Result<u64> {
    if c == 0 {
        return Err(Error::Arithmetic);
    }
    let x = u128::from(a) * u128::from(b);
    u64::try_from(x.div_ceil(u128::from(c))).map_err(|_| Error::Arithmetic)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Config {
    pub supply: u64,
    pub sale_tokens: u64,
    pub virtual_tokens: u64,
    pub virtual_quote: u64,
    pub target_quote: u64,
    pub max_wallet_bps: u64,
    pub start_slot: u64,
    pub protection_slots: u64,
}
impl Config {
    pub fn validate(self) -> Result<()> {
        if self.supply == 0
            || self.supply > 1_000_000_000_000_000
            || self.sale_tokens == 0
            || self.sale_tokens >= self.supply
            || self.virtual_tokens <= self.sale_tokens
            || self.virtual_quote == 0
            || self.target_quote <= MAX_GRADUATION_SETUP_LAMPORTS
            || !(50..=400).contains(&self.max_wallet_bps)
            || !(1..=4).contains(&self.protection_slots)
        {
            return Err(Error::InvalidConfig);
        }
        let max_quote = ceil_mul_div(
            self.virtual_quote,
            self.sale_tokens,
            self.virtual_tokens - self.sale_tokens,
        )?;
        if self.target_quote >= max_quote {
            return Err(Error::InvalidConfig);
        }
        // End price must be matchable with reserved tokens, without spending user claims.
        let sold = mul_div(
            self.virtual_tokens,
            self.target_quote,
            add(self.virtual_quote, self.target_quote)?,
        )?;
        let remaining = sub(self.virtual_tokens, sold)?;
        let liquidity_tokens = mul_div(
            self.target_quote,
            remaining,
            add(self.virtual_quote, self.target_quote)?,
        )?;
        let initial_liquidity_tokens = mul_div(
            self.target_quote - MAX_GRADUATION_SETUP_LAMPORTS,
            remaining,
            add(self.virtual_quote, self.target_quote)?,
        )?;
        if initial_liquidity_tokens == 0
            || liquidity_tokens == 0
            || liquidity_tokens > self.supply - self.sale_tokens
        {
            return Err(Error::InvalidConfig);
        }
        Ok(())
    }
    pub fn fee_bps(self, slot: u64) -> Result<u64> {
        if slot < self.start_slot {
            return Err(Error::Closed);
        }
        Ok(if slot - self.start_slot < self.protection_slots {
            SNIPER_FEE_BPS
        } else {
            FEE_BPS
        })
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Curve {
    pub sold: u64,
    pub quote: u64,
    pub treasury_fees: u64,
    pub coin_fees: u64,
    pub graduated: bool,
}
impl Default for Curve {
    fn default() -> Self {
        Self {
            sold: 0,
            quote: 0,
            treasury_fees: 0,
            coin_fees: 0,
            graduated: false,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fill {
    pub tokens: u64,
    pub net_quote: u64,
    pub fee: u64,
    pub treasury_fee: u64,
    pub coin_fee: u64,
    pub gross_quote: u64,
}
pub fn split_fee(gross: u64, fee: u64) -> Result<(u64, u64)> {
    let treasury = ceil_mul_div(gross, PLATFORM_FEE_BPS, BPS)?;
    if treasury > fee {
        return Err(Error::InvalidConfig);
    }
    Ok((treasury, fee - treasury))
}
impl Curve {
    fn open(&self, c: Config) -> Result<()> {
        c.validate()?;
        if self.graduated || self.quote >= c.target_quote {
            return Err(Error::Closed);
        }
        if self.sold > c.sale_tokens {
            return Err(Error::InvalidConfig);
        }
        Ok(())
    }
    pub fn buy(
        &mut self,
        c: Config,
        gross: u64,
        min_tokens: u64,
        held: u64,
        slot: u64,
        deadline: u64,
    ) -> Result<Fill> {
        self.buy_inner(c, gross, min_tokens, held, slot, deadline, true)
    }
    /// Contract callers must restrict this entry point to the committed initial allocation.
    pub fn buy_developer(&mut self, c: Config, gross: u64, slot: u64) -> Result<Fill> {
        if c.fee_bps(slot)? != FEE_BPS {
            return Err(Error::Locked);
        }
        self.buy_inner(c, gross, 1, 0, slot, slot, false)
    }
    fn buy_inner(
        &mut self,
        c: Config,
        gross: u64,
        min_tokens: u64,
        held: u64,
        slot: u64,
        deadline: u64,
        enforce_cap: bool,
    ) -> Result<Fill> {
        self.open(c)?;
        if slot > deadline {
            return Err(Error::Expired);
        }
        if gross == 0 {
            return Err(Error::ZeroAmount);
        }
        let rate = c.fee_bps(slot)?;
        let fee = ceil_mul_div(gross, rate, BPS)?;
        let net = sub(gross, fee)?;
        if net == 0 || net > c.target_quote - self.quote {
            return Err(Error::InsufficientReserves);
        }
        let tokens = mul_div(
            c.virtual_tokens - self.sold,
            net,
            add(add(c.virtual_quote, self.quote)?, net)?,
        )?;
        if tokens == 0 {
            return Err(Error::ZeroAmount);
        }
        if tokens < min_tokens {
            return Err(Error::Slippage);
        }
        if enforce_cap && add(held, tokens)? > mul_div(c.supply, c.max_wallet_bps, BPS)? {
            return Err(Error::Cap);
        }
        let sold = add(self.sold, tokens)?;
        if sold > c.sale_tokens {
            return Err(Error::InsufficientReserves);
        }
        let (treasury_fee, coin_fee) = split_fee(gross, fee)?;
        let next = Self {
            sold,
            quote: add(self.quote, net)?,
            treasury_fees: add(self.treasury_fees, treasury_fee)?,
            coin_fees: add(self.coin_fees, coin_fee)?,
            graduated: false,
        };
        *self = next;
        Ok(Fill {
            tokens,
            net_quote: net,
            fee,
            treasury_fee,
            coin_fee,
            gross_quote: gross,
        })
    }
    pub fn sell(
        &mut self,
        c: Config,
        tokens: u64,
        min_quote: u64,
        held: u64,
        locked: u64,
        slot: u64,
        deadline: u64,
    ) -> Result<Fill> {
        self.open(c)?;
        if slot > deadline {
            return Err(Error::Expired);
        }
        if tokens == 0 {
            return Err(Error::ZeroAmount);
        }
        if tokens > held || tokens > self.sold {
            return Err(Error::InsufficientReserves);
        }
        if tokens > held.saturating_sub(locked) {
            return Err(Error::Locked);
        }
        let gross = mul_div(
            add(c.virtual_quote, self.quote)?,
            tokens,
            add(c.virtual_tokens - self.sold, tokens)?,
        )?;
        if gross == 0 || gross > self.quote {
            return Err(Error::InsufficientReserves);
        }
        let fee = ceil_mul_div(gross, c.fee_bps(slot)?, BPS)?;
        let net = sub(gross, fee)?;
        if net == 0 {
            return Err(Error::ZeroAmount);
        }
        if net < min_quote {
            return Err(Error::Slippage);
        }
        let (treasury_fee, coin_fee) = split_fee(gross, fee)?;
        *self = Self {
            sold: sub(self.sold, tokens)?,
            quote: sub(self.quote, gross)?,
            treasury_fees: add(self.treasury_fees, treasury_fee)?,
            coin_fees: add(self.coin_fees, coin_fee)?,
            graduated: false,
        };
        Ok(Fill {
            tokens,
            net_quote: net,
            fee,
            treasury_fee,
            coin_fee,
            gross_quote: gross,
        })
    }
    pub fn migration(&self, c: Config) -> Result<Migration> {
        c.validate()?;
        if self.graduated || self.quote < c.target_quote {
            return Err(Error::Closed);
        }
        let tokens = mul_div(
            self.quote,
            c.virtual_tokens - self.sold,
            add(c.virtual_quote, self.quote)?,
        )?;
        if tokens == 0 || tokens > c.supply - self.sold {
            return Err(Error::InsufficientReserves);
        }
        Ok(Migration {
            pool_tokens: tokens,
            pool_quote: self.quote,
            unallocated_tokens: c.supply - self.sold - tokens,
        })
    }
    pub fn liabilities(&self) -> Result<u64> {
        add(add(self.quote, self.treasury_fees)?, self.coin_fees)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Migration {
    pub pool_tokens: u64,
    pub pool_quote: u64,
    pub unallocated_tokens: u64,
}
#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Config {
        Config {
            supply: 1_000_000_000_000_000,
            sale_tokens: 800_000_000_000_000,
            virtual_tokens: 1_000_000_000_000_000,
            virtual_quote: 30_000_000_000,
            target_quote: 85_000_000_000,
            max_wallet_bps: 400,
            start_slot: 100,
            protection_slots: 4,
        }
    }
    #[test]
    fn config_and_split() {
        assert_eq!(config().validate(), Ok(()));
        assert_eq!(split_fee(10_000, 250).unwrap(), (220, 30));
        for n in 0..10000 {
            let fee = ceil_mul_div(n, FEE_BPS, BPS).unwrap();
            let (a, b) = split_fee(n, fee).unwrap();
            assert_eq!(a + b, fee);
            assert_eq!(a, ceil_mul_div(n, 220, BPS).unwrap())
        }
    }
    #[test]
    fn graduation_target_covers_setup_reserve() {
        for target_quote in [
            0,
            1,
            MAX_GRADUATION_SETUP_LAMPORTS - 1,
            MAX_GRADUATION_SETUP_LAMPORTS,
        ] {
            assert_eq!(
                Config {
                    target_quote,
                    ..config()
                }
                .validate(),
                Err(Error::InvalidConfig)
            );
        }
    }
    #[test]
    fn taxes_end_at_boundary() {
        assert_eq!(config().fee_bps(99), Err(Error::Closed));
        assert_eq!(config().fee_bps(103), Ok(9900));
        assert_eq!(config().fee_bps(104), Ok(250));
    }
    #[test]
    fn buy_sell_cannot_create_money() {
        for gross in [1000, 10000, 1000000, 100000000, 1000000000] {
            let mut s = Curve::default();
            let b = s.buy(config(), gross, 1, 0, 104, 110).unwrap();
            assert_eq!(s.liabilities().unwrap(), gross);
            let sell = s
                .sell(config(), b.tokens, 0, b.tokens, 0, 104, 110)
                .unwrap();
            assert!(sell.net_quote < gross);
            assert_eq!(s.liabilities().unwrap(), gross - sell.net_quote);
            assert_eq!(s.sold, 0);
        }
    }
    #[test]
    fn platform_fee_stress_preserves_reserves_rewards_and_collections() {
        // Deterministic varied buy/sell sequences, in both opening and ordinary windows.
        // Treasury and custom budgets are withdrawn independently of pool principal.
        for slot in [100, 103, 104, 1000] {
            let mut state = Curve::default();
            let mut cash = 0u64;
            let mut held = 0u64;
            let mut seed = 0x5eedu64;
            for i in 0..2000 {
                seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let gross = 100_000 + seed % 1_000_000;
                let b = state.buy(config(), gross, 1, held, slot, slot).unwrap();
                held += b.tokens;
                cash += gross;
                assert_eq!(
                    b.treasury_fee,
                    ((u128::from(gross) * 22).div_ceil(1000)) as u64
                );
                assert_eq!(b.treasury_fee + b.coin_fee, b.fee);
                let tokens = if i % 5 == 0 { held } else { held / 2 };
                let f = state
                    .sell(config(), tokens, 0, held, 0, slot, slot)
                    .unwrap();
                held -= tokens;
                cash -= f.net_quote;
                assert_eq!(
                    f.treasury_fee,
                    ((u128::from(f.gross_quote) * 22).div_ceil(1000)) as u64
                );
                assert_eq!(f.treasury_fee + f.coin_fee, f.fee);
                assert_eq!(cash, state.liabilities().unwrap());
                let principal = state.quote;
                if i % 7 == 0 {
                    cash -= state.treasury_fees;
                    state.treasury_fees = 0;
                }
                if i % 11 == 0 {
                    cash -= state.coin_fees;
                    state.coin_fees = 0;
                }
                assert_eq!(state.quote, principal);
                assert_eq!(cash, state.liabilities().unwrap());
                assert_eq!(state.sold, held);
            }
        }
        assert_eq!(split_fee(10_000, 219), Err(Error::InvalidConfig));
        assert_eq!(
            split_fee(1_000_000_000, 25_000_000),
            Ok((22_000_000, 3_000_000))
        );
        let gross = u64::MAX;
        let fee = ceil_mul_div(gross, FEE_BPS, BPS).unwrap();
        let (platform, custom) = split_fee(gross, fee).unwrap();
        assert_eq!(platform + custom, fee);
    }

    #[test]
    fn failed_trade_is_atomic() {
        let mut s = Curve::default();
        let old = s;
        assert_eq!(
            s.buy(config(), 1000000, u64::MAX, 0, 104, 110),
            Err(Error::Slippage)
        );
        assert_eq!(s, old);
        assert_eq!(
            s.buy(config(), 1000000, 0, u64::MAX, 104, 110),
            Err(Error::Arithmetic)
        );
        assert_eq!(s, old);
    }
    #[test]
    fn cap_and_lock() {
        let mut s = Curve::default();
        assert_eq!(
            s.buy(config(), 1_000_000_000, 0, 40_000_000_000_000, 104, 110),
            Err(Error::Cap)
        );
        let b = s.buy(config(), 1000000, 1, 0, 104, 110).unwrap();
        let old = s;
        assert_eq!(
            s.sell(config(), b.tokens, 0, b.tokens, b.tokens, 104, 110),
            Err(Error::Locked)
        );
        assert_eq!(s, old);
    }
    #[test]
    fn deadline_and_zero() {
        let mut s = Curve::default();
        assert_eq!(s.buy(config(), 0, 0, 0, 104, 110), Err(Error::ZeroAmount));
        assert_eq!(s.buy(config(), 1000, 0, 0, 111, 110), Err(Error::Expired));
    }
    #[test]
    fn migration_separates_fees() {
        let c = config();
        let s = Curve {
            sold: 739_130_434_782_608,
            quote: c.target_quote,
            treasury_fees: 99,
            coin_fees: 901,
            graduated: false,
        };
        let p = s.migration(c).unwrap();
        assert_eq!(p.pool_quote, c.target_quote);
        assert_eq!(p.pool_tokens + p.unallocated_tokens + s.sold, c.supply);
        assert!(p.pool_tokens < c.supply - s.sold);
    }
    #[test]
    fn multiple_wallets_roundtrip_invariant() {
        let mut s = Curve::default();
        let mut deposited = 0;
        let mut paid = 0;
        let mut lots = vec![];
        for i in 1..200 {
            let gross = i * 1000000;
            let b = s.buy(config(), gross, 1, 0, 104, 110).unwrap();
            deposited += gross;
            lots.push(b.tokens);
            assert_eq!(s.liabilities().unwrap(), deposited - paid)
        }
        for tokens in lots.into_iter().rev() {
            let f = s.sell(config(), tokens, 0, tokens, 0, 105, 110).unwrap();
            paid += f.net_quote;
            assert_eq!(s.liabilities().unwrap(), deposited - paid)
        }
        assert!(paid < deposited);
        assert_eq!(s.sold, 0);
    }
}
