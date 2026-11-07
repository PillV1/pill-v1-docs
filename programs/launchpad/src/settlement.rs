//! Residual pre-graduation budgets are settled only into the launch's fixed PumpSwap pool.
//! User claim custody is deliberately absent from this instruction's accounts.
use crate::*;
use anchor_lang::solana_program::{
    hash::hash,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::token_2022::{self, Token2022};
use migration::{PUMP_SWAP, WSOL};
const ADVANCE: u64 = 10_000_000;
#[derive(Accounts)]
pub struct SettlePoolFees<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump,constraint=config.metadata_authority==operator.key())]
    pub config: Account<'info, Config>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(mut,address=launch.mint)]
    pub mint: Account<'info, Mint>,
    #[account(address=WSOL)]
    pub quote_mint: Account<'info, Mint>,
    #[account(mut,seeds=[b"migration",launch.key().as_ref()],bump)]
    pub authority: SystemAccount<'info>,
    #[account(init_if_needed,payer=operator,associated_token::mint=mint,associated_token::authority=authority)]
    pub user_base: Account<'info, TokenAccount>,
    #[account(init_if_needed,payer=operator,associated_token::mint=quote_mint,associated_token::authority=authority)]
    pub user_quote: Account<'info, TokenAccount>,
    /// CHECK: fixed pool created by this launch; validated again by PumpSwap.
    #[account(mut,address=launch.pool,owner=PUMP_SWAP)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: fixed PumpSwap configuration PDA.
    #[account(seeds=[b"global_config"],bump,seeds::program=PUMP_SWAP)]
    pub global_config: UncheckedAccount<'info>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=pool)]
    pub pool_base: Account<'info, TokenAccount>,
    #[account(mut,associated_token::mint=quote_mint,associated_token::authority=pool)]
    pub pool_quote: Account<'info, TokenAccount>,
    /// CHECK: canonical PumpSwap volume account, initialized by its program.
    #[account(mut,seeds=[b"user_volume_accumulator",authority.key().as_ref()],bump,seeds::program=PUMP_SWAP)]
    pub volume: UncheckedAccount<'info>,
    /// CHECK: exact fixed fee configuration address, authenticated by PumpSwap.
    #[account(address=pubkey!("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx"))]
    pub fee_config: UncheckedAccount<'info>,
    /// CHECK: PumpSwap validates this token account against its configured buyback recipients.
    #[account(mut)]
    pub buyback: UncheckedAccount<'info>,
    /// CHECK: fixed PumpSwap event authority.
    #[account(seeds=[b"__event_authority"],bump,seeds::program=PUMP_SWAP)]
    pub event_authority: UncheckedAccount<'info>,
    /// CHECK: fixed executable program, never caller-selected.
    #[account(address=PUMP_SWAP,executable)]
    pub pump_program: UncheckedAccount<'info>,
    /// CHECK: canonical LP mint authenticated by PumpSwap and SPL burn.
    #[account(mut,seeds=[b"pool_lp_mint",pool.key().as_ref()],bump,seeds::program=PUMP_SWAP)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: canonical authority LP ATA checked before use.
    #[account(mut)]
    pub user_lp: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
