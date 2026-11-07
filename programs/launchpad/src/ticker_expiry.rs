//! Bonded ticker reuse uses a trusted finalized-history attestation from the operator.
//! PumpSwap does not call our program on trades; the trust boundary is explicit.
use crate::*;
pub fn release(ctx: Context<ReleaseBondedTicker>, last_trade: i64, observed_at: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(
        ctx.accounts.launch.graduated
            && ctx.accounts.registry.graduated
            && ctx.accounts.registry.launch == ctx.accounts.launch.key(),
        LaunchError::Configuration
    );
    require!(
        last_trade >= ctx.accounts.launch.created_at
            && observed_at <= now
            && now
                .checked_sub(observed_at)
                .ok_or(LaunchError::Arithmetic)?
                <= 60
            && observed_at
                .checked_sub(last_trade)
                .ok_or(LaunchError::Arithmetic)?
                >= 21_600,
        LaunchError::Locked
    );
    ctx.accounts.registry.launch = Pubkey::default();
    ctx.accounts.registry.graduated = false;
    emit!(BondedTickerReleased {
        launch: ctx.accounts.launch.key(),
        last_trade,
        observed_at
    });
    Ok(())
}
#[derive(Accounts)]
pub struct ReleaseBondedTicker<'info> {
    pub operator: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump,constraint=config.metadata_authority==operator.key())]
    pub config: Account<'info, Config>,
    #[account(seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(mut,seeds=[b"ticker",launch.args.ticker.as_bytes()],bump)]
    pub registry: Account<'info, TickerRegistry>,
}
#[event]
pub struct BondedTickerReleased {
    pub launch: Pubkey,
    pub last_trade: i64,
    pub observed_at: i64,
}
