use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer as SolTransfer};
use anchor_spl::metadata::{
    self, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::spl_token::instruction::AuthorityType;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer},
};
use launch_core::fees::{Entitlement, Rewards};
use launch_core::{Config as CurveConfig, Curve};
pub mod launch_protection;
pub mod ticker_expiry;
use ticker_expiry::*;
pub mod settlement;
use settlement::*;
pub mod recovery;
use recovery::*;
pub mod activation;
pub mod app_access;
pub mod governance;
pub mod social_rewards;
use activation::*;
use app_access::*;
use social_rewards::*;
pub mod creator_features;
use creator_features::*;
pub mod classic;
use classic::*;
pub mod classic_migration;
pub mod graduation_costs;
use classic_migration::*;
pub mod migration;
use governance::*;
use migration::*;
// Project-specific deployment identifier; signing material stays outside release bundles.
declare_id!("FretS4xrZsx8VHf7Aw8VbishTRskq3nbmpQKuyHbJxAz");
#[program]
pub mod custom_launchpad {
    use super::*;
    pub fn create_classic(ctx: Context<CreateClassic>, args: ClassicArgs) -> Result<()> {
        classic::create(ctx, args)
    }
    pub fn buy_classic(
        ctx: Context<TradeClassic>,
        tokens: u64,
        max_lamports: u64,
        deadline_slot: u64,
    ) -> Result<()> {
        classic::trade(ctx, tokens, max_lamports, deadline_slot, true)
    }
    pub fn sell_classic(
        ctx: Context<TradeClassic>,
        tokens: u64,
        min_lamports: u64,
        deadline_slot: u64,
    ) -> Result<()> {
        classic::trade(ctx, tokens, min_lamports, deadline_slot, false)
    }
    pub fn collect_classic_fees(ctx: Context<CollectClassicFees>) -> Result<()> {
        classic::collect(ctx)
    }
    pub fn graduate_classic<'info>(
        ctx: Context<'_, '_, '_, 'info, GraduateClassic<'info>>,
    ) -> Result<()> {
        classic_migration::graduate(ctx)
    }
    pub fn create_v11(ctx: Context<CreateLaunch>, args: LaunchArgs) -> Result<()> {
        create_launch(ctx, args)
    }
    pub fn collect_creator_fees(ctx: Context<CollectCreatorFees>) -> Result<()> {
        creator_features::collect(ctx)
    }
    pub fn lock_creator_tokens(ctx: Context<LockCreatorTokens>, amount: u64) -> Result<()> {
        creator_features::lock(ctx, amount)
    }
    pub fn claim_creator_vesting(ctx: Context<ClaimCreatorVesting>) -> Result<()> {
        creator_features::claim(ctx)
    }
    pub fn initialize(ctx: Context<Initialize>, treasury: Pubkey) -> Result<()> {
        require!(treasury != Pubkey::default(), LaunchError::Configuration);
        ctx.accounts.config.treasury = treasury;
        ctx.accounts.config.bump = ctx.bumps.config;
        ctx.accounts.config.metadata_authority = ctx.accounts.authority.key();
        Ok(())
    }
    pub fn propose_metadata(
        ctx: Context<ProposeMetadata>,
        nonce: u64,
        name: String,
        uri: String,
    ) -> Result<()> {
        governance::propose(ctx, nonce, name, uri)
    }
    pub fn like_metadata(ctx: Context<LikeMetadata>) -> Result<()> {
        governance::like(ctx)
    }
    pub fn execute_metadata(ctx: Context<ExecuteMetadata>) -> Result<()> {
        governance::execute(ctx)
    }
    pub fn publish_social_round(
        ctx: Context<PublishSocialRound>,
        hour: u64,
        root: [u8; 32],
        budget: u64,
    ) -> Result<()> {
        social_rewards::publish(ctx, hour, root, budget)
    }
    pub fn claim_social_reward(
        ctx: Context<ClaimSocialReward>,
        amount: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        social_rewards::claim(ctx, amount, proof)
    }
    pub fn expire_social_round(ctx: Context<ExpireSocialRound>) -> Result<()> {
        social_rewards::expire(ctx)
    }
    pub fn register_app(ctx: Context<RegisterApp>, name: String) -> Result<()> {
        app_access::register(ctx, name)
    }
    pub fn request_activation(
        ctx: Context<RequestActivation>,
        seed: [u8; 32],
        max_fee: u64,
    ) -> Result<()> {
        activation::request(ctx, seed, max_fee)
    }
    pub fn settle_pool_fees<'info>(
        ctx: Context<'_, '_, '_, 'info, SettlePoolFees<'info>>,
        budget: u64,
        min_tokens: u64,
        min_lp: u64,
        deadline: u64,
    ) -> Result<()> {
        settlement::settle(ctx, budget, min_tokens, min_lp, deadline)
    }
    pub fn release_bonded_ticker(
        ctx: Context<ReleaseBondedTicker>,
        last_trade: i64,
        observed_at: i64,
    ) -> Result<()> {
        ticker_expiry::release(ctx, last_trade, observed_at)
    }
    pub fn cancel_launch(ctx: Context<CancelLaunch>) -> Result<()> {
        recovery::cancel(ctx)
    }
    pub fn activate(ctx: Context<Activate>) -> Result<()> {
        activation::activate(ctx)
    }
    pub fn create_launch(ctx: Context<CreateLaunch>, args: LaunchArgs) -> Result<()> {
        require!(
            cfg!(feature = "experimental-receipts"),
            LaunchError::ModeDisabled
        );
        require!(
            !args.ticker.is_empty()
                && args.ticker.len() <= 10
                && args
                    .ticker
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()),
            LaunchError::Configuration
        );
        let now = Clock::get()?;
        validate_metadata(&args.name, &args.uri)?;
        app_access::validate_policy(args.app_mode, &args.app_authorities)?;
        let cfg = args.core(now.slot.checked_add(1).ok_or(LaunchError::Arithmetic)?);
        cfg.validate().map_err(core_error)?;
        require!(
            args.blocked.len() <= 32 && args.extra_blocked_count <= 10_000,
            LaunchError::Configuration
        );
        require!(
            args.supply == 1_000_000_000_000_000,
            LaunchError::Configuration
        );
        require!(
            !(args.quick_bond && args.transfers_open),
            LaunchError::Configuration
        );
        let beneficiary = if args.beneficiary == Pubkey::default() {
            ctx.accounts.creator.key()
        } else {
            args.beneficiary
        };
        require!(
            args.developer_buy_lamports == 0 || !args.blocked.contains(&beneficiary),
            LaunchError::Blocked
        );
        let dev_fee = launch_core::ceil_mul_div(
            args.developer_buy_lamports,
            launch_core::FEE_BPS,
            launch_core::BPS,
        )
        .map_err(core_error)?;
        let dev_net = args
            .developer_buy_lamports
            .checked_sub(dev_fee)
            .ok_or(LaunchError::Arithmetic)?;
        require!(
            args.developer_buy_lamports == 0 || (dev_net > 0 && dev_net < args.target_quote),
            LaunchError::Configuration
        );
        // Maximum developer allocation occurs on an empty curve. Reject at creation,
        // rather than accepting a prefunded allocation that the slot cap cannot execute.
        let dev_tokens = launch_core::mul_div(
            args.virtual_tokens,
            dev_net,
            args.virtual_quote
                .checked_add(dev_net)
                .ok_or(LaunchError::Arithmetic)?,
        )
        .map_err(core_error)?;
        require!(dev_tokens <= args.supply / 100, LaunchError::BuySlotLimit);
        let registry = &mut ctx.accounts.ticker_registry;
        require!(
            registry.launch == Pubkey::default()
                || (!registry.graduated
                    && now.unix_timestamp
                        >= registry
                            .last_trade
                            .checked_add(21_600)
                            .ok_or(LaunchError::Arithmetic)?),
            LaunchError::TickerTaken
        );
        registry.launch = ctx.accounts.launch.key();
        registry.graduated = false;
        registry.last_trade = now.unix_timestamp;
        // Receipt-based pre-graduation trading: no transferable tokens leave custody until migration.
        let l = &mut ctx.accounts.launch;
        l.creator = beneficiary;
        l.launcher = ctx.accounts.creator.key();
        l.mint = ctx.accounts.mint.key();
        l.treasury = ctx.accounts.config.treasury;
        l.bump = ctx.bumps.launch;
        l.args = args;
        l.start_slot = cfg.start_slot;
        l.created_at = now.unix_timestamp;
        l.pool = Pubkey::default();
        l.developer_budget = l.args.developer_buy_lamports;
        l.developer_executed = l.developer_budget == 0;
        if l.developer_budget > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    SolTransfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: l.to_account_info(),
                    },
                ),
                l.developer_budget,
            )?;
        }
        let mint_key = l.mint;
        let bump = [l.bump];
        let seeds: &[&[u8]] = &[b"launch", mint_key.as_ref(), &bump];
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
            cfg.supply,
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
                name: l.args.name.clone(),
                symbol: l.args.ticker.clone(),
                uri: l.args.uri.clone(),
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            true,
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
        emit!(CurveConfigured {
            launch: l.key(),
            sale_tokens: l.args.sale_tokens,
            supply: l.args.supply,
            virtual_tokens: l.args.virtual_tokens,
            virtual_quote: l.args.virtual_quote,
        });
        emit!(LaunchVersionSelected {
            launch: l.key(),
            mint: l.mint,
            version: 11
        });
        emit!(TokenMetadataPublished {
            launch: l.key(),
            name: l.args.name.clone(),
            symbol: l.args.ticker.clone(),
            uri: l.args.uri.clone()
        });
        Ok(())
    }
    pub fn buy(
        ctx: Context<Trade>,
        gross_lamports: u64,
        min_tokens: u64,
        deadline_slot: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        app_access::check(
            &ctx.accounts.launch,
            &ctx.accounts.app_authority,
            &ctx.accounts.app_record,
        )?;
        let l = &mut ctx.accounts.launch;
        require!(l.randomness_ready, LaunchError::NotActivated);
        require!(
            l.blocked_uploaded == l.args.extra_blocked_count,
            LaunchError::NotActivated
        );
        require!(
            *ctx.accounts.blocked_record.owner != crate::ID,
            LaunchError::Blocked
        );
        require!(
            !l.args.blocked.contains(&ctx.accounts.trader.key()),
            LaunchError::Blocked
        );
        if !l.developer_executed {
            let end = l
                .start_slot
                .checked_add(l.args.protection_slots)
                .ok_or(LaunchError::Arithmetic)?;
            require!(clock.slot < end, LaunchError::DeveloperPending);
        }
        let p = &mut ctx.accounts.position;
        bind_position(p, l.key(), ctx.accounts.trader.key())?;
        settle_rewards(l, p)?;
        let mut curve = l.curve();
        let f = curve
            .buy(
                l.core(),
                gross_lamports,
                min_tokens,
                p.balance,
                clock.slot,
                deadline_slot,
            )
            .map_err(core_error)?;
        let (buy_slot, slot_bought) = launch_protection::check(
            l.buy_slot,
            l.slot_bought,
            clock.slot,
            f.tokens,
            l.args.supply,
        )?;
        l.buy_slot = buy_slot;
        l.slot_bought = slot_bought;
        reserve_developer_capacity(l, curve.quote)?;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                SolTransfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: l.to_account_info(),
                },
            ),
            gross_lamports,
        )?;
        p.balance = p
            .balance
            .checked_add(f.tokens)
            .ok_or(LaunchError::Arithmetic)?;
        // Creator purchases stay locked for the full 24h from each purchase, including after graduation.
        if ctx.accounts.trader.key() == l.creator {
            p.locked = p
                .locked
                .checked_add(f.tokens)
                .ok_or(LaunchError::Arithmetic)?;
            p.unlock_at = clock
                .unix_timestamp
                .checked_add(launch_core::DEV_LOCK_SECONDS)
                .ok_or(LaunchError::Arithmetic)?;
        }
        let sniper =
            l.core().fee_bps(clock.slot).map_err(core_error)? == launch_core::SNIPER_FEE_BPS;
        if sniper {
            curve.coin_fees = curve
                .coin_fees
                .checked_sub(f.coin_fee)
                .ok_or(LaunchError::Arithmetic)?;
            l.sniper_fees = l
                .sniper_fees
                .checked_add(f.coin_fee)
                .ok_or(LaunchError::Arithmetic)?;
            l.sniper_tax_total = l
                .sniper_tax_total
                .checked_add(f.coin_fee)
                .ok_or(LaunchError::Arithmetic)?;
        }
        l.apply(curve);
        allocate_rewards(l, if sniper { 0 } else { f.coin_fee })?;
        if ctx.accounts.ticker_registry.launch == l.key() {
            ctx.accounts.ticker_registry.last_trade = clock.unix_timestamp;
        }
        l.sequence = l.sequence.checked_add(1).ok_or(LaunchError::Arithmetic)?;
        emit!(TradeRecorded {
            launch: l.key(),
            trader: ctx.accounts.trader.key(),
            sequence: l.sequence,
            buy: true,
            tokens: f.tokens,
            quote: f.net_quote,
            fee: f.fee
        });
        Ok(())
    }
    pub fn sell(
        ctx: Context<Trade>,
        tokens: u64,
        min_lamports: u64,
        deadline_slot: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let l = &mut ctx.accounts.launch;
        require!(l.randomness_ready, LaunchError::NotActivated);
        require!(
            l.blocked_uploaded == l.args.extra_blocked_count,
            LaunchError::NotActivated
        );
        require!(
            *ctx.accounts.blocked_record.owner != crate::ID,
            LaunchError::Blocked
        );
        require!(
            !l.args.blocked.contains(&ctx.accounts.trader.key()),
            LaunchError::Blocked
        );
        require!(
            !l.args.quick_bond
                || clock.unix_timestamp
                    >= l.created_at
                        .checked_add(3600)
                        .ok_or(LaunchError::Arithmetic)?,
            LaunchError::SellLocked
        );
        let p = &mut ctx.accounts.position;
        bind_position(p, l.key(), ctx.accounts.trader.key())?;
        settle_rewards(l, p)?;
        let locked = if clock.unix_timestamp < p.unlock_at {
            p.locked
        } else {
            0
        };
        let mut curve = l.curve();
        let f = curve
            .sell(
                l.core(),
                tokens,
                min_lamports,
                p.balance,
                locked,
                clock.slot,
                deadline_slot,
            )
            .map_err(core_error)?;
        pay_lamports(
            &l.to_account_info(),
            &ctx.accounts.trader.to_account_info(),
            f.net_quote,
        )?;
        p.balance = p
            .balance
            .checked_sub(tokens)
            .ok_or(LaunchError::Arithmetic)?;
        if locked == 0 {
            p.locked = 0;
        }
        let sniper =
            l.core().fee_bps(clock.slot).map_err(core_error)? == launch_core::SNIPER_FEE_BPS;
        if sniper {
            curve.coin_fees = curve
                .coin_fees
                .checked_sub(f.coin_fee)
                .ok_or(LaunchError::Arithmetic)?;
            l.sniper_fees = l
                .sniper_fees
                .checked_add(f.coin_fee)
                .ok_or(LaunchError::Arithmetic)?;
            l.sniper_tax_total = l
                .sniper_tax_total
                .checked_add(f.coin_fee)
                .ok_or(LaunchError::Arithmetic)?;
        }
        l.apply(curve);
        allocate_rewards(l, if sniper { 0 } else { f.coin_fee })?;
        if ctx.accounts.ticker_registry.launch == l.key() {
            ctx.accounts.ticker_registry.last_trade = clock.unix_timestamp;
        }
        l.sequence = l.sequence.checked_add(1).ok_or(LaunchError::Arithmetic)?;
        emit!(TradeRecorded {
            launch: l.key(),
            trader: ctx.accounts.trader.key(),
            sequence: l.sequence,
            buy: false,
            tokens: f.tokens,
            quote: f.net_quote,
            fee: f.fee
        });
        Ok(())
    }
    /// Move beneficial ownership while the same SPL mint remains in program custody.
    /// No transfer hook, secondary mint or unrestricted pre-graduation withdrawal.
    pub fn transfer_position(
        ctx: Context<TransferPosition>,
        amount: u64,
        deadline_slot: u64,
    ) -> Result<()> {
        let clock = Clock::get()?;
        let l = &mut ctx.accounts.launch;
        require!(
            l.blocked_uploaded == l.args.extra_blocked_count,
            LaunchError::NotActivated
        );
        require!(
            l.args.transfers_open && !l.args.quick_bond,
            LaunchError::TransfersDisabled
        );
        require!(
            *ctx.accounts.source_blocked.owner != crate::ID
                && *ctx.accounts.destination_blocked.owner != crate::ID,
            LaunchError::Blocked
        );
        require!(!l.graduated, LaunchError::Closed);
        require!(clock.slot <= deadline_slot, LaunchError::Expired);
        require!(amount > 0, LaunchError::ZeroAmount);
        let sender = ctx.accounts.owner.key();
        let recipient = ctx.accounts.recipient.key();
        require!(
            sender != recipient && recipient != Pubkey::default(),
            LaunchError::WrongAccount
        );
        require!(
            !l.args.blocked.contains(&sender) && !l.args.blocked.contains(&recipient),
            LaunchError::Blocked
        );
        let from = &mut ctx.accounts.source;
        let to = &mut ctx.accounts.destination;
        bind_position(to, l.key(), recipient)?;
        settle_rewards(l, from)?;
        settle_rewards(l, to)?;
        let locked = if clock.unix_timestamp < from.unlock_at {
            from.locked
        } else {
            0
        };
        let available = from
            .balance
            .checked_sub(locked)
            .ok_or(LaunchError::Arithmetic)?;
        require!(amount <= available, LaunchError::Locked);
        let next = to
            .balance
            .checked_add(amount)
            .ok_or(LaunchError::Arithmetic)?;
        let cap = launch_core::mul_div(l.args.supply, l.args.max_wallet_bps, launch_core::BPS)
            .map_err(core_error)?;
        require!(next <= cap, LaunchError::Cap);
        from.balance = from
            .balance
            .checked_sub(amount)
            .ok_or(LaunchError::Arithmetic)?;
        if locked == 0 {
            from.locked = 0;
        }
        to.balance = next;
        // Receiving into the creator account must not bypass its holding lock.
        if recipient == l.creator {
            to.locked = to
                .locked
                .checked_add(amount)
                .ok_or(LaunchError::Arithmetic)?;
            to.unlock_at = clock
                .unix_timestamp
                .checked_add(launch_core::DEV_LOCK_SECONDS)
                .ok_or(LaunchError::Arithmetic)?;
        }
        l.sequence = l.sequence.checked_add(1).ok_or(LaunchError::Arithmetic)?;
        emit!(PositionTransferred {
            launch: l.key(),
            sender,
            recipient,
            amount,
            sequence: l.sequence
        });
        Ok(())
    }
    pub fn add_blocked_wallet(ctx: Context<AddBlockedWallet>, wallet: Pubkey) -> Result<()> {
        let l = &mut ctx.accounts.launch;
        require!(
            l.blocked_uploaded < l.args.extra_blocked_count,
            LaunchError::BlocklistSealed
        );
        require!(
            wallet != Pubkey::default() && !l.args.blocked.contains(&wallet),
            LaunchError::Configuration
        );
        require!(
            l.developer_budget == 0 || wallet != l.creator,
            LaunchError::Blocked
        );
        ctx.accounts.record.launch = l.key();
        ctx.accounts.record.wallet = wallet;
        l.blocked_uploaded = l
            .blocked_uploaded
            .checked_add(1)
            .ok_or(LaunchError::Arithmetic)?;
        // Trading cannot start with a partly uploaded list. Final entry starts all clocks.
        if l.blocked_uploaded == l.args.extra_blocked_count {
            let clock = Clock::get()?;
            l.start_slot = clock.slot.checked_add(1).ok_or(LaunchError::Arithmetic)?;
            l.created_at = clock.unix_timestamp;
        }
        Ok(())
    }
    /// Idempotent paid-workflow wrapper: a keeper may have already allocated it.
    /// The strict entry point below still rejects duplicate direct executions.
    pub fn ensure_developer_buy(ctx: Context<ExecuteDeveloperBuy>) -> Result<()> {
        if ctx.accounts.launch.developer_executed {
            return Ok(());
        }
        execute_developer_buy(ctx)
    }
    /// Permissionless crank; funds and recipient were committed at creation.
    pub fn execute_developer_buy(ctx: Context<ExecuteDeveloperBuy>) -> Result<()> {
        let clock = Clock::get()?;
        let l = &mut ctx.accounts.launch;
        require!(l.randomness_ready, LaunchError::NotActivated);
        require!(
            l.blocked_uploaded == l.args.extra_blocked_count,
            LaunchError::NotActivated
        );
        require!(
            !l.developer_executed && l.developer_budget > 0,
            LaunchError::AlreadyExecuted
        );
        require!(
            !l.args.blocked.contains(&l.creator) && *ctx.accounts.blocked_record.owner != crate::ID,
            LaunchError::Blocked
        );
        let p = &mut ctx.accounts.position;
        bind_position(p, l.key(), l.creator)?;
        settle_rewards(l, p)?;
        let mut curve = l.curve();
        let fill = curve
            .buy_developer(l.core(), l.developer_budget, clock.slot)
            .map_err(core_error)?;
        let (buy_slot, slot_bought) = launch_protection::check(
            l.buy_slot,
            l.slot_bought,
            clock.slot,
            fill.tokens,
            l.args.supply,
        )?;
        l.buy_slot = buy_slot;
        l.slot_bought = slot_bought;
        p.balance = p
            .balance
            .checked_add(fill.tokens)
            .ok_or(LaunchError::Arithmetic)?;
        p.locked = p
            .locked
            .checked_add(fill.tokens)
            .ok_or(LaunchError::Arithmetic)?;
        p.unlock_at = clock
            .unix_timestamp
            .checked_add(launch_core::DEV_LOCK_SECONDS)
            .ok_or(LaunchError::Arithmetic)?;
        l.developer_budget = 0;
        l.developer_executed = true;
        l.apply(curve);
        allocate_rewards(l, fill.coin_fee)?;
        if ctx.accounts.ticker_registry.launch == l.key() {
            ctx.accounts.ticker_registry.last_trade = clock.unix_timestamp;
        }
        l.sequence = l.sequence.checked_add(1).ok_or(LaunchError::Arithmetic)?;
        emit!(TradeRecorded {
            launch: l.key(),
            trader: l.creator,
            sequence: l.sequence,
            buy: true,
            tokens: fill.tokens,
            quote: fill.net_quote,
            fee: fill.fee
        });
        emit!(DeveloperAllocated {
            launch: l.key(),
            owner: l.creator,
            tokens: fill.tokens,
            unlock_at: p.unlock_at
        });
        Ok(())
    }
    pub fn collect_treasury(ctx: Context<CollectTreasury>) -> Result<()> {
        let amount = ctx.accounts.launch.treasury_fees;
        require!(amount > 0, LaunchError::ZeroAmount);
        pay_lamports(
            &ctx.accounts.launch.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            amount,
        )?;
        ctx.accounts.launch.treasury_fees = 0;
        emit!(TreasuryPaid {
            launch: ctx.accounts.launch.key(),
            amount
        });
        Ok(())
    }
    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        let l = &mut ctx.accounts.launch;
        require!(
            l.args.fee_mode == FeeMode::Holders,
            LaunchError::Configuration
        );
        settle_rewards(l, &mut ctx.accounts.position)?;
        let amount = ctx.accounts.position.reward_claimable;
        require!(amount > 0 && amount <= l.coin_fees, LaunchError::ZeroAmount);
        pay_lamports(
            &l.to_account_info(),
            &ctx.accounts.owner.to_account_info(),
            amount,
        )?;
        l.coin_fees = l
            .coin_fees
            .checked_sub(amount)
            .ok_or(LaunchError::Arithmetic)?;
        ctx.accounts.position.reward_claimable = 0;
        emit!(CoinFeesUsed {
            launch: l.key(),
            mode: FeeMode::Holders,
            quote: amount,
            tokens: 0
        });
        Ok(())
    }
    pub fn burn_fees(
        ctx: Context<BurnFees>,
        max_lamports: u64,
        min_tokens: u64,
        deadline_slot: u64,
    ) -> Result<()> {
        require!(Clock::get()?.slot <= deadline_slot, LaunchError::Expired);
        let l = &mut ctx.accounts.launch;
        let use_sniper_fees = l.sniper_fees > 0;
        require!(
            use_sniper_fees || l.args.fee_mode == FeeMode::Burn,
            LaunchError::Configuration
        );
        let mut budget = l.curve();
        if use_sniper_fees {
            budget.coin_fees = l.sniper_fees;
        }
        let plan = launch_core::fees::burn_plan(l.core(), budget, max_lamports, min_tokens)
            .map_err(core_error)?;
        reserve_developer_capacity(
            l,
            l.quote
                .checked_add(plan.quote)
                .ok_or(LaunchError::Arithmetic)?,
        )?;
        let bump = [l.bump];
        let seeds: &[&[u8]] = &[b"launch", l.mint.as_ref(), &bump];
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.vault.to_account_info(),
                    authority: l.to_account_info(),
                },
                &[seeds],
            ),
            plan.tokens,
        )?;
        if use_sniper_fees {
            l.sniper_fees = l
                .sniper_fees
                .checked_sub(plan.quote)
                .ok_or(LaunchError::Arithmetic)?;
        } else {
            l.coin_fees = l
                .coin_fees
                .checked_sub(plan.quote)
                .ok_or(LaunchError::Arithmetic)?;
        }
        l.quote = l
            .quote
            .checked_add(plan.quote)
            .ok_or(LaunchError::Arithmetic)?;
        l.sold = l
            .sold
            .checked_add(plan.tokens)
            .ok_or(LaunchError::Arithmetic)?;
        l.burned = l
            .burned
            .checked_add(plan.tokens)
            .ok_or(LaunchError::Arithmetic)?;
        emit!(CoinFeesUsed {
            launch: l.key(),
            mode: FeeMode::Burn,
            quote: plan.quote,
            tokens: plan.tokens
        });
        Ok(())
    }
    pub fn graduate<'info>(ctx: Context<'_, '_, '_, 'info, Graduate<'info>>) -> Result<()> {
        migration::graduate(ctx)
    }
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let l = &ctx.accounts.launch;
        require!(l.graduated, LaunchError::NotGraduated);
        let p = &mut ctx.accounts.position;
        settle_rewards(l, p)?;
        let locked = if Clock::get()?.unix_timestamp < p.unlock_at {
            p.locked
        } else {
            0
        };
        let amount = p
            .balance
            .checked_sub(locked)
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
        p.balance = locked;
        if locked == 0 {
            p.locked = 0;
        }
        emit!(TokensClaimed {
            launch: l.key(),
            owner: ctx.accounts.owner.key(),
            amount
        });
        Ok(())
    }
    pub fn claim_for(ctx: Context<ClaimFor>) -> Result<()> {
        let l = &ctx.accounts.launch;
        require!(l.graduated, LaunchError::NotGraduated);
        let p = &mut ctx.accounts.position;
        settle_rewards(l, p)?;
        let locked = if Clock::get()?.unix_timestamp < p.unlock_at {
            p.locked
        } else {
            0
        };
        let amount = p
            .balance
            .checked_sub(locked)
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
        p.balance = locked;
        if locked == 0 {
            p.locked = 0;
        }
        emit!(TokensClaimed {
            launch: l.key(),
            owner: ctx.accounts.owner.key(),
            amount
        });
        Ok(())
    }
}
fn settle_rewards(l: &Launch, p: &mut Position) -> Result<()> {
    if l.args.fee_mode != FeeMode::Holders {
        return Ok(());
    }
    let mut e = Entitlement {
        checkpoint: p.reward_checkpoint,
        fractional: p.reward_fractional,
        claimable: p.reward_claimable,
    };
    e.settle(
        Rewards {
            index: l.reward_index,
            waiting: l.reward_waiting,
        },
        p.balance,
    )
    .map_err(core_error)?;
    p.reward_checkpoint = e.checkpoint;
    p.reward_fractional = e.fractional;
    p.reward_claimable = e.claimable;
    Ok(())
}
fn allocate_rewards(l: &mut Launch, fee: u64) -> Result<()> {
    if l.args.fee_mode != FeeMode::Holders {
        return Ok(());
    }
    let mut r = Rewards {
        index: l.reward_index,
        waiting: l.reward_waiting,
    };
    r.distribute(
        fee,
        l.sold
            .checked_sub(l.burned)
            .ok_or(LaunchError::Arithmetic)?,
    )
    .map_err(core_error)?;
    l.reward_index = r.index;
    l.reward_waiting = r.waiting;
    Ok(())
}
fn bind_position(p: &mut Account<Position>, launch: Pubkey, owner: Pubkey) -> Result<()> {
    if p.owner == Pubkey::default() {
        p.owner = owner;
        p.launch = launch;
    }
    require_keys_eq!(p.owner, owner, LaunchError::WrongAccount);
    require_keys_eq!(p.launch, launch, LaunchError::WrongAccount);
    Ok(())
}
/// Move reserves through the launch's system-owned migration PDA before wrapping.
/// Both sides of the direct debit are present at the System CPI boundary. SyncNative
/// then receives its canonical one-account ABI, including on strict SPL versions.
pub(crate) fn wrap_reserves<'info>(
    launch: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    quote: &AccountInfo<'info>,
    system: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[u8]],
) -> Result<()> {
    use anchor_lang::solana_program::{
        instruction::AccountMeta, program::invoke_signed, system_instruction,
    };
    pay_lamports(launch, authority, amount)?;
    let mut instruction = system_instruction::transfer(authority.key, quote.key, amount);
    instruction
        .accounts
        .push(AccountMeta::new(*launch.key, false));
    invoke_signed(
        &instruction,
        &[
            authority.clone(),
            quote.clone(),
            launch.clone(),
            system.clone(),
        ],
        &[seeds],
    )?;
    token::sync_native(CpiContext::new(
        token_program.clone(),
        token::SyncNative {
            account: quote.clone(),
        },
    ))?;
    Ok(())
}
pub(crate) fn pay_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    require!(from.key != to.key, LaunchError::WrongAccount);
    let left = from
        .lamports()
        .checked_sub(amount)
        .ok_or(LaunchError::Insolvent)?;
    require!(
        left >= Rent::get()?.minimum_balance(from.data_len()),
        LaunchError::Insolvent
    );
    let dest = to
        .lamports()
        .checked_add(amount)
        .ok_or(LaunchError::Arithmetic)?;
    **from.try_borrow_mut_lamports()? = left;
    **to.try_borrow_mut_lamports()? = dest;
    Ok(())
}
fn core_error(e: launch_core::Error) -> anchor_lang::error::Error {
    match e {
        launch_core::Error::Slippage => error!(LaunchError::Slippage),
        launch_core::Error::Cap => error!(LaunchError::Cap),
        launch_core::Error::Locked => error!(LaunchError::Locked),
        launch_core::Error::Closed => error!(LaunchError::Closed),
        launch_core::Error::Expired => error!(LaunchError::Expired),
        _ => error!(LaunchError::Configuration),
    }
}
fn validate_metadata(name: &str, uri: &str) -> Result<()> {
    require!(
        !name.trim().is_empty() && name.len() <= 32 && !name.chars().any(char::is_control),
        LaunchError::Configuration
    );
    require!(
        uri.len() <= 200
            && !uri.chars().any(char::is_whitespace)
            && !uri.chars().any(char::is_control)
            && ((uri.starts_with("https://") && uri.len() > 8)
                || (uri.starts_with("ipfs://") && uri.len() > 7)
                || (uri.starts_with("ar://") && uri.len() > 5)),
        LaunchError::Configuration
    );
    Ok(())
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct LaunchArgs {
    #[max_len(10)]
    pub ticker: String,
    pub supply: u64,
    pub sale_tokens: u64,
    pub virtual_tokens: u64,
    pub virtual_quote: u64,
    pub target_quote: u64,
    pub max_wallet_bps: u64,
    pub protection_slots: u64,
    pub fee_mode: FeeMode,
    #[max_len(32)]
    pub blocked: Vec<Pubkey>,
    pub transfers_open: bool,
    pub quick_bond: bool,
    pub extra_blocked_count: u16,
    pub developer_buy_lamports: u64,
    pub beneficiary: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(200)]
    pub uri: String,
    pub app_mode: u8,
    #[max_len(8)]
    pub app_authorities: Vec<Pubkey>,
}
impl LaunchArgs {
    fn core(&self, start_slot: u64) -> CurveConfig {
        CurveConfig {
            supply: self.supply,
            sale_tokens: self.sale_tokens,
            virtual_tokens: self.virtual_tokens,
            virtual_quote: self.virtual_quote,
            target_quote: self.target_quote,
            max_wallet_bps: self.max_wallet_bps,
            start_slot,
            protection_slots: self.protection_slots,
        }
    }
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq)]
pub enum FeeMode {
    Burn,
    Holders,
    Liquidity,
    Yap,
    Creator,
}
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub treasury: Pubkey,
    pub bump: u8,
    pub metadata_authority: Pubkey,
}
#[account]
#[derive(InitSpace)]
pub struct Launch {
    pub launcher: Pubkey,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub pool: Pubkey,
    pub bump: u8,
    pub args: LaunchArgs,
    pub start_slot: u64,
    pub created_at: i64,
    pub sold: u64,
    pub quote: u64,
    pub treasury_fees: u64,
    pub coin_fees: u64,
    pub graduated: bool,
    pub sequence: u64,
    pub burned: u64,
    pub reward_index: u128,
    pub reward_waiting: u64,
    pub blocked_uploaded: u16,
    pub sniper_fees: u64,
    pub sniper_tax_total: u64,
    pub developer_budget: u64,
    pub developer_executed: bool,
    pub randomness_request: Pubkey,
    pub activation_requested: bool,
    pub randomness_ready: bool,
    pub cancelled: bool,
    pub graduated_at: i64,
    pub buy_slot: u64,
    pub slot_bought: u64,
}
impl Launch {
    pub fn core(&self) -> CurveConfig {
        self.args.core(self.start_slot)
    }
    pub fn curve(&self) -> Curve {
        Curve {
            sold: self.sold,
            quote: self.quote,
            treasury_fees: self.treasury_fees,
            coin_fees: self.coin_fees,
            graduated: self.graduated,
        }
    }
    fn apply(&mut self, c: Curve) {
        self.sold = c.sold;
        self.quote = c.quote;
        self.treasury_fees = c.treasury_fees;
        self.coin_fees = c.coin_fees;
        self.graduated = c.graduated;
    }
}
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub launch: Pubkey,
    pub balance: u64,
    pub locked: u64,
    pub unlock_at: i64,
    pub reward_checkpoint: u128,
    pub reward_fractional: u128,
    pub reward_claimable: u64,
}
#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init,payer=authority,space=8+Config::INIT_SPACE,seeds=[b"config"],bump)]
    pub config: Account<'info, Config>,
    #[account(constraint=program.programdata_address()?==Some(program_data.key()))]
    pub program: Program<'info, crate::program::CustomLaunchpad>,
    #[account(constraint=program_data.upgrade_authority_address==Some(authority.key()))]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(args: LaunchArgs)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds=[b"config"],bump=config.bump)]
    pub config: Account<'info, Config>,
    #[account(init,payer=creator,mint::decimals=6,mint::authority=launch)]
    pub mint: Account<'info, Mint>,
    #[account(init,payer=creator,space=8+Launch::INIT_SPACE,seeds=[b"launch",mint.key().as_ref()],bump)]
    pub launch: Account<'info, Launch>,
    #[account(init,payer=creator,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed,payer=creator,space=8+TickerRegistry::INIT_SPACE,seeds=[b"ticker",args.ticker.as_bytes()],bump)]
    pub ticker_registry: Account<'info, TickerRegistry>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    /// CHECK: canonical Metaplex PDA; the fixed metadata program initializes it.
    #[account(mut,seeds=[b"metadata",metadata::ID.as_ref(),mint.key().as_ref()],bump,seeds::program=metadata::ID)]
    pub metadata: UncheckedAccount<'info>,
    pub metadata_program: Program<'info, Metadata>,
    pub rent: Sysvar<'info, Rent>,
}
#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(init_if_needed,payer=trader,space=8+Position::INIT_SPACE,seeds=[b"position",launch.key().as_ref(),trader.key().as_ref()],bump)]
    pub position: Account<'info, Position>,
    /// CHECK: fixed PDA; existence under this program means the wallet is blocked.
    #[account(seeds=[b"blocked",launch.key().as_ref(),trader.key().as_ref()],bump)]
    pub blocked_record: UncheckedAccount<'info>,
    #[account(mut,seeds=[b"ticker",launch.args.ticker.as_bytes()],bump)]
    pub ticker_registry: Account<'info, TickerRegistry>,
    pub system_program: Program<'info, System>,
    pub app_authority: Option<Signer<'info>>,
    pub app_record: Option<Account<'info, RegisteredApp>>,
}
#[derive(Accounts)]
pub struct CollectTreasury<'info> {
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    /// CHECK: immutable destination; receives SOL only.
    #[account(mut,address=launch.treasury)]
    pub treasury: UncheckedAccount<'info>,
}
#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(address=launch.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut,seeds=[b"position",launch.key().as_ref(),owner.key().as_ref()],bump,has_one=owner,has_one=launch)]
    pub position: Account<'info, Position>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed,payer=owner,associated_token::mint=mint,associated_token::authority=owner)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
