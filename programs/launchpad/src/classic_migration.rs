//! Atomic migration to a permissionless PumpSwap pool. The curve funds bounded creation rent; the keeper pays transaction fees.
//! Pool principal is locked by burning all received LP tokens. No arbitrary CPI target.
use crate::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::{
    associated_token::get_associated_token_address_with_program_id,
    token::Burn,
    token_2022::{self, Token2022},
};
use launch_core::classic::SUPPLY;
const PUMP_SWAP: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
const POOL_INDEX: u16 = 1;
use crate::graduation_costs::{create_ata, refund_to_curve, GraduationCosts, MAX_SETUP_LAMPORTS};
#[derive(Accounts)]
pub struct GraduateClassic<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut,seeds=[b"classic",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, ClassicLaunch>,
    #[account(mut,address=launch.mint)]
    pub mint: Account<'info, Mint>,
    #[account(address=WSOL)]
    pub quote_mint: Account<'info, Mint>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut,seeds=[b"migration",launch.key().as_ref()],bump)]
    pub authority: SystemAccount<'info>,
    /// CHECK: canonical ATA validated and created idempotently with curve funds below.
    #[account(mut)]
    pub user_base: UncheckedAccount<'info>,
    /// CHECK: canonical ATA validated and created idempotently with curve funds below.
    #[account(mut)]
    pub user_quote: UncheckedAccount<'info>,
    /// CHECK: exact PumpSwap pool PDA checked before CPI; created by PumpSwap.
    #[account(mut)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: exact PumpSwap global configuration PDA checked before CPI.
    pub global_config: UncheckedAccount<'info>,
    /// CHECK: exact pool LP mint PDA checked before CPI; created by PumpSwap.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: exact authority LP ATA checked before CPI; created by PumpSwap.
    #[account(mut)]
    pub user_lp: UncheckedAccount<'info>,
    /// CHECK: canonical ATA validated and created idempotently with curve funds below.
    #[account(mut)]
    pub pool_base: UncheckedAccount<'info>,
    /// CHECK: canonical ATA validated and created idempotently with curve funds below.
    #[account(mut)]
    pub pool_quote: UncheckedAccount<'info>,
    /// CHECK: exact PumpSwap event authority PDA checked below.
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: fixed executable external program, no caller-supplied CPI target.
    #[account(address=PUMP_SWAP,executable)]
    pub pump_program: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn graduate<'info>(mut ctx: Context<'_, '_, '_, 'info, GraduateClassic<'info>>) -> Result<()> {
    let a = &mut ctx.accounts;
    require!(!a.launch.graduated, LaunchError::Closed);
    let (_, full_pool_quote, _) = a.launch.curve().migration().map_err(core_error)?;
    let launch_key = a.launch.key();
    let authority_key = a.authority.key();
    let mint_key = a.mint.key();
    let quote_key = a.quote_mint.key();
    let expected_pool = Pubkey::find_program_address(
        &[
            b"pool",
            &POOL_INDEX.to_le_bytes(),
            authority_key.as_ref(),
            mint_key.as_ref(),
            quote_key.as_ref(),
        ],
        &PUMP_SWAP,
    )
    .0;
    require_keys_eq!(a.pool.key(), expected_pool, LaunchError::Migration);
    require_keys_eq!(
        a.global_config.key(),
        Pubkey::find_program_address(&[b"global_config"], &PUMP_SWAP).0,
        LaunchError::Migration
    );
    require_keys_eq!(
        a.lp_mint.key(),
        Pubkey::find_program_address(&[b"pool_lp_mint", expected_pool.as_ref()], &PUMP_SWAP).0,
        LaunchError::Migration
    );
    require_keys_eq!(
        a.event_authority.key(),
        Pubkey::find_program_address(&[b"__event_authority"], &PUMP_SWAP).0,
        LaunchError::Migration
    );
    require_keys_eq!(
        a.user_lp.key(),
        get_associated_token_address_with_program_id(
            &authority_key,
            &a.lp_mint.key(),
            &token_2022::ID
        ),
        LaunchError::Migration
    );
    require!(a.pool.data_is_empty(), LaunchError::Migration);
    let lb = [a.launch.bump];
    let ls: &[&[u8]] = &[b"classic", mint_key.as_ref(), &lb];
    let ab = [ctx.bumps.authority];
    let aus: &[&[u8]] = &[b"migration", launch_key.as_ref(), &ab];
    require!(a.launch.quote > MAX_SETUP_LAMPORTS, LaunchError::Migration);
    let initial_authority_balance = a.authority.lamports();
    pay_lamports(
        &a.launch.to_account_info(),
        &a.authority.to_account_info(),
        MAX_SETUP_LAMPORTS,
    )?;
    for (ata, owner, mint) in [
        (
            a.user_base.to_account_info(),
            a.authority.to_account_info(),
            a.mint.to_account_info(),
        ),
        (
            a.user_quote.to_account_info(),
            a.authority.to_account_info(),
            a.quote_mint.to_account_info(),
        ),
        (
            a.pool_base.to_account_info(),
            a.pool.to_account_info(),
            a.mint.to_account_info(),
        ),
        (
            a.pool_quote.to_account_info(),
            a.pool.to_account_info(),
            a.quote_mint.to_account_info(),
        ),
    ] {
        create_ata(
            &a.launch.to_account_info(),
            &a.authority.to_account_info(),
            &ata,
            &owner,
            &mint,
            &a.system_program.to_account_info(),
            &a.token_program.to_account_info(),
            &a.associated_token_program.to_account_info(),
            aus,
        )?;
    }
    let initial_pool_quote = full_pool_quote
        .checked_sub(MAX_SETUP_LAMPORTS)
        .ok_or(LaunchError::Arithmetic)?;
    let initial_pool_tokens = launch_core::mul_div(
        initial_pool_quote,
        launch_core::classic::VIRTUAL_TOKENS - a.launch.sold,
        launch_core::classic::VIRTUAL_SOL + a.launch.quote,
    )
    .map_err(core_error)?;
    let mut pool_quote = initial_pool_quote;
    let mut pool_tokens = initial_pool_tokens;
    token::transfer(
        CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            Transfer {
                from: a.vault.to_account_info(),
                to: a.user_base.to_account_info(),
                authority: a.launch.to_account_info(),
            },
            &[ls],
        ),
        pool_tokens,
    )?;
    wrap_reserves(
        &a.launch.to_account_info(),
        &a.authority.to_account_info(),
        &a.user_quote.to_account_info(),
        &a.system_program.to_account_info(),
        &a.token_program.to_account_info(),
        pool_quote,
        aus,
    )?;
    let infos = vec![
        a.pool.to_account_info(),
        a.global_config.to_account_info(),
        a.authority.to_account_info(),
        a.mint.to_account_info(),
        a.quote_mint.to_account_info(),
        a.lp_mint.to_account_info(),
        a.user_base.to_account_info(),
        a.user_quote.to_account_info(),
        a.user_lp.to_account_info(),
        a.pool_base.to_account_info(),
        a.pool_quote.to_account_info(),
        a.system_program.to_account_info(),
        a.token_2022_program.to_account_info(),
        a.token_program.to_account_info(),
        a.token_program.to_account_info(),
        a.associated_token_program.to_account_info(),
        a.event_authority.to_account_info(),
        a.pump_program.to_account_info(),
    ];
    let writable = [
        true, false, true, false, false, true, true, true, true, true, true, false, false, false,
        false, false, false, false,
    ];
    let accounts = infos
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if writable[i] {
                AccountMeta::new(*a.key, i == 2)
            } else {
                AccountMeta::new_readonly(*a.key, i == 2)
            }
        })
        .collect();
    let mut data = vec![233, 146, 209, 142, 207, 104, 64, 188];
    data.extend_from_slice(&POOL_INDEX.to_le_bytes());
    data.extend_from_slice(&pool_tokens.to_le_bytes());
    data.extend_from_slice(&pool_quote.to_le_bytes());
    data.extend_from_slice(Pubkey::default().as_ref());
    data.push(0);
    data.push(0);
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(0);
    invoke_signed(
        &Instruction {
            program_id: PUMP_SWAP,
            accounts,
            data,
        },
        &infos,
        &[aus],
    )?;
    // The LP account must belong to the fixed Token-2022 program and this launch's authority.
    use anchor_spl::token_2022::spl_token_2022::{
        extension::StateWithExtensions, state::Account as SplAccount,
    };
    require_keys_eq!(*a.user_lp.owner, token_2022::ID, LaunchError::Migration);
    let lp_amount = {
        let bytes = a.user_lp.try_borrow_data()?;
        let lp = StateWithExtensions::<SplAccount>::unpack(&bytes)?;
        require_keys_eq!(lp.base.owner, authority_key, LaunchError::Migration);
        require_keys_eq!(lp.base.mint, a.lp_mint.key(), LaunchError::Migration);
        lp.base.amount
    };
    require!(lp_amount > 0, LaunchError::Migration);
    token_2022::burn(
        CpiContext::new_with_signer(
            a.token_2022_program.to_account_info(),
            token_2022::Burn {
                mint: a.lp_mint.to_account_info(),
                from: a.user_lp.to_account_info(),
                authority: a.authority.to_account_info(),
            },
            &[aus],
        ),
        lp_amount,
    )?;
    let (setup_lamports, unused) = refund_to_curve(
        &a.launch.to_account_info(),
        &a.authority.to_account_info(),
        &a.system_program.to_account_info(),
        initial_authority_balance,
        aus,
    )?;
    let final_pool_quote = full_pool_quote
        .checked_sub(setup_lamports)
        .ok_or(LaunchError::Arithmetic)?;
    let final_pool_tokens = launch_core::mul_div(
        final_pool_quote,
        launch_core::classic::VIRTUAL_TOKENS - a.launch.sold,
        launch_core::classic::VIRTUAL_SOL + a.launch.quote,
    )
    .map_err(core_error)?;
    let extra_tokens = final_pool_tokens
        .checked_sub(initial_pool_tokens)
        .ok_or(LaunchError::Arithmetic)?;
    if unused > 0 {
        wrap_reserves(
            &a.launch.to_account_info(),
            &a.authority.to_account_info(),
            &a.pool_quote.to_account_info(),
            &a.system_program.to_account_info(),
            &a.token_program.to_account_info(),
            unused,
            aus,
        )?;
    }
    if extra_tokens > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                Transfer {
                    from: a.vault.to_account_info(),
                    to: a.pool_base.to_account_info(),
                    authority: a.launch.to_account_info(),
                },
                &[ls],
            ),
            extra_tokens,
        )?;
    }
    pool_quote = final_pool_quote;
    pool_tokens = final_pool_tokens;
    let unallocated_tokens = (SUPPLY - a.launch.sold)
        .checked_sub(pool_tokens)
        .ok_or(LaunchError::Insolvent)?;
    emit!(GraduationCosts {
        launch: launch_key,
        setup_lamports,
        max_setup_lamports: MAX_SETUP_LAMPORTS
    });
    if unallocated_tokens > 0 {
        token::burn(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                Burn {
                    mint: a.mint.to_account_info(),
                    from: a.vault.to_account_info(),
                    authority: a.launch.to_account_info(),
                },
                &[ls],
            ),
            unallocated_tokens,
        )?;
    }
    a.vault.reload()?;
    // Unsolicited token donations must not prevent permissionless graduation.
    require!(
        a.launch.sold + pool_tokens + unallocated_tokens == SUPPLY,
        LaunchError::Insolvent
    );
    a.launch.graduated = true;
    a.launch.pool = expected_pool;
    a.launch.quote = 0;
    emit!(Graduated {
        launch: launch_key,
        pool: expected_pool,
        quote: pool_quote,
        tokens: pool_tokens
    });
    Ok(())
}
