//! Mandatory aggregate purchase cap. Wallet splitting, CPI, and sells do not reset it.
use crate::*;
pub fn check(
    previous_slot: u64,
    purchased: u64,
    slot: u64,
    tokens: u64,
    supply: u64,
) -> Result<(u64, u64)> {
    require!(slot >= previous_slot, LaunchError::Configuration);
    let used = if slot == previous_slot { purchased } else { 0 };
    let total = used.checked_add(tokens).ok_or(LaunchError::Arithmetic)?;
    require!(
        tokens > 0 && total <= supply / 100,
        LaunchError::BuySlotLimit
    );
    Ok((slot, total))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_budget_boundaries_and_slot_reset() {
        assert_eq!(check(9, 60, 9, 40, 10_000).unwrap(), (9, 100));
        assert!(check(9, 60, 9, 41, 10_000).is_err());
        assert_eq!(check(9, 100, 10, 100, 10_000).unwrap(), (10, 100));
        assert!(check(9, 0, 10, 101, 10_000).is_err());
        assert!(check(9, 0, 8, 1, 10_000).is_err());
        assert!(check(9, u64::MAX, 9, 1, u64::MAX).is_err());
    }
}