#[event]
pub struct LaunchCreated {
    pub launch: Pubkey,
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub treasury: Pubkey,
}
#[event]
pub struct TokenMetadataPublished {
    pub launch: Pubkey,
    pub name: String,
    pub symbol: String,
    pub uri: String,
}
#[event]
pub struct TradeRecorded {
    pub launch: Pubkey,
    pub trader: Pubkey,
    pub sequence: u64,
    pub buy: bool,
    pub tokens: u64,
    pub quote: u64,
    pub fee: u64,
}
#[event]
pub struct TreasuryPaid {
    pub launch: Pubkey,
    pub amount: u64,
}
#[event]
pub struct TokensClaimed {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
}
#[event]
pub struct Graduated {
    pub launch: Pubkey,
    pub pool: Pubkey,
    pub quote: u64,
    pub tokens: u64,
}
#[error_code]
pub enum LaunchError {
    #[msg("Invalid or unsupported launch configuration")]
    Configuration,
    #[msg("Arithmetic overflow")]
    Arithmetic,
    #[msg("Slippage bound exceeded")]
    Slippage,
    #[msg("Wallet cap exceeded")]
    Cap,
    #[msg("Developer tokens are still locked")]
    Locked,
    #[msg("Curve is not open for trading")]
    Closed,
    #[msg("Quote has expired")]
    Expired,
    #[msg("Wallet is blocked for this launch")]
    Blocked,
    #[msg("Account identity mismatch")]
    WrongAccount,
    #[msg("Insufficient reserves or rent")]
    Insolvent,
    #[msg("Launch has not graduated")]
    NotGraduated,
    #[msg("Nothing to collect")]
    ZeroAmount,
    #[msg("Migration validation failed")]
    Migration,
    #[msg("Mode is not yet enabled for execution")]
    ModeDisabled,
    #[msg("Pre-graduation transfers are disabled")]
    TransfersDisabled,
    #[msg("Quick Bond selling opens one hour after activation")]
    SellLocked,
    #[msg("Blocklist upload must finish before trading")]
    NotActivated,
    #[msg("Blocklist is sealed")]
    BlocklistSealed,
    #[msg("Ticker remains reserved until six hours without a trade")]
    TickerTaken,
    #[msg("Committed developer allocation must execute first")]
    DeveloperPending,
    #[msg("Allocation has already executed")]
    AlreadyExecuted,
    #[msg("Launch protection: purchases across all wallets exceed 1% of supply in this slot; reduce the buy or retry next slot")]
    BuySlotLimit,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(mut,seeds=[b"position",launch.key().as_ref(),owner.key().as_ref()],bump,has_one=owner,has_one=launch)]
    pub position: Account<'info, Position>,
}
#[derive(Accounts)]
pub struct BurnFees<'info> {
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(mut,address=launch.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}
#[event]
pub struct CoinFeesUsed {
    pub launch: Pubkey,
    pub mode: FeeMode,
    pub quote: u64,
    pub tokens: u64,
}

