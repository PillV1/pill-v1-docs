//! Fresh ORAO request committed before fulfillment; no rerolls or operator entropy.
use crate::*;
use orao_solana_vrf::{
    program::OraoVrf,
    state::{NetworkState, RandomnessV2},
};
pub fn request(ctx: Context<RequestActivation>, seed: [u8; 32], max_fee: u64) -> Result<()> {
    let launch = &mut ctx.accounts.launch;
    require!(
        !launch.cancelled
            && !launch.activation_requested
            && !launch.randomness_ready
            && launch.sold == 0
            && launch.quote == 0,
        LaunchError::NotActivated
    );
    require!(
        seed != [0; 32] && ctx.accounts.randomness.data_is_empty(),
        LaunchError::Configuration
    );
    require!(
        ctx.accounts.network.config.request_fee <= max_fee,
        LaunchError::Slippage
    );
    orao_solana_vrf::cpi::request_v2(
        CpiContext::new(
            ctx.accounts.vrf_program.to_account_info(),
            orao_solana_vrf::cpi::accounts::RequestV2 {
                payer: ctx.accounts.payer.to_account_info(),
                network_state: ctx.accounts.network.to_account_info(),
                treasury: ctx.accounts.oracle_treasury.to_account_info(),
                request: ctx.accounts.randomness.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        ),
        seed,
    )?;
    launch.activation_requested = true;
    launch.randomness_request = ctx.accounts.randomness.key();
    emit!(ActivationRequested {
        launch: launch.key(),
        randomness: launch.randomness_request
    });
    Ok(())
}
pub fn activate(ctx: Context<Activate>) -> Result<()> {
    let launch = &mut ctx.accounts.launch;
    require!(
        !launch.cancelled
            && launch.activation_requested
            && !launch.randomness_ready
            && launch.blocked_uploaded == launch.args.extra_blocked_count,
        LaunchError::NotActivated
    );
    let fulfilled = ctx
        .accounts
        .randomness
        .fulfilled()
        .ok_or(LaunchError::NotActivated)?;
    require!(fulfilled.randomness != [0; 64], LaunchError::NotActivated);
    let clock = Clock::get()?;
    launch.args.protection_slots = 1 + u64::from(fulfilled.randomness[0] & 3);
    launch.start_slot = clock.slot.checked_add(1).ok_or(LaunchError::Arithmetic)?;
    launch.created_at = clock.unix_timestamp;
    launch.randomness_ready = true;
    if ctx.accounts.ticker_registry.launch == launch.key() {
        ctx.accounts.ticker_registry.last_trade = clock.unix_timestamp;
    }
    emit!(LaunchActivated {
        launch: launch.key(),
        randomness: launch.randomness_request,
        start_slot: launch.start_slot,
        protection_slots: launch.args.protection_slots
    });
    Ok(())
}
#[derive(Accounts)]
#[instruction(seed:[u8;32])]
pub struct RequestActivation<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump,constraint=launch.launcher==payer.key())]
    pub launch: Account<'info, Launch>,
    #[account(mut,seeds=[orao_solana_vrf::CONFIG_ACCOUNT_SEED],bump,seeds::program=orao_solana_vrf::ID)]
    pub network: Account<'info, NetworkState>,
    /// CHECK: fixed SOL fee destination from the authenticated ORAO network state.
    #[account(mut,address=network.config.treasury)]
    pub oracle_treasury: UncheckedAccount<'info>,
    /// CHECK: fresh canonical request account created by ORAO CPI.
    #[account(mut,seeds=[orao_solana_vrf::RANDOMNESS_ACCOUNT_SEED,&seed],bump,seeds::program=orao_solana_vrf::ID)]
    pub randomness: UncheckedAccount<'info>,
    pub vrf_program: Program<'info, OraoVrf>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct Activate<'info> {
    pub payer: Signer<'info>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(address=launch.randomness_request)]
    pub randomness: Account<'info, RandomnessV2>,
    #[account(mut,seeds=[b"ticker",launch.args.ticker.as_bytes()],bump)]
    pub ticker_registry: Account<'info, TickerRegistry>,
}
#[event]
pub struct ActivationRequested {
    pub launch: Pubkey,
    pub randomness: Pubkey,
}
#[event]
pub struct LaunchActivated {
    pub launch: Pubkey,
    pub randomness: Pubkey,
    pub start_slot: u64,
    pub protection_slots: u64,
}
