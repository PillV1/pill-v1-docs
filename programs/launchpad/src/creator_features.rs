//! V1.1 creator rewards and opt-in escrow of purchased creator tokens.
use crate::*;
#[derive(Accounts)]
pub struct CollectCreatorFees<'info> {
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    /// CHECK: immutable on-chain beneficiary, cannot be redirected by caller.
    #[account(mut,address=launch.creator)]
    pub creator: UncheckedAccount<'info>,
}
pub fn collect(ctx: Context<CollectCreatorFees>) -> Result<()> {
    let l = &mut ctx.accounts.launch;
    require!(
        l.args.fee_mode == FeeMode::Creator,
        LaunchError::Configuration
    );
    let amount = l.coin_fees;
    if amount > 0 {
        pay_lamports(
            &l.to_account_info(),
            &ctx.accounts.creator.to_account_info(),
            amount,
        )?;
        l.coin_fees = 0;
        emit!(CreatorFeesPaid {
            launch: l.key(),
            creator: l.creator,
            amount
        });
    }
    Ok(())
}
#[account]
#[derive(InitSpace)]
pub struct CreatorVesting {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub total: u64,
    pub claimed: u64,
    pub original_unlock_at: i64,
}
#[derive(Accounts)]
pub struct LockCreatorTokens<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump,has_one=creator)]
    pub launch: Account<'info, Launch>,
    #[account(mut,seeds=[b"position",launch.key().as_ref(),creator.key().as_ref()],bump,constraint=position.owner==creator.key(),has_one=launch)]
    pub position: Account<'info, Position>,
    #[account(init,payer=creator,space=8+CreatorVesting::INIT_SPACE,seeds=[b"creator-vesting",launch.key().as_ref()],bump)]
    pub vesting: Account<'info, CreatorVesting>,
    pub system_program: Program<'info, System>,
}
pub fn lock(ctx: Context<LockCreatorTokens>, amount: u64) -> Result<()> {
    let l = &ctx.accounts.launch;
    let p = &mut ctx.accounts.position;
    require!(!l.graduated && !l.cancelled, LaunchError::Closed);
    // Holder reward accounting must retain every eligible balance; unsupported
    // escrow combinations are rejected rather than stranding reward liabilities.
    require!(
        l.args.fee_mode != FeeMode::Holders,
        LaunchError::Configuration
    );
    // A launch for another beneficiary cannot opt that person into an allocation lock.
    require_keys_eq!(l.launcher, l.creator, LaunchError::Configuration);
    require!(
        amount >= l.args.supply / 100 && amount <= l.args.supply / 10 && amount <= p.balance,
        LaunchError::Configuration
    );
    settle_rewards(l, p)?;
    let v = &mut ctx.accounts.vesting;
    v.launch = l.key();
    v.creator = l.creator;
    v.total = amount;
    v.claimed = 0;
    v.original_unlock_at = p.unlock_at;
    p.balance = p
        .balance
        .checked_sub(amount)
        .ok_or(LaunchError::Arithmetic)?;
    // Escrow retains the old lock too; transferring to escrow cannot shorten it.
    p.locked = p.locked.saturating_sub(amount);
    emit!(CreatorTokensLocked {
        launch: l.key(),
        creator: l.creator,
        amount
    });
    Ok(())
}
#[derive(Accounts)]
pub struct ClaimCreatorVesting<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump,has_one=creator)]
    pub launch: Account<'info, Launch>,
    #[account(mut,seeds=[b"creator-vesting",launch.key().as_ref()],bump,has_one=launch,has_one=creator)]
    pub vesting: Account<'info, CreatorVesting>,
    #[account(address=launch.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed,payer=creator,associated_token::mint=mint,associated_token::authority=creator)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn claim(ctx: Context<ClaimCreatorVesting>) -> Result<()> {
    let l = &ctx.accounts.launch;
    let v = &mut ctx.accounts.vesting;
    let now = Clock::get()?.unix_timestamp;
    require!(
        l.graduated && now >= v.original_unlock_at,
        LaunchError::Locked
    );
    let vested = launch_core::vesting::vested(v.total, l.graduated_at, now).map_err(core_error)?;
    let amount = vested
        .checked_sub(v.claimed)
        .ok_or(LaunchError::Arithmetic)?;
    require!(amount > 0, LaunchError::Locked);
    let bump = [l.bump];
    let seeds: &[&[u8]] = &[b"launch", l.mint.as_ref(), &bump];
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: l.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;
    v.claimed = vested;
    emit!(CreatorVestingPaid {
        launch: l.key(),
        creator: l.creator,
        amount
    });
    Ok(())
}
#[event]
pub struct CreatorFeesPaid {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}
#[event]
pub struct CreatorTokensLocked {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}
#[event]
pub struct CreatorVestingPaid {
    pub launch: Pubkey,
    pub creator: Pubkey,
    pub amount: u64,
}
