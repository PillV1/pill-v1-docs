//! Abort only an unopened launch. Refunds return to its original funding signer.
//! A permanent tombstone prevents a later oracle fulfillment reopening the mint.
use crate::*;
pub fn cancel(ctx: Context<CancelLaunch>) -> Result<()> {
    let launch = &mut ctx.accounts.launch;
    require!(
        !launch.cancelled
            && !launch.randomness_ready
            && !launch.graduated
            && launch.sold == 0
            && launch.quote == 0
            && launch.treasury_fees == 0
            && launch.coin_fees == 0
            && launch.sniper_fees == 0
            && launch.reward_waiting == 0,
        LaunchError::Configuration
    );
    let mint = launch.mint;
    let bump = [launch.bump];
    let seeds: &[&[u8]] = &[b"launch", mint.as_ref(), &bump];
    token::burn(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            token::Burn {
                mint: ctx.accounts.mint.to_account_info(),
                from: ctx.accounts.vault.to_account_info(),
                authority: launch.to_account_info(),
            },
            &[seeds],
        ),
        ctx.accounts.vault.amount,
    )?;
    let recovered = launch.developer_budget;
    launch.developer_budget = 0;
    launch.cancelled = true;
    pay_lamports(
        &launch.to_account_info(),
        &ctx.accounts.launcher.to_account_info(),
        recovered,
    )?;
    if ctx.accounts.ticker_registry.launch == launch.key() {
        ctx.accounts.ticker_registry.launch = Pubkey::default();
        ctx.accounts.ticker_registry.graduated = false;
    }
    emit!(LaunchCancelled {
        launch: launch.key(),
        launcher: launch.launcher,
        recovered
    });
    Ok(())
}
#[derive(Accounts)]
pub struct CancelLaunch<'info> {
    #[account(mut)]
    pub launcher: Signer<'info>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump,has_one=launcher)]
    pub launch: Account<'info, Launch>,
    #[account(mut,address=launch.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,seeds=[b"ticker",launch.args.ticker.as_bytes()],bump)]
    pub ticker_registry: Account<'info, TickerRegistry>,
    pub token_program: Program<'info, Token>,
}
#[event]
pub struct LaunchCancelled {
    pub launch: Pubkey,
    pub launcher: Pubkey,
    pub recovered: u64,
}