#[derive(Accounts)]
pub struct TransferPosition<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: identity only; recipient must be a system-owned account, receives no SOL here.
    #[account(owner=anchor_lang::system_program::ID)]
    pub recipient: UncheckedAccount<'info>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(mut,seeds=[b"position",launch.key().as_ref(),owner.key().as_ref()],bump,has_one=owner,has_one=launch)]
    pub source: Account<'info, Position>,
    #[account(init_if_needed,payer=owner,space=8+Position::INIT_SPACE,seeds=[b"position",launch.key().as_ref(),recipient.key().as_ref()],bump)]
    pub destination: Account<'info, Position>,
    /// CHECK: deterministic blocklist PDA, checked by owner.
    #[account(seeds=[b"blocked",launch.key().as_ref(),owner.key().as_ref()],bump)]
    pub source_blocked: UncheckedAccount<'info>,
    /// CHECK: deterministic blocklist PDA, checked by owner.
    #[account(seeds=[b"blocked",launch.key().as_ref(),recipient.key().as_ref()],bump)]
    pub destination_blocked: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}
#[event]
pub struct PositionTransferred {
    pub launch: Pubkey,
    pub sender: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub sequence: u64,
}

#[account]
#[derive(InitSpace)]
pub struct BlockedWallet {
    pub launch: Pubkey,
    pub wallet: Pubkey,
}
#[derive(Accounts)]
#[instruction(wallet: Pubkey)]
pub struct AddBlockedWallet<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump,constraint=launch.launcher==creator.key())]
    pub launch: Account<'info, Launch>,
    #[account(init,payer=creator,space=8+BlockedWallet::INIT_SPACE,seeds=[b"blocked",launch.key().as_ref(),wallet.as_ref()],bump)]
    pub record: Account<'info, BlockedWallet>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct TickerRegistry {
    pub launch: Pubkey,
    pub last_trade: i64,
    pub graduated: bool,
}

