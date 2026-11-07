//! V1 has fixed classic economics and mandatory shared launch protection.
use crate::*;
use launch_core::classic::{ClassicCurve, SUPPLY};
#[account]
#[derive(InitSpace)]
pub struct ClassicLaunch {
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub pool: Pubkey,
    pub bump: u8,
    pub sold: u64,
    pub quote: u64,
    pub fees: u64,
    pub graduated: bool,
    pub sequence: u64,
    pub buy_slot: u64,
    pub slot_bought: u64,
}
impl ClassicLaunch {
    pub fn curve(&self) -> ClassicCurve {
        ClassicCurve {
            sold: self.sold,
            quote: self.quote,
            fees: self.fees,
        }
    }
    fn apply(&mut self, c: ClassicCurve) {
        self.sold = c.sold;
        self.quote = c.quote;
        self.fees = c.fees;
    }
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ClassicArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}
#[derive(Accounts)]
pub struct CreateClassic<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(init,payer=creator,mint::decimals=6,mint::authority=launch)]
    pub mint: Account<'info, Mint>,
    #[account(init,payer=creator,space=8+ClassicLaunch::INIT_SPACE,seeds=[b"classic",mint.key().as_ref()],bump)]
    pub launch: Account<'info, ClassicLaunch>,
    #[account(init,payer=creator,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: Metaplex PDA checked before the fixed program initializes it.
    #[account(mut,seeds=[b"metadata",metadata::ID.as_ref(),mint.key().as_ref()],bump,seeds::program=metadata::ID)]
    pub metadata: UncheckedAccount<'info>,
    pub metadata_program: Program<'info, Metadata>,
    pub rent: Sysvar<'info, Rent>,
}
pub fn create(ctx: Context<CreateClassic>, args: ClassicArgs) -> Result<()> {
    require!(
        cfg!(feature = "experimental-classic"),
        LaunchError::ModeDisabled
    );
    validate_metadata(&args.name, &args.uri)?;
    require!(
        !args.symbol.is_empty()
            && args.symbol.len() <= 10
            && !args.symbol.chars().any(char::is_control),
        LaunchError::Configuration
    );
    let l = &mut ctx.accounts.launch;
    l.creator = ctx.accounts.creator.key();
    l.mint = ctx.accounts.mint.key();
    l.treasury = ctx.accounts.config.treasury;
    l.bump = ctx.bumps.launch;
    let mint = l.mint;
    let bump = [l.bump];
    let seeds: &[&[u8]] = &[b"classic", mint.as_ref(), &bump];
    token::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: l.to_account_info(),
            },
            &[seeds],
        ),
        SUPPLY,
    )?;
    metadata::create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            ctx.accounts.metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: ctx.accounts.metadata.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                mint_authority: l.to_account_info(),
                payer: ctx.accounts.creator.to_account_info(),
                update_authority: l.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
                rent: ctx.accounts.rent.to_account_info(),
            },
            &[seeds],
        ),
        DataV2 {
            name: args.name.clone(),
            symbol: args.symbol.clone(),
            uri: args.uri.clone(),
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        false,
        true,
        None,
    )?;
    token::set_authority(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            SetAuthority {
                current_authority: l.to_account_info(),
                account_or_mint: ctx.accounts.mint.to_account_info(),
            },
            &[seeds],
        ),
        AuthorityType::MintTokens,
        None,
    )?;
    emit!(LaunchCreated {
        launch: l.key(),
        mint: l.mint,
        creator: l.creator,
        treasury: l.treasury
    });
    emit!(LaunchVersionSelected {
        launch: l.key(),
        mint: l.mint,
        version: 1
    });
    emit!(TokenMetadataPublished {
        launch: l.key(),
        name: args.name,
        symbol: args.symbol,
        uri: args.uri
    });
    Ok(())
}
#[derive(Accounts)]
pub struct TradeClassic<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut,seeds=[b"classic",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, ClassicLaunch>,
    #[account(address=launch.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed,payer=trader,associated_token::mint=mint,associated_token::authority=trader)]
    pub wallet_tokens: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
pub fn trade(
    ctx: Context<TradeClassic>,
    tokens: u64,
    limit: u64,
    deadline: u64,
    buy: bool,
) -> Result<()> {
    let clock = Clock::get()?;
    require!(clock.slot <= deadline, LaunchError::Expired);
    let l = &mut ctx.accounts.launch;
    require!(!l.graduated, LaunchError::Closed);
    let mut c = l.curve();
    let fill = if buy {
        c.buy(tokens, limit)
    } else {
        c.sell(tokens, limit)
    }
    .map_err(core_error)?;
    if buy {
        let (slot, bought) =
            launch_protection::check(l.buy_slot, l.slot_bought, clock.slot, tokens, SUPPLY)?;
        l.buy_slot = slot;
        l.slot_bought = bought;
    }
    let mint = l.mint;
    let bump = [l.bump];
    let seeds: &[&[u8]] = &[b"classic", mint.as_ref(), &bump];
    if buy {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: l.to_account_info(),
                },
            ),
            fill.wallet_lamports,
        )?;
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.wallet_tokens.to_account_info(),
                    authority: l.to_account_info(),
                },
                &[seeds],
            ),
            tokens,
        )?;
    } else {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.wallet_tokens.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            tokens,
        )?;
        pay_lamports(
            &l.to_account_info(),
            &ctx.accounts.trader.to_account_info(),
            fill.wallet_lamports,
        )?;
    }
    l.apply(c);
    l.sequence = l.sequence.checked_add(1).ok_or(LaunchError::Arithmetic)?;
    emit!(TradeRecorded {
        launch: l.key(),
        trader: ctx.accounts.trader.key(),
        sequence: l.sequence,
        buy,
        tokens,
        quote: fill.principal,
        fee: fill.fee
    });
    Ok(())
}
#[derive(Accounts)]
pub struct CollectClassicFees<'info> {
    #[account(mut,seeds=[b"classic",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, ClassicLaunch>,
    /// CHECK: immutable destination; permissionless collection cannot redirect funds.
    #[account(mut,address=launch.treasury)]
    pub treasury: UncheckedAccount<'info>,
}
pub fn collect(ctx: Context<CollectClassicFees>) -> Result<()> {
    let amount = ctx.accounts.launch.fees;
    if amount > 0 {
        pay_lamports(
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            amount,
        )?;
        ctx.accounts.launch.fees = 0;
    }
    Ok(())
}
#[event]
pub struct LaunchVersionSelected {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub version: u8,
}
