//! Oracle-scored social rewards. Merkle proofs establish inclusion, not score honesty.
//! The configured operator publishes a fixed, funded hourly distribution.
use crate::*;
use anchor_lang::solana_program::hash::hashv;
pub fn publish(
    ctx: Context<PublishSocialRound>,
    hour: u64,
    root: [u8; 32],
    budget: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let launch = &mut ctx.accounts.launch;
    require!(
        launch.args.fee_mode == FeeMode::Yap && budget > 0 && budget <= launch.coin_fees,
        LaunchError::Configuration
    );
    require!(
        now >= 0 && hour < (now as u64) / 3600 && root != [0; 32],
        LaunchError::Configuration
    );
    let round = &mut ctx.accounts.round;
    round.launch = launch.key();
    round.hour = hour;
    round.root = root;
    round.remaining = budget;
    round.expires_at = now.checked_add(604_800).ok_or(LaunchError::Arithmetic)?;
    launch.coin_fees = launch
        .coin_fees
        .checked_sub(budget)
        .ok_or(LaunchError::Arithmetic)?;
    pay_lamports(&launch.to_account_info(), &round.to_account_info(), budget)?;
    emit!(SocialRoundPublished {
        launch: launch.key(),
        round: round.key(),
        hour,
        budget,
        root
    });
    Ok(())
}
pub fn claim(ctx: Context<ClaimSocialReward>, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        amount > 0
            && amount <= round.remaining
            && proof.len() <= 32
            && Clock::get()?.unix_timestamp <= round.expires_at,
        LaunchError::Configuration
    );
    let mut hash = hashv(&[
        b"yap-v1",
        round.key().as_ref(),
        ctx.accounts.owner.key().as_ref(),
        &amount.to_le_bytes(),
    ])
    .to_bytes();
    for other in proof {
        hash = if hash <= other {
            hashv(&[b"yap-node", &hash, &other])
        } else {
            hashv(&[b"yap-node", &other, &hash])
        }
        .to_bytes();
    }
    require!(hash == round.root, LaunchError::Configuration);
    round.remaining = round
        .remaining
        .checked_sub(amount)
        .ok_or(LaunchError::Arithmetic)?;
    ctx.accounts.receipt.owner = ctx.accounts.owner.key();
    ctx.accounts.receipt.round = round.key();
    ctx.accounts.receipt.amount = amount;
    pay_lamports(
        &round.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        amount,
    )?;
    emit!(SocialRewardPaid {
        launch: round.launch,
        round: round.key(),
        owner: ctx.accounts.owner.key(),
        amount
    });
    Ok(())
}
pub fn expire(ctx: Context<ExpireSocialRound>) -> Result<()> {
    let round = &mut ctx.accounts.round;
    require!(
        Clock::get()?.unix_timestamp > round.expires_at,
        LaunchError::Locked
    );
    let amount = round.remaining;
    round.remaining = 0;
    ctx.accounts.launch.coin_fees = ctx
        .accounts
        .launch
        .coin_fees
        .checked_add(amount)
        .ok_or(LaunchError::Arithmetic)?;
    pay_lamports(
        &round.to_account_info(),
        &ctx.accounts.launch.to_account_info(),
        amount,
    )?;
    emit!(SocialRoundExpired {
        launch: round.launch,
        round: round.key(),
        amount
    });
    Ok(())
}
#[account]
#[derive(InitSpace)]
pub struct SocialRound {
    pub launch: Pubkey,
    pub hour: u64,
    pub root: [u8; 32],
    pub remaining: u64,
    pub expires_at: i64,
}
#[account]
#[derive(InitSpace)]
pub struct SocialReceipt {
    pub owner: Pubkey,
    pub round: Pubkey,
    pub amount: u64,
}
#[derive(Accounts)]
#[instruction(hour:u64)]
pub struct PublishSocialRound<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump,constraint=config.metadata_authority==authority.key())]
    pub config: Account<'info, Config>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(init,payer=authority,space=8+SocialRound::INIT_SPACE,seeds=[b"social-round",launch.key().as_ref(),&hour.to_le_bytes()],bump)]
    pub round: Account<'info, SocialRound>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ClaimSocialReward<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: recipient is bound into the verified Merkle leaf; no caller-selected substitute.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub round: Account<'info, SocialRound>,
    #[account(init,payer=payer,space=8+SocialReceipt::INIT_SPACE,seeds=[b"social-receipt",round.key().as_ref(),owner.key().as_ref()],bump)]
    pub receipt: Account<'info, SocialReceipt>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct ExpireSocialRound<'info> {
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(mut,has_one=launch)]
    pub round: Account<'info, SocialRound>,
}
#[event]
pub struct SocialRoundPublished {
    pub launch: Pubkey,
    pub round: Pubkey,
    pub hour: u64,
    pub budget: u64,
    pub root: [u8; 32],
}
#[event]
pub struct SocialRewardPaid {
    pub launch: Pubkey,
    pub round: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}
#[event]
pub struct SocialRoundExpired {
    pub launch: Pubkey,
    pub round: Pubkey,
    pub amount: u64,
}
