//! Creator escrow: seven-day cliff followed by thirty-day linear release.
use crate::{mul_div, Error, Result};
pub const CLIFF: i64 = 7 * 86400;
pub const DURATION: i64 = 30 * 86400;
pub fn vested(total: u64, graduated_at: i64, now: i64) -> Result<u64> {
    if graduated_at <= 0 {
        return Err(Error::Locked);
    }
    let start = graduated_at.checked_add(CLIFF).ok_or(Error::Arithmetic)?;
    if now <= start {
        return Ok(0);
    }
    let elapsed = now
        .checked_sub(start)
        .ok_or(Error::Arithmetic)?
        .min(DURATION);
    mul_div(total, elapsed as u64, DURATION as u64)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cliff_linear_and_completion() {
        let t = 1000;
        assert_eq!(vested(100, 0, t), Err(Error::Locked));
        assert_eq!(vested(100, t, t + CLIFF), Ok(0));
        assert_eq!(vested(100, t, t + CLIFF + DURATION / 2), Ok(50));
        assert_eq!(vested(100, t, t + CLIFF + DURATION), Ok(100));
        assert_eq!(vested(100, t, i64::MAX), Ok(100));
    }
    #[test]
    fn overflow_is_rejected() {
        assert_eq!(vested(100, i64::MAX, i64::MAX), Err(Error::Arithmetic));
    }
}
