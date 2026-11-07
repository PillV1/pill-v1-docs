//! Curve-funded account creation, with no keeper reimbursement or caller-chosen payout.
use crate::*;
use anchor_lang::solana_program::{instruction::AccountMeta, program::invoke_signed};
use anchor_spl::associated_token::{
    get_associated_token_address_with_program_id,
    spl_associated_token_account::instruction::create_associated_token_account_idempotent,
};
/// Maximum curve principal temporarily reserved for creating the pool and its accounts.
/// Unused funds are deposited into the same pool, not paid to the caller.
pub const MAX_SETUP_LAMPORTS: u64 = launch_core::MAX_GRADUATION_SETUP_LAMPORTS;

pub fn create_ata<'info>(
    launch: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    ata: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    token: &AccountInfo<'info>,
    associated: &AccountInfo<'info>,
    seeds: &[&[u8]],
) -> Result<()> {
    require_keys_eq!(
        *ata.key,
        get_associated_token_address_with_program_id(owner.key, mint.key, token.key),
        LaunchError::Migration
    );
    let mut ix =
        create_associated_token_account_idempotent(authority.key, owner.key, mint.key, token.key);
    // Include the source account to reconcile the preceding program-owned lamport transfer.
    ix.accounts.push(AccountMeta::new(*launch.key, false));
    invoke_signed(
        &ix,
        &[
            authority.clone(),
            ata.clone(),
            owner.clone(),
            mint.clone(),
            system.clone(),
            token.clone(),
            launch.clone(),
            associated.clone(),
        ],
        &[seeds],
    )?;
    Ok(())
}

pub fn refund_to_curve<'info>(
    launch: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    initial_balance: u64,
    seeds: &[&[u8]],
) -> Result<(u64, u64)> {
    let unused = authority
        .lamports()
        .checked_sub(initial_balance)
        .ok_or(LaunchError::Migration)?;
    require!(unused <= MAX_SETUP_LAMPORTS, LaunchError::Migration);
    if unused > 0 {
        transfer(
            CpiContext::new_with_signer(
                system.clone(),
                SolTransfer {
                    from: authority.clone(),
                    to: launch.clone(),
                },
                &[seeds],
            ),
            unused,
        )?;
    }
    Ok((MAX_SETUP_LAMPORTS - unused, unused))
}

#[event]
pub struct GraduationCosts {
    pub launch: Pubkey,
    pub setup_lamports: u64,
    pub max_setup_lamports: u64,
}