fn call<'info>(
    name: &str,
    infos: Vec<AccountInfo<'info>>,
    writable: &[usize],
    signer: usize,
    args: &[u64],
    seeds: &[&[u8]],
) -> Result<()> {
    let accounts = infos
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if writable.contains(&i) {
                AccountMeta::new(*a.key, i == signer)
            } else {
                AccountMeta::new_readonly(*a.key, i == signer)
            }
        })
        .collect();
    let mut data = hash(format!("global:{name}").as_bytes()).to_bytes()[..8].to_vec();
    for n in args {
        data.extend_from_slice(&n.to_le_bytes())
    }
    invoke_signed(
        &Instruction {
            program_id: PUMP_SWAP,
            accounts,
            data,
        },
        &infos,
        &[seeds],
    )?;
    Ok(())
}
pub fn settle<'info>(
    ctx: Context<'_, '_, '_, 'info, SettlePoolFees<'info>>,
    budget: u64,
    min_tokens: u64,
    min_lp: u64,
    deadline: u64,
) -> Result<()> {
    let a = ctx.accounts;
    let clock = Clock::get()?;
    require!(
        a.launch.graduated
            && !a.launch.cancelled
            && budget > 0
            && budget <= 100_000_000
            && min_tokens > 0
            && clock.slot <= deadline
            && deadline <= clock.slot.saturating_add(20),
        LaunchError::Configuration
    );
    let sniper = a.launch.sniper_fees > 0;
    let liquidity = !sniper && a.launch.args.fee_mode == FeeMode::Liquidity;
    require!(
        sniper || liquidity || a.launch.args.fee_mode == FeeMode::Burn,
        LaunchError::Configuration
    );
    require!(
        budget
            <= if sniper {
                a.launch.sniper_fees
            } else {
                a.launch.coin_fees
            },
        LaunchError::Insolvent
    );
    require!(
        (liquidity && min_lp > 0) || (!liquidity && min_lp == 0),
        LaunchError::Slippage
    );
    require_keys_eq!(
        a.user_lp.key(),
        anchor_spl::associated_token::get_associated_token_address_with_program_id(
            &a.authority.key(),
            &a.lp_mint.key(),
            &token_2022::ID
        ),
        LaunchError::Migration
    );
    let launch_key = a.launch.key();
    let bump = [ctx.bumps.authority];
    let seeds: &[&[u8]] = &[b"migration", launch_key.as_ref(), &bump];
    let before_authority = a.authority.lamports();
    transfer(
        CpiContext::new(
            a.system_program.to_account_info(),
            SolTransfer {
                from: a.operator.to_account_info(),
                to: a.authority.to_account_info(),
            },
        ),
        ADVANCE,
    )?;
    // Synchronize unsolicited SOL deposits before taking the accounting baseline.
    token::sync_native(CpiContext::new(
        a.token_program.to_account_info(),
        token::SyncNative {
            account: a.user_quote.to_account_info(),
        },
    ))?;
    a.user_quote.reload()?;
    let base_before = a.user_base.amount;
    let quote_before = a.user_quote.amount;
    let quote_rent = a
        .user_quote
        .to_account_info()
        .lamports()
        .checked_sub(quote_before)
        .ok_or(LaunchError::Arithmetic)?;
    wrap_reserves(
        &a.launch.to_account_info(),
        &a.authority.to_account_info(),
        &a.user_quote.to_account_info(),
        &a.system_program.to_account_info(),
        &a.token_program.to_account_info(),
        budget,
        seeds,
    )?;
    let buy_budget = if liquidity { budget / 2 } else { budget };
    require!(buy_budget > 0, LaunchError::Configuration);
    call(
        "buy_exact_quote_in_v2",
        vec![
            a.pool.to_account_info(),
            a.authority.to_account_info(),
            a.global_config.to_account_info(),
            a.mint.to_account_info(),
            a.quote_mint.to_account_info(),
            a.user_base.to_account_info(),
            a.user_quote.to_account_info(),
            a.pool_base.to_account_info(),
            a.pool_quote.to_account_info(),
            a.token_program.to_account_info(),
            a.token_program.to_account_info(),
            a.system_program.to_account_info(),
            a.volume.to_account_info(),
            a.fee_config.to_account_info(),
            a.buyback.to_account_info(),
            a.event_authority.to_account_info(),
            a.pump_program.to_account_info(),
        ],
        &[0, 1, 5, 6, 7, 8, 12, 14],
        1,
        &[buy_budget, min_tokens],
        seeds,
    )?;
    a.user_base.reload()?;
    a.user_quote.reload()?;
    let bought = a
        .user_base
        .amount
        .checked_sub(base_before)
        .ok_or(LaunchError::Arithmetic)?;
    require!(bought >= min_tokens, LaunchError::Slippage);
    if liquidity {
        a.pool_base.reload()?;
        a.pool_quote.reload()?;
        let supply = {
            let d = a.pool.try_borrow_data()?;
            require!(d.len() >= 211, LaunchError::Migration);
            u64::from_le_bytes(d[203..211].try_into().map_err(|_| LaunchError::Migration)?)
        };
        let remaining = a
            .user_quote
            .amount
            .checked_sub(quote_before)
            .ok_or(LaunchError::Arithmetic)?;
        require!(
            a.pool_base.amount > 0 && a.pool_quote.amount > 0,
            LaunchError::Migration
        );
        let lp = ((bought as u128) * (supply as u128) / (a.pool_base.amount as u128))
            .min((remaining as u128) * (supply as u128) / (a.pool_quote.amount as u128));
        let lp: u64 = lp.try_into().map_err(|_| LaunchError::Arithmetic)?;
        require!(lp >= min_lp, LaunchError::Slippage);
        call(
            "deposit",
            vec![
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
                a.token_program.to_account_info(),
                a.token_2022_program.to_account_info(),
                a.event_authority.to_account_info(),
                a.pump_program.to_account_info(),
            ],
            &[0, 5, 6, 7, 8, 9, 10],
            2,
            &[lp, bought, remaining],
            seeds,
        )?;
        token_2022::burn(
            CpiContext::new_with_signer(
                a.token_2022_program.to_account_info(),
                token_2022::Burn {
                    mint: a.lp_mint.to_account_info(),
                    from: a.user_lp.to_account_info(),
                    authority: a.authority.to_account_info(),
                },
                &[seeds],
            ),
            lp,
        )?;
        a.user_base.reload()?;
        a.user_quote.reload()?;
    }
    let burn = a
        .user_base
        .amount
        .checked_sub(base_before)
        .ok_or(LaunchError::Arithmetic)?;
    if burn > 0 {
        token::burn(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                token::Burn {
                    mint: a.mint.to_account_info(),
                    from: a.user_base.to_account_info(),
                    authority: a.authority.to_account_info(),
                },
                &[seeds],
            ),
            burn,
        )?;
    }
    let unused = a
        .user_quote
        .amount
        .checked_sub(quote_before)
        .ok_or(LaunchError::Arithmetic)?;
    let spent = budget.checked_sub(unused).ok_or(LaunchError::Arithmetic)?;
    require!(spent > 0, LaunchError::Configuration);
    // Return unused budget and unsolicited WSOL donations to launch custody, then refund only account rent.
    token::close_account(CpiContext::new_with_signer(
        a.token_program.to_account_info(),
        token::CloseAccount {
            account: a.user_quote.to_account_info(),
            destination: a.launch.to_account_info(),
            authority: a.authority.to_account_info(),
        },
        &[seeds],
    ))?;

    let refund = a
        .authority
        .lamports()
        .saturating_sub(before_authority)
        .min(ADVANCE);
    if refund > 0 {
        transfer(
            CpiContext::new_with_signer(
                a.system_program.to_account_info(),
                SolTransfer {
                    from: a.authority.to_account_info(),
                    to: a.operator.to_account_info(),
                },
                &[seeds],
            ),
            refund,
        )?;
    }
    pay_lamports(
        &a.launch.to_account_info(),
        &a.operator.to_account_info(),
        quote_rent,
    )?;
    if sniper {
        a.launch.sniper_fees = a
            .launch
            .sniper_fees
            .checked_sub(spent)
            .ok_or(LaunchError::Arithmetic)?;
    } else {
        a.launch.coin_fees = a
            .launch
            .coin_fees
            .checked_sub(spent)
            .ok_or(LaunchError::Arithmetic)?;
    }
    emit!(PoolFeesSettled {
        launch: launch_key,
        spent,
        burned: burn,
        liquidity,
        sniper
    });
    Ok(())
}
#[event]
pub struct PoolFeesSettled {
    pub launch: Pubkey,
    pub spent: u64,
    pub burned: u64,
    pub liquidity: bool,
    pub sniper: bool,
}