fn reserve_developer_capacity(l: &Launch, quote_after: u64) -> Result<()> {
    if !l.developer_executed {
        let fee =
            launch_core::ceil_mul_div(l.developer_budget, launch_core::FEE_BPS, launch_core::BPS)
                .map_err(core_error)?;
        let reserved = l
            .developer_budget
            .checked_sub(fee)
            .ok_or(LaunchError::Arithmetic)?;
        require!(
            quote_after
                .checked_add(reserved)
                .ok_or(LaunchError::Arithmetic)?
                <= l.args.target_quote,
            LaunchError::DeveloperPending
        );
    }
    Ok(())
}
#[derive(Accounts)]
pub struct ExecuteDeveloperBuy<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut,seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(init_if_needed,payer=keeper,space=8+Position::INIT_SPACE,seeds=[b"position",launch.key().as_ref(),launch.creator.as_ref()],bump)]
    pub position: Account<'info, Position>,
    /// CHECK: exact immutable blocklist PDA.
    #[account(seeds=[b"blocked",launch.key().as_ref(),launch.creator.as_ref()],bump)]
    pub blocked_record: UncheckedAccount<'info>,
    #[account(mut,seeds=[b"ticker",launch.args.ticker.as_bytes()],bump)]
    pub ticker_registry: Account<'info, TickerRegistry>,
    pub system_program: Program<'info, System>,
}
#[event]
pub struct DeveloperAllocated {
    pub launch: Pubkey,
    pub owner: Pubkey,
    pub tokens: u64,
    pub unlock_at: i64,
}

#[derive(Accounts)]
pub struct ClaimFor<'info> {
    #[account(mut)]
    pub keeper: Signer<'info>,
    /// CHECK: position owner; ATA constraints pin token destination to this owner.
    pub owner: UncheckedAccount<'info>,
    #[account(seeds=[b"launch",launch.mint.as_ref()],bump=launch.bump)]
    pub launch: Account<'info, Launch>,
    #[account(address=launch.mint)]
    pub mint: Account<'info, Mint>,
    #[account(mut,seeds=[b"position",launch.key().as_ref(),owner.key().as_ref()],bump,has_one=owner,has_one=launch)]
    pub position: Account<'info, Position>,
    #[account(mut,associated_token::mint=mint,associated_token::authority=launch)]
    pub vault: Account<'info, TokenAccount>,
    #[account(init_if_needed,payer=keeper,associated_token::mint=mint,associated_token::authority=owner)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct CurveConfigured {
    pub launch: Pubkey,
    pub sale_tokens: u64,
    pub supply: u64,
    pub virtual_tokens: u64,
    pub virtual_quote: u64,
}
