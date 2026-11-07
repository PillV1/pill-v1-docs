#![cfg(feature = "experimental-receipts")]
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use anchor_spl::{associated_token, token};
use custom_launchpad::{accounts, instruction, Config, FeeMode, Launch, LaunchArgs, Position};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    instruction::Instruction,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
include!("migration_round_trip.inc.rs");

fn entry<'a, 'b, 'c, 'd>(
    program: &'a Pubkey,
    accounts: &'b [solana_sdk::account_info::AccountInfo<'c>],
    data: &'d [u8],
) -> solana_sdk::entrypoint::ProgramResult {
    // Anchor's entrypoint ties the slice lifetime to AccountInfo. ProgramTest keeps
    // all AccountInfos alive throughout the synchronous invocation.
    let accounts = unsafe { std::mem::transmute(accounts) };
    custom_launchpad::entry(program, accounts, data)
}
fn strict_token_entry(
    program: &Pubkey,
    accounts: &[solana_sdk::account_info::AccountInfo],
    data: &[u8],
) -> solana_sdk::entrypoint::ProgramResult {
    // Match the current validator's strict SyncNative ABI. The older native
    // SPL processor silently accepts extras and previously hid a graduation bug.
    if data == [17] && accounts.len() != 1 {
        return Err(solana_sdk::program_error::ProgramError::InvalidArgument);
    }
    token::spl_token::processor::Processor::process(program, accounts, data)
}
fn launchpad_test() -> ProgramTest {
    let mut test = if std::env::var("LAUNCHPAD_TEST_SBF").as_deref() == Ok("1") {
        let mut test = ProgramTest::new("custom_launchpad", custom_launchpad::ID, None);
        // Only our program uses the compiled fixture; SPL processors remain the
        // trusted native test implementations added by each scenario below.
        test.prefer_bpf(false);
        test
    } else {
        ProgramTest::new("custom_launchpad", custom_launchpad::ID, processor!(entry))
    };
    test.add_account(
        anchor_spl::metadata::ID,
        Account {
            lamports: 100_000_000,
            data: std::fs::read(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../artifacts/external/token_metadata.so"
            ))
            .unwrap(),
            owner: solana_sdk::bpf_loader::ID,
            executable: true,
            rent_epoch: 0,
        },
    );
    test
}
fn metadata_address(mint: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            b"metadata",
            anchor_spl::metadata::ID.as_ref(),
            mint.as_ref(),
        ],
        &anchor_spl::metadata::ID,
    )
    .0
}
async fn send(
    ctx: &mut ProgramTestContext,
    ix: Instruction,
    extra: &[&Keypair],
) -> Result<(), solana_program_test::BanksClientError> {
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let mut signers = vec![&ctx.payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&ctx.payer.pubkey()), &signers, hash);
    ctx.banks_client.process_transaction(tx).await
}
async fn setup(mode: FeeMode) -> (ProgramTestContext, Pubkey, Pubkey, Pubkey, Pubkey) {
    setup_rules(mode, true, false, 0).await
}
async fn setup_rules(
    mode: FeeMode,
    transfers_open: bool,
    quick_bond: bool,
    extra_blocked_count: u16,
) -> (ProgramTestContext, Pubkey, Pubkey, Pubkey, Pubkey) {
    setup_developer(mode, transfers_open, quick_bond, extra_blocked_count, 0).await
}
async fn setup_developer(
    mode: FeeMode,
    transfers_open: bool,
    quick_bond: bool,
    extra_blocked_count: u16,
    developer_buy_lamports: u64,
) -> (ProgramTestContext, Pubkey, Pubkey, Pubkey, Pubkey) {
    setup_beneficiary(
        mode,
        transfers_open,
        quick_bond,
        extra_blocked_count,
        developer_buy_lamports,
        Pubkey::default(),
    )
    .await
}
async fn setup_beneficiary(
    mode: FeeMode,
    transfers_open: bool,
    quick_bond: bool,
    extra_blocked_count: u16,
    developer_buy_lamports: u64,
    beneficiary: Pubkey,
) -> (ProgramTestContext, Pubkey, Pubkey, Pubkey, Pubkey) {
    let treasury = Pubkey::new_unique();
    let (config, bump) = Pubkey::find_program_address(&[b"config"], &custom_launchpad::ID);
    let mut data = vec![];
    Config {
        treasury,
        bump,
        metadata_authority: Pubkey::default(),
    }
    .try_serialize(&mut data)
    .unwrap();
    let mut pt = launchpad_test();
    pt.add_program("spl_token", token::ID, processor!(strict_token_entry));
    pt.add_program(
        "spl_associated_token_account",
        associated_token::ID,
        processor!(associated_token::spl_associated_token_account::processor::process_instruction),
    );
    pt.add_account(
        config,
        Account {
            lamports: 10_000_000,
            data,
            owner: custom_launchpad::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    pt.add_account(
        treasury,
        Account {
            lamports: 1_000_000,
            data: vec![],
            owner: solana_sdk::system_program::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut ctx = pt.start_with_context().await;
    let mint = Keypair::new();
    let (launch, _) =
        Pubkey::find_program_address(&[b"launch", mint.pubkey().as_ref()], &custom_launchpad::ID);
    let vault = associated_token::get_associated_token_address(&launch, &mint.pubkey());
    let ix = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::CreateLaunch {
            metadata: metadata_address(mint.pubkey()),
            metadata_program: anchor_spl::metadata::ID,
            rent: solana_sdk::sysvar::rent::ID,
            ticker_registry: ticker_address("TEST"),
            creator: ctx.payer.pubkey(),
            config,
            mint: mint.pubkey(),
            launch,
            vault,
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::CreateLaunch {
            args: LaunchArgs {
                app_mode: 0,
                app_authorities: vec![],
                name: "Test Coin".to_string(),
                uri: "https://example.com/token.json".to_string(),
                beneficiary,
                developer_buy_lamports,
                ticker: "TEST".to_string(),
                supply: 1_000_000_000_000_000,
                sale_tokens: 800_000_000_000_000,
                virtual_tokens: 1_000_000_000_000_000,
                virtual_quote: 30_000_000_000,
                target_quote: 85_000_000_000,
                max_wallet_bps: 400,
                protection_slots: 4,
                fee_mode: mode,
                blocked: vec![],
                transfers_open,
                quick_bond,
                extra_blocked_count,
            },
        }
        .data(),
    };
    send(&mut ctx, ix, &[&mint]).await.unwrap();
    activate_fixed_fixture(&mut ctx, launch).await;
    ctx.warp_to_slot(20).unwrap();
    (ctx, mint.pubkey(), launch, vault, treasury)
}
fn trade(owner: Pubkey, launch: Pubkey, buy: bool, amount: u64, min: u64) -> Instruction {
    let (position, _) = Pubkey::find_program_address(
        &[b"position", launch.as_ref(), owner.as_ref()],
        &custom_launchpad::ID,
    );
    Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::Trade {
            app_authority: None,
            app_record: None,
            ticker_registry: ticker_address("TEST"),
            blocked_record: blocked_address(launch, owner),
            trader: owner,
            launch,
            position,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: if buy {
            instruction::Buy {
                gross_lamports: amount,
                min_tokens: min,
                deadline_slot: 1000,
            }
            .data()
        } else {
            instruction::Sell {
                tokens: amount,
                min_lamports: min,
                deadline_slot: 1000,
            }
            .data()
        },
    }
}
async fn launch_state(ctx: &mut ProgramTestContext, key: Pubkey) -> Launch {
    let a = ctx.banks_client.get_account(key).await.unwrap().unwrap();
    Launch::try_deserialize(&mut a.data.as_slice()).unwrap()
}
#[tokio::test]
async fn runtime_buy_reserves_rewards_and_immutable_treasury() {
    let (mut ctx, _mint, launch, _vault, treasury) = setup(FeeMode::Holders).await;
    let owner = ctx.payer.pubkey();
    send(&mut ctx, trade(owner, launch, true, 200_000_000, 1), &[])
        .await
        .unwrap();
    let l = launch_state(&mut ctx, launch).await;
    assert_eq!(l.quote, 195_000_000);
    assert_eq!(l.treasury_fees, 4_400_000);
    assert_eq!(l.coin_fees, 600_000);
    assert!(l.reward_index > 0);
    let (position, _) = Pubkey::find_program_address(
        &[b"position", launch.as_ref(), owner.as_ref()],
        &custom_launchpad::ID,
    );
    let a = ctx
        .banks_client
        .get_account(position)
        .await
        .unwrap()
        .unwrap();
    let p = Position::try_deserialize(&mut a.data.as_slice()).unwrap();
    assert_eq!(p.balance, l.sold);
    assert_eq!(p.locked, p.balance);
    assert!(
        send(&mut ctx, trade(owner, launch, false, p.balance, 0), &[])
            .await
            .is_err()
    );
    let bad = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::CollectTreasury {
            launch,
            treasury: owner,
        }
        .to_account_metas(None),
        data: instruction::CollectTreasury {}.data(),
    };
    assert!(send(&mut ctx, bad, &[]).await.is_err());
    let good = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::CollectTreasury { launch, treasury }.to_account_metas(None),
        data: instruction::CollectTreasury {}.data(),
    };
    send(&mut ctx, good, &[]).await.unwrap();
    assert_eq!(
        ctx.banks_client.get_balance(treasury).await.unwrap(),
        5_400_000
    );
    assert_eq!(launch_state(&mut ctx, launch).await.treasury_fees, 0);
    let claim = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ClaimRewards {
            owner,
            launch,
            position,
        }
        .to_account_metas(None),
        data: instruction::ClaimRewards {}.data(),
    };
    send(&mut ctx, claim, &[]).await.unwrap();
    assert!(launch_state(&mut ctx, launch).await.coin_fees <= 1);
}
#[tokio::test]
async fn runtime_failed_buy_rolls_back_all_state() {
    let (mut ctx, _, launch, _, _) = setup(FeeMode::Burn).await;
    let owner = ctx.payer.pubkey();
    let before = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert!(send(
        &mut ctx,
        trade(owner, launch, true, 1_000_000, u64::MAX),
        &[]
    )
    .await
    .is_err());
    let after = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(before.data, after.data);
    assert_eq!(before.lamports, after.lamports);
}
#[tokio::test]
async fn runtime_burn_spends_only_coin_fee_budget() {
    let (mut ctx, mint, launch, vault, _) = setup(FeeMode::Burn).await;
    let owner = ctx.payer.pubkey();
    send(&mut ctx, trade(owner, launch, true, 200_000_000, 1), &[])
        .await
        .unwrap();
    let before = launch_state(&mut ctx, launch).await;
    let ix = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::BurnFees {
            launch,
            mint,
            vault,
            token_program: token::ID,
        }
        .to_account_metas(None),
        data: instruction::BurnFees {
            max_lamports: u64::MAX,
            min_tokens: 1,
            deadline_slot: 1000,
        }
        .data(),
    };
    send(&mut ctx, ix, &[]).await.unwrap();
    let after = launch_state(&mut ctx, launch).await;
    assert_eq!(after.coin_fees, 0);
    assert_eq!(after.treasury_fees, before.treasury_fees);
    assert_eq!(after.quote, before.quote + before.coin_fees);
    assert!(after.burned > 0);
    assert_eq!(after.sold - after.burned, before.sold);
}

#[tokio::test]
async fn actual_pumpswap_graduation_locks_liquidity_and_preserves_claims() {
    use base64::Engine;
    use custom_launchpad::migration::{PUMP_SWAP, WSOL};
    use solana_sdk::{compute_budget::ComputeBudgetInstruction, program_pack::Pack};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/external");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("pumpswap-global.json"))
            .expect("run scripts/fetch-pumpswap-fixture.mjs first"),
    )
    .unwrap();
    let treasury = Pubkey::new_unique();
    let (config, bump) = Pubkey::find_program_address(&[b"config"], &custom_launchpad::ID);
    let mut config_data = vec![];
    Config {
        treasury,
        bump,
        metadata_authority: Pubkey::default(),
    }
    .try_serialize(&mut config_data)
    .unwrap();
    let mut pt = launchpad_test();
    pt.add_program("spl_token", token::ID, processor!(strict_token_entry));
    pt.add_program(
        "spl_associated_token_account",
        associated_token::ID,
        processor!(associated_token::spl_associated_token_account::processor::process_instruction),
    );
    pt.add_program(
        "spl_token_2022",
        anchor_spl::token_2022::ID,
        processor!(anchor_spl::token_2022::spl_token_2022::processor::Processor::process),
    );
    // Install the captured ELF under the same program ID, only in this local bank.
    let binary = std::fs::read(root.join("pump_amm.so")).unwrap();
    pt.add_account(
        PUMP_SWAP,
        Account {
            lamports: 100_000_000,
            data: binary,
            owner: solana_sdk::bpf_loader::ID,
            executable: true,
            rent_epoch: 0,
        },
    );
    let global: Pubkey = fixture["address"].as_str().unwrap().parse().unwrap();
    pt.add_account(
        global,
        Account {
            lamports: fixture["lamports"].as_u64().unwrap(),
            data: base64::engine::general_purpose::STANDARD
                .decode(fixture["dataBase64"].as_str().unwrap())
                .unwrap(),
            owner: PUMP_SWAP,
            executable: false,
            rent_epoch: 0,
        },
    );
    pt.add_account(
        config,
        Account {
            lamports: 10_000_000,
            data: config_data,
            owner: custom_launchpad::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut native_data = vec![0; token::spl_token::state::Mint::LEN];
    token::spl_token::state::Mint {
        mint_authority: solana_sdk::program_option::COption::None,
        supply: 0,
        decimals: 9,
        is_initialized: true,
        freeze_authority: solana_sdk::program_option::COption::None,
    }
    .pack_into_slice(&mut native_data);
    pt.add_account(
        WSOL,
        Account {
            lamports: 10_000_000,
            data: native_data,
            owner: token::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut ctx = pt.start_with_context().await;
    let mint = Keypair::new();
    let mint_key = mint.pubkey();
    let (launch, lb) =
        Pubkey::find_program_address(&[b"launch", mint_key.as_ref()], &custom_launchpad::ID);
    let vault = associated_token::get_associated_token_address(&launch, &mint_key);
    let create = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::CreateLaunch {
            metadata: metadata_address(mint.pubkey()),
            metadata_program: anchor_spl::metadata::ID,
            rent: solana_sdk::sysvar::rent::ID,
            ticker_registry: ticker_address("TEST"),
            creator: ctx.payer.pubkey(),
            config,
            mint: mint_key,
            launch,
            vault,
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::CreateLaunch {
            args: LaunchArgs {
                app_mode: 0,
                app_authorities: vec![],
                name: "Test Coin".to_string(),
                uri: "https://example.com/token.json".to_string(),
                beneficiary: Pubkey::default(),
                developer_buy_lamports: 200_000_000,
                ticker: "TEST".to_string(),
                supply: 1_000_000_000_000_000,
                sale_tokens: 800_000_000_000_000,
                virtual_tokens: 1_000_000_000_000_000,
                virtual_quote: 30_000_000_000,
                target_quote: 85_000_000_000,
                max_wallet_bps: 400,
                protection_slots: 4,
                fee_mode: FeeMode::Liquidity,
                blocked: vec![],
                transfers_open: true,
                quick_bond: false,
                extra_blocked_count: 0,
            },
        }
        .data(),
    };
    send(&mut ctx, create, &[&mint]).await.unwrap();
    activate_fixed_fixture(&mut ctx, launch).await;
    // Execute the complete lifecycle through real curve instructions, without seeding reserves.
    ctx.warp_to_slot(20).unwrap();
    let developer = ctx.payer.pubkey();
    send(&mut ctx, developer_ix(launch, developer, developer), &[])
        .await
        .unwrap();
    let mut ordinary_holder = None;
    for step in 0..500 {
        ctx.warp_to_slot(21 + step).unwrap();
        let state = launch_state(&mut ctx, launch).await;
        let remaining = state.args.target_quote - state.quote;
        if remaining == 0 {
            break;
        }
        let net = remaining.min(195_000_000);
        let gross = (net * 10_000).div_ceil(9_750);
        let buyer = Keypair::new();
        let funding = solana_sdk::system_instruction::transfer(
            &ctx.payer.pubkey(),
            &buyer.pubkey(),
            gross + 10_000_000,
        );
        send(&mut ctx, funding, &[]).await.unwrap();
        send(
            &mut ctx,
            trade(buyer.pubkey(), launch, true, gross, 1),
            &[&buyer],
        )
        .await
        .unwrap();
            if ordinary_holder.is_none() { ordinary_holder = Some(buyer); }
    }
    let l = launch_state(&mut ctx, launch).await;
    assert_eq!(l.quote, l.args.target_quote);
    let authority =
        Pubkey::find_program_address(&[b"migration", launch.as_ref()], &custom_launchpad::ID).0;
    let pool = Pubkey::find_program_address(
        &[
            b"pool",
            &1u16.to_le_bytes(),
            authority.as_ref(),
            mint_key.as_ref(),
            WSOL.as_ref(),
        ],
        &PUMP_SWAP,
    )
    .0;
    let lp_mint = Pubkey::find_program_address(&[b"pool_lp_mint", pool.as_ref()], &PUMP_SWAP).0;
    let user_lp = associated_token::get_associated_token_address_with_program_id(
        &authority,
        &lp_mint,
        &anchor_spl::token_2022::ID,
    );
    // An independent keeper has too little SOL to fund pool rent; only signs the action.
    let rentless_keeper = Keypair::new();
    let payer = ctx.payer.pubkey();
    send(
        &mut ctx,
        solana_sdk::system_instruction::transfer(&payer, &rentless_keeper.pubkey(), 1_000_000),
        &[],
    )
    .await
    .unwrap();
    // Pre-create one canonical ATA. Graduation must not charge its rent again.
    let prefunded_base = associated_token::get_associated_token_address(&authority, &mint_key);
    send(&mut ctx, associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        &payer, &authority, &mint_key, &token::ID), &[]).await.unwrap();
    let prefunded_rent = ctx.banks_client.get_balance(prefunded_base).await.unwrap();
    // An unsolicited authority donation must not be taken or refunded to the keeper.
    send(
        &mut ctx,
        solana_sdk::system_instruction::transfer(&payer, &authority, 1_000_000),
        &[],
    )
    .await
    .unwrap();
    let g = accounts::Graduate {
        ticker_registry: ticker_address("TEST"),
        keeper: rentless_keeper.pubkey(),
        launch,
        mint: mint_key,
        quote_mint: WSOL,
        vault,
        authority,
        user_base: associated_token::get_associated_token_address(&authority, &mint_key),
        user_quote: associated_token::get_associated_token_address(&authority, &WSOL),
        pool,
        global_config: global,
        lp_mint,
        user_lp,
        pool_base: associated_token::get_associated_token_address(&pool, &mint_key),
        pool_quote: associated_token::get_associated_token_address(&pool, &WSOL),
        event_authority: Pubkey::find_program_address(&[b"__event_authority"], &PUMP_SWAP).0,
        pump_program: PUMP_SWAP,
        token_program: token::ID,
        token_2022_program: anchor_spl::token_2022::ID,
        associated_token_program: associated_token::ID,
        system_program: solana_sdk::system_program::ID,
    };
    let ix = Instruction {
        program_id: custom_launchpad::ID,
        accounts: g.to_account_metas(None),
        data: instruction::Graduate {}.data(),
    };
    let launch_before = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let keeper_before = ctx
        .banks_client
        .get_balance(rentless_keeper.pubkey())
        .await
        .unwrap();
    // Real worker shape: an unfunded fee payer cannot start migration or debit curve reserves.
    let unfunded = Keypair::new();
    let mut unfunded_ix = ix.clone();
    unfunded_ix.accounts[0].pubkey = unfunded.pubkey();
    ctx.set_account(&unfunded.pubkey(), &Account { lamports: 1, data: vec![], owner: solana_sdk::system_program::ID, executable: false, rent_epoch: 0 }.into());
    let unfunded_tx = Transaction::new_signed_with_payer(&[unfunded_ix], Some(&unfunded.pubkey()), &[&unfunded], ctx.banks_client.get_latest_blockhash().await.unwrap());
    let insufficient = ctx.banks_client.simulate_transaction(unfunded_tx).await.unwrap();
    assert_eq!(insufficient.result.unwrap(), Err(solana_sdk::transaction::TransactionError::InsufficientFundsForFee));
    let untouched = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(untouched.lamports, launch_before.lamports);
    assert_eq!(untouched.data, launch_before.data);
    // Rejected account substitution must roll back curve funds and temporary accounts.
    let mut bad = ix.clone();
    bad.accounts[6].pubkey = vault;
    assert!(send(&mut ctx, bad, &[&rentless_keeper]).await.is_err());
    let rejected = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(rejected.lamports, launch_before.lamports);
    assert_eq!(rejected.data, launch_before.data);
    assert_eq!(
        ctx.banks_client.get_balance(authority).await.unwrap(),
        1_000_000
    );
    // A rent schedule exceeding the fixed reserve must fail atomically, never raid fees.
    let rent: solana_sdk::rent::Rent = ctx.banks_client.get_sysvar().await.unwrap();
    let mut expensive_rent = rent.clone();
    expensive_rent.lamports_per_byte_year *= 100;
    ctx.set_sysvar(&expensive_rent);
    assert!(send(&mut ctx, ix.clone(), &[&rentless_keeper])
        .await
        .is_err());
    ctx.set_sysvar(&rent);
    let rejected_rent = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(rejected_rent.lamports, launch_before.lamports);
    assert_eq!(rejected_rent.data, launch_before.data);
    assert!(ctx.banks_client.get_account(pool).await.unwrap().is_none());
    assert_eq!(
        ctx.banks_client.get_balance(authority).await.unwrap(),
        1_000_000
    );
    let retry_ix = ix.clone();
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(600_000),
            ix,
        ],
        Some(&rentless_keeper.pubkey()),
        &[&rentless_keeper],
        hash,
    );
    let migration_fee = ctx.banks_client.get_fee_for_message(tx.message.clone()).await.unwrap().unwrap();
    ctx.banks_client.process_transaction(tx).await.unwrap();
    assert_eq!(
        ctx.banks_client
            .get_balance(rentless_keeper.pubkey())
            .await
            .unwrap(),
        keeper_before - migration_fee
    );
    assert_eq!(
        ctx.banks_client.get_balance(authority).await.unwrap(),
        1_000_000
    );
    let mut rent_used = 0u64;
    for address in [
        g.user_base,
        g.user_quote,
        g.pool_base,
        g.pool_quote,
        pool,
        lp_mint,
        user_lp,
    ] {
        let account = ctx
            .banks_client
            .get_account(address)
            .await
            .unwrap()
            .unwrap();
        let token_amount = if address == g.pool_quote || address == g.user_quote {
            token::spl_token::state::Account::unpack(&account.data)
                .unwrap()
                .amount
        } else {
            0
        };
        rent_used += account.lamports - token_amount;
    }
    rent_used -= prefunded_rent;
    assert!(rent_used > 0 && rent_used < custom_launchpad::graduation_costs::MAX_SETUP_LAMPORTS);
    let quote_account = ctx
        .banks_client
        .get_account(g.pool_quote)
        .await
        .unwrap()
        .unwrap();
    let actual_quote = token::spl_token::state::Account::unpack(&quote_account.data)
        .unwrap()
        .amount;
    assert_eq!(actual_quote + rent_used, l.quote + l.coin_fees);
    let base_account = ctx
        .banks_client
        .get_account(g.pool_base)
        .await
        .unwrap()
        .unwrap();
    let actual_base = token::spl_token::state::Account::unpack(&base_account.data)
        .unwrap()
        .amount;
    assert_eq!(
        actual_base,
        launch_core::mul_div(
            actual_quote,
            l.args.virtual_tokens - l.sold,
            l.args.virtual_quote + l.quote
        )
        .unwrap()
    );
    let graduated_account = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert!(send(&mut ctx, retry_ix, &[&rentless_keeper]).await.is_err());
    let retried = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(retried.lamports, graduated_account.lamports);
    assert_eq!(retried.data, graduated_account.data);

    let after = launch_state(&mut ctx, launch).await;
    assert!(after.graduated);
    assert_eq!(after.pool, pool);
    assert_eq!(after.quote, 0);
    assert_eq!(after.treasury_fees, l.treasury_fees);
    assert_eq!(after.coin_fees, 0);
    assert_eq!(after.bump, lb);
    let va = ctx.banks_client.get_account(vault).await.unwrap().unwrap();
    assert_eq!(
        token::spl_token::state::Account::unpack(&va.data)
            .unwrap()
            .amount,
        l.sold
    );
    let lp = ctx
        .banks_client
        .get_account(user_lp)
        .await
        .unwrap()
        .unwrap();
    let parsed = anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions::<
        anchor_spl::token_2022::spl_token_2022::state::Account,
    >::unpack(&lp.data)
    .unwrap();
    assert_eq!(parsed.base.amount, 0);
    // Execute residual budgets against the same captured PumpSwap binary.
    let fees: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("pumpswap-fees.json")).unwrap()).unwrap();
    let fee_key: Pubkey = "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx"
        .parse()
        .unwrap();
    let fee_value = &fees["result"]["value"];
    ctx.set_account(
        &fee_key,
        &Account {
            lamports: fee_value["lamports"].as_u64().unwrap(),
            data: base64::engine::general_purpose::STANDARD
                .decode(fee_value["data"][0].as_str().unwrap())
                .unwrap(),
            owner: fee_value["owner"].as_str().unwrap().parse().unwrap(),
            executable: false,
            rent_epoch: 0,
        }
        .into(),
    );
    let global_bytes = base64::engine::general_purpose::STANDARD
        .decode(fixture["dataBase64"].as_str().unwrap())
        .unwrap();
    let recipient = Pubkey::new_from_array(global_bytes[643..675].try_into().unwrap());
    let buyback = associated_token::get_associated_token_address(&recipient, &WSOL);
    let mut buyback_data = vec![0; token::spl_token::state::Account::LEN];
    token::spl_token::state::Account::pack(
        token::spl_token::state::Account {
            mint: WSOL,
            owner: recipient,
            amount: 0,
            delegate: solana_sdk::program_option::COption::None,
            state: token::spl_token::state::AccountState::Initialized,
            is_native: solana_sdk::program_option::COption::Some(2_039_280),
            delegated_amount: 0,
            close_authority: solana_sdk::program_option::COption::None,
        },
        &mut buyback_data,
    )
    .unwrap();
    ctx.set_account(
        &buyback,
        &Account {
            lamports: 2_039_280,
            data: buyback_data,
            owner: token::ID,
            executable: false,
            rent_epoch: 0,
        }
        .into(),
    );
    let mut operator_config = ctx.banks_client.get_account(config).await.unwrap().unwrap();
    let mut conf = Config::try_deserialize(&mut operator_config.data.as_slice()).unwrap();
    conf.metadata_authority = ctx.payer.pubkey();
    let mut encoded = vec![];
    conf.try_serialize(&mut encoded).unwrap();
    operator_config.data[..encoded.len()].copy_from_slice(&encoded);
    ctx.set_account(&config, &operator_config.into());
    // An unsolicited SOL deposit into the WSOL account must not jam settlement.
    let donation =
        solana_sdk::system_instruction::transfer(&ctx.payer.pubkey(), &g.user_quote, 5000);
    send(&mut ctx, donation, &[]).await.unwrap();
    for (index, mode) in [FeeMode::Burn, FeeMode::Liquidity, FeeMode::Holders]
        .into_iter()
        .enumerate()
    {
        let mut la = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
        let mut state = Launch::try_deserialize(&mut la.data.as_slice()).unwrap();
        state.args.fee_mode = mode;
        let sniper = index == 2;
        let prior_treasury = state.treasury_fees;
        if sniper {
            state.sniper_fees = 100_000_000;
            state.coin_fees = 7_000_000;
            la.lamports += 107_000_000;
        } else {
            state.coin_fees = 100_000_000;
            la.lamports += 100_000_000;
        }
        let mut encoded = vec![];
        state.try_serialize(&mut encoded).unwrap();
        la.data[..encoded.len()].copy_from_slice(&encoded);
        ctx.set_account(&launch, &la.into());
        let now: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
        let settlement = accounts::SettlePoolFees {
            operator: ctx.payer.pubkey(),
            config,
            launch,
            mint: mint_key,
            quote_mint: WSOL,
            authority,
            user_base: g.user_base,
            user_quote: g.user_quote,
            pool,
            global_config: global,
            pool_base: g.pool_base,
            pool_quote: g.pool_quote,
            volume: Pubkey::find_program_address(
                &[b"user_volume_accumulator", authority.as_ref()],
                &PUMP_SWAP,
            )
            .0,
            fee_config: fee_key,
            buyback,
            event_authority: g.event_authority,
            pump_program: PUMP_SWAP,
            lp_mint,
            user_lp,
            token_program: token::ID,
            token_2022_program: anchor_spl::token_2022::ID,
            associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
        };
        let settle = Instruction {
            program_id: custom_launchpad::ID,
            accounts: settlement.to_account_metas(None),
            data: instruction::SettlePoolFees {
                budget: 100_000_000,
                min_tokens: 1,
                min_lp: if index == 1 { 1 } else { 0 },
                deadline: now.slot + 20,
            }
            .data(),
        };
        if index == 0 {
            let bad = Instruction {
                program_id: custom_launchpad::ID,
                accounts: settlement.to_account_metas(None),
                data: instruction::SettlePoolFees {
                    budget: 100_000_000,
                    min_tokens: u64::MAX,
                    min_lp: 0,
                    deadline: now.slot + 20,
                }
                .data(),
            };
            assert!(send(&mut ctx, bad, &[]).await.is_err());
            assert_eq!(launch_state(&mut ctx, launch).await.coin_fees, 100_000_000);
            let mut forged = settle.clone();
            forged.accounts[6].pubkey = vault;
            assert!(send(&mut ctx, forged, &[]).await.is_err());
        }
        let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
        let tx = Transaction::new_signed_with_payer(
            &[
                ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
                settle,
            ],
            Some(&ctx.payer.pubkey()),
            &[&ctx.payer],
            hash,
        );
        ctx.banks_client.process_transaction(tx).await.unwrap();
        let state = launch_state(&mut ctx, launch).await;
        assert_eq!(state.treasury_fees, prior_treasury);
        if sniper {
            assert_eq!(state.coin_fees, 7_000_000);
            assert_eq!(state.sniper_fees, 0);
        } else {
            assert!(state.coin_fees < 1_000_000);
        }
        let custody = ctx.banks_client.get_account(vault).await.unwrap().unwrap();
        assert_eq!(
            token::spl_token::state::Account::unpack(&custody.data)
                .unwrap()
                .amount,
            l.sold
        );
        let lp = ctx
            .banks_client
            .get_account(user_lp)
            .await
            .unwrap()
            .unwrap();
        let lp = anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions::<
            anchor_spl::token_2022::spl_token_2022::state::Account,
        >::unpack(&lp.data)
        .unwrap();
        assert_eq!(lp.base.amount, 0);
    }
    // An ordinary holder receives exactly the recorded custody balance, without signing.
    let holder = ordinary_holder.unwrap();
    let holder_amount = position_state(&mut ctx, launch, holder.pubkey()).await.balance;
    let holder_destination = associated_token::get_associated_token_address(&holder.pubkey(), &mint_key);
    let holder_claim = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ClaimFor {
            keeper: ctx.payer.pubkey(), owner: holder.pubkey(), launch, mint: mint_key,
            position: position_address(launch, holder.pubkey()), vault, destination: holder_destination,
            token_program: token::ID, associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
        }.to_account_metas(None), data: instruction::ClaimFor {}.data(),
    };
    send(&mut ctx, holder_claim.clone(), &[]).await.unwrap();
    assert_eq!(token_balance(&mut ctx, holder_destination).await, holder_amount);
    assert_eq!(position_state(&mut ctx, launch, holder.pubkey()).await.balance, 0);
    // A duplicate delivery must never increase the holder's wallet balance.
    let _ = send(&mut ctx, holder_claim, &[]).await;
    assert_eq!(token_balance(&mut ctx, holder_destination).await, holder_amount);
    pumpswap_round_trip(&mut ctx, pool, mint_key, &holder).await;
    // Keeper release must respect the developer's lock even after actual PumpSwap graduation.
    let owner = developer;
    let position = position_address(launch, owner);
    let developer_position = position_state(&mut ctx, launch, owner).await;
    let amount = developer_position.balance;
    let destination = associated_token::get_associated_token_address(&owner, &mint_key);
    let release_keeper = Keypair::new();
    let funding = solana_sdk::system_instruction::transfer(
        &ctx.payer.pubkey(),
        &release_keeper.pubkey(),
        100_000_000,
    );
    send(&mut ctx, funding, &[]).await.unwrap();
    let claim = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ClaimFor {
            keeper: release_keeper.pubkey(),
            owner,
            launch,
            mint: mint_key,
            position,
            vault,
            destination,
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::ClaimFor {}.data(),
    };
    assert!(send_independent(&mut ctx, claim.clone(), &release_keeper)
        .await
        .is_err());
    let mut clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = developer_position.unlock_at;
    ctx.set_sysvar(&clock);
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let unlocked = Transaction::new_signed_with_payer(
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(200_000),
            claim,
        ],
        Some(&release_keeper.pubkey()),
        &[&release_keeper],
        hash,
    );
    ctx.banks_client
        .process_transaction(unlocked)
        .await
        .unwrap();
    let claimed = ctx
        .banks_client
        .get_account(destination)
        .await
        .unwrap()
        .unwrap();
    let token_account = token::spl_token::state::Account::unpack(&claimed.data).unwrap();
    assert_eq!(token_account.mint, mint_key);
    assert_eq!(token_account.amount, amount);
    assert_eq!(position_state(&mut ctx, launch, owner).await.balance, 0);
    let remaining = ctx.banks_client.get_account(vault).await.unwrap().unwrap();
    assert_eq!(
        token::spl_token::state::Account::unpack(&remaining.data)
            .unwrap()
            .amount,
        l.sold - amount - holder_amount
    );
    // Reuse requires a fresh, six-hour-idle operator attestation and the current reservation.
    let now: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let release = |last_trade, observed_at| Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ReleaseBondedTicker {
            operator: ctx.payer.pubkey(),
            config,
            launch,
            registry: ticker_address("TEST"),
        }
        .to_account_metas(None),
        data: instruction::ReleaseBondedTicker {
            last_trade,
            observed_at,
        }
        .data(),
    };
    let recent = release(now.unix_timestamp - 21599, now.unix_timestamp);
    let stale = release(now.unix_timestamp - 30000, now.unix_timestamp - 61);
    let valid = release(now.unix_timestamp - 21600, now.unix_timestamp);
    assert!(send(&mut ctx, recent, &[]).await.is_err());
    assert!(send(&mut ctx, stale, &[]).await.is_err());
    send(&mut ctx, valid, &[]).await.unwrap();
    let registry = ctx
        .banks_client
        .get_account(ticker_address("TEST"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        custom_launchpad::TickerRegistry::try_deserialize(&mut registry.data.as_slice())
            .unwrap()
            .launch,
        Pubkey::default()
    );
}

fn position_address(launch: Pubkey, owner: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"position", launch.as_ref(), owner.as_ref()],
        &custom_launchpad::ID,
    )
    .0
}
fn move_position(
    launch: Pubkey,
    owner: Pubkey,
    recipient: Pubkey,
    amount: u64,
    deadline_slot: u64,
) -> Instruction {
    Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::TransferPosition {
            source_blocked: blocked_address(launch, owner),
            destination_blocked: blocked_address(launch, recipient),
            owner,
            recipient,
            launch,
            source: position_address(launch, owner),
            destination: position_address(launch, recipient),
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::TransferPosition {
            amount,
            deadline_slot,
        }
        .data(),
    }
}
async fn position_state(ctx: &mut ProgramTestContext, launch: Pubkey, owner: Pubkey) -> Position {
    let a = ctx
        .banks_client
        .get_account(position_address(launch, owner))
        .await
        .unwrap()
        .unwrap();
    Position::try_deserialize(&mut a.data.as_slice()).unwrap()
}
#[tokio::test]
async fn custody_transfers_preserve_reserves_and_reward_ownership() {
    let (mut ctx, _, launch, _, _) = setup(FeeMode::Holders).await;
    let alice = Keypair::new();
    let bob = Keypair::new();
    for user in [&alice, &bob] {
        let ix = solana_sdk::system_instruction::transfer(
            &ctx.payer.pubkey(),
            &user.pubkey(),
            2_000_000_000,
        );
        send(&mut ctx, ix, &[]).await.unwrap();
    }
    send(
        &mut ctx,
        trade(alice.pubkey(), launch, true, 200_000_000, 1),
        &[&alice],
    )
    .await
    .unwrap();
    let before = launch_state(&mut ctx, launch).await;
    let balance = position_state(&mut ctx, launch, alice.pubkey())
        .await
        .balance;
    let amount = balance / 2;
    send(
        &mut ctx,
        move_position(launch, alice.pubkey(), bob.pubkey(), amount, 1000),
        &[&alice],
    )
    .await
    .unwrap();
    let a = position_state(&mut ctx, launch, alice.pubkey()).await;
    let b = position_state(&mut ctx, launch, bob.pubkey()).await;
    assert_eq!(a.balance + b.balance, balance);
    assert_eq!(b.balance, amount);
    assert!(a.reward_claimable > 0);
    assert_eq!(b.reward_claimable, 0); // old rewards stay with the old owner
    let after = launch_state(&mut ctx, launch).await;
    assert_eq!(
        (
            after.sold,
            after.quote,
            after.coin_fees,
            after.treasury_fees
        ),
        (
            before.sold,
            before.quote,
            before.coin_fees,
            before.treasury_fees
        )
    );
    assert_eq!(after.sequence, before.sequence + 1);
    send(
        &mut ctx,
        trade(bob.pubkey(), launch, false, amount, 1),
        &[&bob],
    )
    .await
    .unwrap();
    assert_eq!(
        position_state(&mut ctx, launch, bob.pubkey()).await.balance,
        0
    );
}
#[tokio::test]
async fn custody_transfer_rejections_are_atomic() {
    let (mut ctx, _, launch, _, _) = setup(FeeMode::Holders).await;
    let creator = ctx.payer.pubkey();
    let recipient = Keypair::new();
    send(&mut ctx, trade(creator, launch, true, 200_000_000, 1), &[])
        .await
        .unwrap();
    let before = ctx
        .banks_client
        .get_account(position_address(launch, creator))
        .await
        .unwrap()
        .unwrap();
    // Developer tokens cannot escape their lock via a transfer.
    assert!(send(
        &mut ctx,
        move_position(launch, creator, recipient.pubkey(), 1, 1000),
        &[]
    )
    .await
    .is_err());
    assert!(send(
        &mut ctx,
        move_position(launch, creator, recipient.pubkey(), 1, 0),
        &[]
    )
    .await
    .is_err());
    assert!(send(
        &mut ctx,
        move_position(launch, creator, creator, 1, 1000),
        &[]
    )
    .await
    .is_err());
    let after = ctx
        .banks_client
        .get_account(position_address(launch, creator))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(before.data, after.data);
    assert!(ctx
        .banks_client
        .get_account(position_address(launch, recipient.pubkey()))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn custody_transfers_enforce_cap_blocklist_and_graduation() {
    let (mut ctx, _, launch, _, _) = setup(FeeMode::Holders).await;
    let alice = Keypair::new();
    let bob = Keypair::new();
    for user in [&alice, &bob] {
        let ix = solana_sdk::system_instruction::transfer(
            &ctx.payer.pubkey(),
            &user.pubkey(),
            2_000_000_000,
        );
        send(&mut ctx, ix, &[]).await.unwrap();
        for _ in 0..5 {
            let clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
            ctx.warp_to_slot(clock.slot + 1).unwrap();
            send(
                &mut ctx,
                trade(user.pubkey(), launch, true, 200_000_000, 1),
                &[user],
            )
            .await
            .unwrap();
        }
    }
    let balance = position_state(&mut ctx, launch, alice.pubkey())
        .await
        .balance;
    let before = ctx
        .banks_client
        .get_account(position_address(launch, alice.pubkey()))
        .await
        .unwrap()
        .unwrap();
    assert!(send(
        &mut ctx,
        move_position(launch, alice.pubkey(), bob.pubkey(), balance, 1000),
        &[&alice]
    )
    .await
    .is_err());
    // Inject immutable-config variants only in the local bank to cover rejection paths.
    let mut l = launch_state(&mut ctx, launch).await;
    let mut account = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    l.args.blocked.push(bob.pubkey());
    l.try_serialize(&mut account.data.as_mut_slice()).unwrap();
    ctx.set_account(
        &launch,
        &solana_sdk::account::AccountSharedData::from(account.clone()),
    );
    assert!(send(
        &mut ctx,
        move_position(launch, alice.pubkey(), bob.pubkey(), 1, 1000),
        &[&alice]
    )
    .await
    .is_err());
    l.args.blocked.clear();
    l.graduated = true;
    l.try_serialize(&mut account.data.as_mut_slice()).unwrap();
    ctx.set_account(
        &launch,
        &solana_sdk::account::AccountSharedData::from(account),
    );
    assert!(send(
        &mut ctx,
        move_position(launch, alice.pubkey(), bob.pubkey(), 2, 1000),
        &[&alice]
    )
    .await
    .is_err());
    assert_eq!(
        before.data,
        ctx.banks_client
            .get_account(position_address(launch, alice.pubkey()))
            .await
            .unwrap()
            .unwrap()
            .data
    );
}

fn blocked_address(launch: Pubkey, wallet: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[b"blocked", launch.as_ref(), wallet.as_ref()],
        &custom_launchpad::ID,
    )
    .0
}

fn add_block(launch: Pubkey, creator: Pubkey, wallet: Pubkey) -> Instruction {
    Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::AddBlockedWallet {
            creator,
            launch,
            record: blocked_address(launch, wallet),
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::AddBlockedWallet { wallet }.data(),
    }
}
#[tokio::test]
async fn sealed_large_blocklist_gates_activation_and_rejects_buying() {
    let (mut ctx, _, launch, _, _) = setup_rules(FeeMode::Holders, false, false, 2).await;
    let creator = ctx.payer.pubkey();
    let blocked = Keypair::new();
    let other = Pubkey::new_unique();
    assert!(
        send(&mut ctx, trade(creator, launch, true, 10_000_000, 1), &[])
            .await
            .is_err()
    );
    send(&mut ctx, add_block(launch, creator, blocked.pubkey()), &[])
        .await
        .unwrap();
    assert_eq!(launch_state(&mut ctx, launch).await.blocked_uploaded, 1);
    assert!(
        send(&mut ctx, trade(creator, launch, true, 11_000_000, 1), &[])
            .await
            .is_err()
    );
    send(&mut ctx, add_block(launch, creator, other), &[])
        .await
        .unwrap();
    assert_eq!(launch_state(&mut ctx, launch).await.blocked_uploaded, 2);
    assert!(send(
        &mut ctx,
        add_block(launch, creator, Pubkey::new_unique()),
        &[]
    )
    .await
    .is_err());
    let funding =
        solana_sdk::system_instruction::transfer(&creator, &blocked.pubkey(), 100_000_000);
    send(&mut ctx, funding, &[]).await.unwrap();
    ctx.warp_to_slot(40).unwrap();
    assert!(send(
        &mut ctx,
        trade(blocked.pubkey(), launch, true, 10_000_000, 1),
        &[&blocked]
    )
    .await
    .is_err());
    send(&mut ctx, trade(creator, launch, true, 12_000_000, 1), &[])
        .await
        .unwrap();
}
#[tokio::test]
async fn quick_bond_sell_timeout_and_transfers_off() {
    let (mut ctx, _, launch, _, _) = setup_rules(FeeMode::Holders, false, true, 0).await;
    let trader = Keypair::new();
    let creator = ctx.payer.pubkey();
    send(
        &mut ctx,
        solana_sdk::system_instruction::transfer(&creator, &trader.pubkey(), 1_000_000_000),
        &[],
    )
    .await
    .unwrap();
    send(
        &mut ctx,
        trade(trader.pubkey(), launch, true, 100_000_000, 1),
        &[&trader],
    )
    .await
    .unwrap();
    let amount = position_state(&mut ctx, launch, trader.pubkey())
        .await
        .balance
        / 2;
    assert!(send(
        &mut ctx,
        trade(trader.pubkey(), launch, false, amount, 0),
        &[&trader]
    )
    .await
    .is_err());
    assert!(send(
        &mut ctx,
        move_position(launch, trader.pubkey(), creator, 1, 1000),
        &[&trader]
    )
    .await
    .is_err());
    let mut clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = launch_state(&mut ctx, launch).await.created_at + 3600;
    ctx.set_sysvar(&clock);
    send(
        &mut ctx,
        trade(trader.pubkey(), launch, false, amount + 1, 0),
        &[&trader],
    )
    .await
    .unwrap();
    assert!(send(
        &mut ctx,
        move_position(launch, trader.pubkey(), creator, 2, 1000),
        &[&trader]
    )
    .await
    .is_err());
}
#[tokio::test]
async fn sniper_taxes_are_burn_budget_even_for_holder_mode() {
    let (mut ctx, mint, launch, vault, _) = setup(FeeMode::Holders).await;
    // Place activation at the current slot in this isolated bank to exercise block zero.
    let mut l = launch_state(&mut ctx, launch).await;
    let clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    l.start_slot = clock.slot;
    let mut account = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    l.try_serialize(&mut account.data.as_mut_slice()).unwrap();
    ctx.set_account(
        &launch,
        &solana_sdk::account::AccountSharedData::from(account),
    );
    let owner = ctx.payer.pubkey();
    send(&mut ctx, trade(owner, launch, true, 100_000_000, 1), &[])
        .await
        .unwrap();
    let l = launch_state(&mut ctx, launch).await;
    assert_eq!(
        (
            l.sniper_fees,
            l.sniper_tax_total,
            l.coin_fees,
            l.treasury_fees
        ),
        (96_800_000, 96_800_000, 0, 2_200_000)
    );
    let burn = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::BurnFees {
            launch,
            mint,
            vault,
            token_program: token::ID,
        }
        .to_account_metas(None),
        data: instruction::BurnFees {
            max_lamports: 99_000_000,
            min_tokens: 1,
            deadline_slot: 1000,
        }
        .data(),
    };
    send(&mut ctx, burn, &[]).await.unwrap();
    let l = launch_state(&mut ctx, launch).await;
    assert_eq!(l.sniper_fees, 0);
    assert_eq!(l.sniper_tax_total, 96_800_000);
    assert!(l.burned > 0);
}

fn ticker_address(ticker: &str) -> Pubkey {
    Pubkey::find_program_address(&[b"ticker", ticker.as_bytes()], &custom_launchpad::ID).0
}

async fn create_second_with_ticker(
    ctx: &mut ProgramTestContext,
    mint: &Keypair,
) -> Result<(), solana_program_test::BanksClientError> {
    let launch =
        Pubkey::find_program_address(&[b"launch", mint.pubkey().as_ref()], &custom_launchpad::ID).0;
    let config = Pubkey::find_program_address(&[b"config"], &custom_launchpad::ID).0;
    let ix = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::CreateLaunch {
            metadata: metadata_address(mint.pubkey()),
            metadata_program: anchor_spl::metadata::ID,
            rent: solana_sdk::sysvar::rent::ID,
            creator: ctx.payer.pubkey(),
            config,
            mint: mint.pubkey(),
            launch,
            vault: associated_token::get_associated_token_address(&launch, &mint.pubkey()),
            ticker_registry: ticker_address("TEST"),
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::CreateLaunch {
            args: LaunchArgs {
                app_mode: 0,
                app_authorities: vec![],
                name: "Test Coin".to_string(),
                uri: "https://example.com/token.json".to_string(),
                beneficiary: Pubkey::default(),
                developer_buy_lamports: 0,
                ticker: "TEST".to_string(),
                supply: 1_000_000_000_000_000,
                sale_tokens: 800_000_000_000_000,
                virtual_tokens: 1_000_000_000_000_000,
                virtual_quote: 30_000_000_000,
                target_quote: 85_000_000_000,
                max_wallet_bps: 400,
                protection_slots: 4,
                fee_mode: FeeMode::Burn,
                blocked: vec![],
                transfers_open: false,
                quick_bond: false,
                extra_blocked_count: 0,
            },
        }
        .data(),
    };
    send(ctx, ix, &[mint]).await
}
#[tokio::test]
async fn ticker_reservation_refreshes_and_reuses_only_after_six_idle_hours() {
    let (mut ctx, _, launch, _, _) = setup(FeeMode::Burn).await;
    assert!(create_second_with_ticker(&mut ctx, &Keypair::new())
        .await
        .is_err());
    let owner = ctx.payer.pubkey();
    let mut clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp += 100;
    ctx.set_sysvar(&clock);
    send(&mut ctx, trade(owner, launch, true, 100_000_000, 1), &[])
        .await
        .unwrap();
    let last = clock.unix_timestamp;
    clock.unix_timestamp = last + 21_599;
    ctx.set_sysvar(&clock);
    assert!(create_second_with_ticker(&mut ctx, &Keypair::new())
        .await
        .is_err());
    clock.unix_timestamp = last + 21_600;
    ctx.set_sysvar(&clock);
    let replacement = Keypair::new();
    create_second_with_ticker(&mut ctx, &replacement)
        .await
        .unwrap();
    // Old coins remain tradeable but cannot steal the replacement's ticker reservation.
    send(&mut ctx, trade(owner, launch, true, 110_000_000, 1), &[])
        .await
        .unwrap();
    let a = ctx
        .banks_client
        .get_account(ticker_address("TEST"))
        .await
        .unwrap()
        .unwrap();
    let registry =
        custom_launchpad::TickerRegistry::try_deserialize(&mut a.data.as_slice()).unwrap();
    assert_eq!(
        registry.launch,
        Pubkey::find_program_address(
            &[b"launch", replacement.pubkey().as_ref()],
            &custom_launchpad::ID
        )
        .0
    );
}

fn developer_ix(launch: Pubkey, owner: Pubkey, keeper: Pubkey) -> Instruction {
    Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ExecuteDeveloperBuy {
            keeper,
            launch,
            position: position_address(launch, owner),
            blocked_record: blocked_address(launch, owner),
            ticker_registry: ticker_address("TEST"),
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::ExecuteDeveloperBuy {}.data(),
    }
}
#[tokio::test]
async fn reserved_developer_buy_is_first_normal_fee_slot_capped_locked_and_once() {
    let (mut ctx, _, launch, _, _) =
        setup_developer(FeeMode::Holders, false, false, 0, 200_000_000).await;
    let owner = ctx.payer.pubkey();
    let before = ctx.banks_client.get_balance(launch).await.unwrap();
    assert!(
        send(&mut ctx, trade(owner, launch, true, 100_000_000, 1), &[])
            .await
            .is_err()
    );
    send(&mut ctx, developer_ix(launch, owner, owner), &[])
        .await
        .unwrap();
    let l = launch_state(&mut ctx, launch).await;
    let pos = position_state(&mut ctx, launch, owner).await;
    assert!(l.developer_executed);
    assert_eq!(l.developer_budget, 0);
    assert_eq!(l.quote, 195_000_000);
    assert_eq!(l.treasury_fees, 4_400_000);
    assert_eq!(l.sniper_fees, 0);
    assert!(pos.balance <= l.args.supply / 100);
    assert_eq!(pos.balance, pos.locked);
    assert_eq!(before, ctx.banks_client.get_balance(launch).await.unwrap());
    assert!(
        send(&mut ctx, trade(owner, launch, false, 1_000_000, 0), &[])
            .await
            .is_err()
    );
    ctx.warp_to_slot(40).unwrap();
    assert!(send(&mut ctx, developer_ix(launch, owner, owner), &[])
        .await
        .is_err());
    assert_eq!(l.quote, launch_state(&mut ctx, launch).await.quote);
}
#[tokio::test]
async fn developer_buy_cannot_execute_during_sniper_window() {
    let (mut ctx, _, launch, _, _) =
        setup_developer(FeeMode::Burn, false, false, 0, 200_000_000).await;
    let mut l = launch_state(&mut ctx, launch).await;
    let clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    l.start_slot = clock.slot;
    let mut a = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    l.try_serialize(&mut a.data.as_mut_slice()).unwrap();
    ctx.set_account(&launch, &solana_sdk::account::AccountSharedData::from(a));
    let owner = ctx.payer.pubkey();
    assert!(send(&mut ctx, developer_ix(launch, owner, owner), &[])
        .await
        .is_err());
    assert_eq!(
        launch_state(&mut ctx, launch).await.developer_budget,
        200_000_000
    );
}

async fn send_independent(
    ctx: &mut ProgramTestContext,
    ix: Instruction,
    signer: &Keypair,
) -> Result<(), solana_program_test::BanksClientError> {
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&signer.pubkey()), &[signer], hash);
    ctx.banks_client.process_transaction(tx).await
}
#[tokio::test]
async fn launch_signer_cannot_redirect_committed_developer_beneficiary() {
    let beneficiary = Keypair::new();
    let (mut ctx, _, launch, _, _) = setup_beneficiary(
        FeeMode::Holders,
        false,
        false,
        0,
        200_000_000,
        beneficiary.pubkey(),
    )
    .await;
    let keeper = ctx.payer.pubkey();
    assert!(send(&mut ctx, developer_ix(launch, keeper, keeper), &[])
        .await
        .is_err());
    send(
        &mut ctx,
        developer_ix(launch, beneficiary.pubkey(), keeper),
        &[],
    )
    .await
    .unwrap();
    let position = position_state(&mut ctx, launch, beneficiary.pubkey()).await;
    assert_eq!(position.owner, beneficiary.pubkey());
    assert!(position.locked > 0);
    assert!(ctx
        .banks_client
        .get_account(position_address(launch, keeper))
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn metadata_is_created_and_moderated_rename_is_delayed_and_single_use() {
    use anchor_spl::metadata::mpl_token_metadata::accounts::Metadata as MplMetadata;
    let (mut ctx, mint, launch, _, _) = setup(FeeMode::Burn).await;
    let owner = ctx.payer.pubkey();
    let account = ctx
        .banks_client
        .get_account(metadata_address(mint))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(account.owner, anchor_spl::metadata::ID);
    let metadata = MplMetadata::from_bytes(&account.data).unwrap();
    assert_eq!(metadata.name.trim_end_matches('\0'), "Test Coin");
    assert_eq!(metadata.symbol.trim_end_matches('\0'), "TEST");
    assert_eq!(metadata.update_authority, launch);
    assert!(metadata.is_mutable);
    send(&mut ctx, trade(owner, launch, true, 1_000_000, 1), &[])
        .await
        .unwrap();
    let (config, bump) = Pubkey::find_program_address(&[b"config"], &custom_launchpad::ID);
    let mut config_account = ctx.banks_client.get_account(config).await.unwrap().unwrap();
    let old = Config::try_deserialize(&mut config_account.data.as_slice()).unwrap();
    config_account.data.clear();
    Config {
        treasury: old.treasury,
        bump,
        metadata_authority: owner,
    }
    .try_serialize(&mut config_account.data)
    .unwrap();
    ctx.set_account(
        &config,
        &solana_sdk::account::AccountSharedData::from(config_account),
    );
    let proposal = Pubkey::find_program_address(
        &[
            b"rename",
            launch.as_ref(),
            owner.as_ref(),
            &1u64.to_le_bytes(),
        ],
        &custom_launchpad::ID,
    )
    .0;
    let propose = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ProposeMetadata {
            owner,
            launch,
            position: Some(position_address(launch, owner)),
            tokens: None,
            proposal,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::ProposeMetadata {
            nonce: 1,
            name: "New Coin".into(),
            uri: "ipfs://new-metadata".into(),
        }
        .data(),
    };
    send(&mut ctx, propose, &[]).await.unwrap();
    let like_address = Pubkey::find_program_address(
        &[b"rename-like", proposal.as_ref(), owner.as_ref()],
        &custom_launchpad::ID,
    )
    .0;
    let like = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::LikeMetadata {
            owner,
            launch,
            position: Some(position_address(launch, owner)),
            tokens: None,
            proposal,
            like: like_address,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::LikeMetadata {}.data(),
    };
    send(&mut ctx, like.clone(), &[]).await.unwrap();
    ctx.warp_to_slot(21).unwrap();
    assert!(send(&mut ctx, like, &[]).await.is_err());
    let execute = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ExecuteMetadata {
            authority: owner,
            config,
            launch,
            proposal,
            metadata: metadata_address(mint),
            metadata_program: anchor_spl::metadata::ID,
        }
        .to_account_metas(None),
        data: instruction::ExecuteMetadata {}.data(),
    };
    assert!(send(&mut ctx, execute.clone(), &[]).await.is_err());
    let mut clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp += 86_401;
    ctx.set_sysvar(&clock);
    ctx.warp_to_slot(22).unwrap();
    let unauthorized = Keypair::new();
    let mut wrong_authority = execute.clone();
    wrong_authority.accounts[0].pubkey = unauthorized.pubkey();
    assert!(send(&mut ctx, wrong_authority, &[&unauthorized])
        .await
        .is_err());
    send(&mut ctx, execute.clone(), &[]).await.unwrap();
    let account = ctx
        .banks_client
        .get_account(metadata_address(mint))
        .await
        .unwrap()
        .unwrap();
    let metadata = MplMetadata::from_bytes(&account.data).unwrap();
    assert_eq!(metadata.name.trim_end_matches('\0'), "New Coin");
    assert_eq!(metadata.symbol.trim_end_matches('\0'), "TEST");
    assert_eq!(metadata.uri.trim_end_matches('\0'), "ipfs://new-metadata");
    assert_eq!(metadata.update_authority, launch);
    ctx.warp_to_slot(23).unwrap();
    assert!(send(&mut ctx, execute, &[]).await.is_err());
}

#[tokio::test]
async fn social_round_funds_are_reserved_proofs_bound_and_expiry_returns_only_unclaimed() {
    use anchor_lang::solana_program::hash::hashv;
    let (mut ctx, mint, launch, _, _) = setup(FeeMode::Yap).await;
    let operator = ctx.payer.pubkey();
    send(&mut ctx, trade(operator, launch, true, 10_000_000, 1), &[])
        .await
        .unwrap();
    let (config, bump) = Pubkey::find_program_address(&[b"config"], &custom_launchpad::ID);
    let mut account = ctx.banks_client.get_account(config).await.unwrap().unwrap();
    let old = Config::try_deserialize(&mut account.data.as_slice()).unwrap();
    account.data.clear();
    Config {
        treasury: old.treasury,
        bump,
        metadata_authority: operator,
    }
    .try_serialize(&mut account.data)
    .unwrap();
    ctx.set_account(
        &config,
        &solana_sdk::account::AccountSharedData::from(account),
    );
    let mut clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    let hour = (clock.unix_timestamp as u64) / 3600 - 1;
    let round = Pubkey::find_program_address(
        &[b"social-round", launch.as_ref(), &hour.to_le_bytes()],
        &custom_launchpad::ID,
    )
    .0;
    let alice = Pubkey::new_unique();
    let bob = Pubkey::new_unique();
    for wallet in [alice, bob] {
        send(
            &mut ctx,
            solana_sdk::system_instruction::transfer(&operator, &wallet, 1_000_000),
            &[],
        )
        .await
        .unwrap();
    }
    let leaf_a = hashv(&[
        b"yap-v1",
        round.as_ref(),
        alice.as_ref(),
        &10_000u64.to_le_bytes(),
    ])
    .to_bytes();
    let leaf_b = hashv(&[
        b"yap-v1",
        round.as_ref(),
        bob.as_ref(),
        &20_000u64.to_le_bytes(),
    ])
    .to_bytes();
    let root = if leaf_a <= leaf_b {
        hashv(&[b"yap-node", &leaf_a, &leaf_b])
    } else {
        hashv(&[b"yap-node", &leaf_b, &leaf_a])
    }
    .to_bytes();
    let before = launch_state(&mut ctx, launch).await.coin_fees;
    let publish = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::PublishSocialRound {
            authority: operator,
            config,
            launch,
            round,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::PublishSocialRound {
            hour,
            root,
            budget: 30_000,
        }
        .data(),
    };
    send(&mut ctx, publish, &[]).await.unwrap();
    assert_eq!(
        launch_state(&mut ctx, launch).await.coin_fees,
        before - 30_000
    );
    let claim = |owner: Pubkey, amount: u64, proof: Vec<[u8; 32]>| Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ClaimSocialReward {
            payer: operator,
            owner,
            round,
            receipt: Pubkey::find_program_address(
                &[b"social-receipt", round.as_ref(), owner.as_ref()],
                &custom_launchpad::ID,
            )
            .0,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::ClaimSocialReward { amount, proof }.data(),
    };
    assert!(send(&mut ctx, claim(bob, 10_000, vec![leaf_b]), &[])
        .await
        .is_err());
    assert!(send(&mut ctx, claim(alice, 10_001, vec![leaf_b]), &[])
        .await
        .is_err());
    send(&mut ctx, claim(alice, 10_000, vec![leaf_b]), &[])
        .await
        .unwrap();
    assert_eq!(
        ctx.banks_client.get_balance(alice).await.unwrap(),
        1_010_000
    );
    ctx.warp_to_slot(21).unwrap();
    assert!(send(&mut ctx, claim(alice, 10_000, vec![leaf_b]), &[])
        .await
        .is_err());
    let expire = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ExpireSocialRound { launch, round }.to_account_metas(None),
        data: instruction::ExpireSocialRound {}.data(),
    };
    assert!(send(&mut ctx, expire.clone(), &[]).await.is_err());
    clock.unix_timestamp += 604_801;
    ctx.warp_to_slot(22).unwrap();
    ctx.set_sysvar(&clock);
    send(&mut ctx, expire, &[]).await.unwrap();
    assert_eq!(
        launch_state(&mut ctx, launch).await.coin_fees,
        before - 10_000
    );
    assert!(send(&mut ctx, claim(bob, 20_000, vec![leaf_a]), &[])
        .await
        .is_err());
    assert!(!launch_state(&mut ctx, launch).await.graduated);
    assert_eq!(launch_state(&mut ctx, launch).await.mint, mint);
}

#[tokio::test]
async fn app_policy_requires_registered_cosigner_but_never_blocks_selling() {
    let (mut ctx, _, launch, _, _) = setup(FeeMode::Burn).await;
    let operator = ctx.payer.pubkey();
    let (config, bump) = Pubkey::find_program_address(&[b"config"], &custom_launchpad::ID);
    let mut a = ctx.banks_client.get_account(config).await.unwrap().unwrap();
    let old = Config::try_deserialize(&mut a.data.as_slice()).unwrap();
    a.data.clear();
    Config {
        treasury: old.treasury,
        bump,
        metadata_authority: operator,
    }
    .try_serialize(&mut a.data)
    .unwrap();
    ctx.set_account(&config, &solana_sdk::account::AccountSharedData::from(a));
    let app = Keypair::new();
    let record =
        Pubkey::find_program_address(&[b"app", app.pubkey().as_ref()], &custom_launchpad::ID).0;
    let register = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::RegisterApp {
            operator,
            config,
            app_authority: app.pubkey(),
            record,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::RegisterApp {
            name: "Test integration".into(),
        }
        .data(),
    };
    send(&mut ctx, register, &[&app]).await.unwrap();
    let mut a = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let mut l = Launch::try_deserialize(&mut a.data.as_slice()).unwrap();
    l.args.app_mode = 1;
    l.args.app_authorities = vec![app.pubkey()];
    a.data.clear();
    l.try_serialize(&mut a.data).unwrap();
    ctx.set_account(&launch, &solana_sdk::account::AccountSharedData::from(a));
    let buy = trade(operator, launch, true, 1_000_000, 1);
    assert!(send(&mut ctx, buy.clone(), &[]).await.is_err());
    let mut allowed = buy;
    allowed.accounts[6] = solana_sdk::instruction::AccountMeta::new_readonly(app.pubkey(), true);
    allowed.accounts[7] = solana_sdk::instruction::AccountMeta::new_readonly(record, false);
    send(&mut ctx, allowed.clone(), &[&app]).await.unwrap();
    ctx.warp_to_slot(21).unwrap();
    let mut a = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let mut l = Launch::try_deserialize(&mut a.data.as_slice()).unwrap();
    l.args.app_mode = 2;
    a.data.clear();
    l.try_serialize(&mut a.data).unwrap();
    ctx.set_account(&launch, &solana_sdk::account::AccountSharedData::from(a));
    assert!(send(&mut ctx, allowed, &[&app]).await.is_err());
    let position = ctx
        .banks_client
        .get_account(position_address(launch, operator))
        .await
        .unwrap()
        .unwrap();
    let p = Position::try_deserialize(&mut position.data.as_slice()).unwrap();
    let mut clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = p.unlock_at;
    ctx.set_sysvar(&clock);
    send(&mut ctx, trade(operator, launch, false, p.balance, 1), &[])
        .await
        .unwrap();
}

// Isolate other financial tests from oracle timing. The separate VRF scenario
// exercises the actual request, signature verification, fulfillment and activation.
async fn activate_fixed_fixture(ctx: &mut ProgramTestContext, launch: Pubkey) {
    let mut account = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let mut state = Launch::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert!(!state.randomness_ready);
    state.randomness_ready = true;
    state
        .try_serialize(&mut account.data.as_mut_slice())
        .unwrap();
    ctx.set_account(
        &launch,
        &solana_sdk::account::AccountSharedData::from(account),
    );
}

#[tokio::test]
async fn unopened_launch_cancellation_recovers_only_prefunded_budget_and_cannot_replay() {
    let (mut ctx, mint, launch, vault, _) =
        setup_developer(FeeMode::Burn, false, false, 0, 10_000_000).await;
    let cancel = |launcher| Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::CancelLaunch {
            launcher,
            launch,
            mint,
            vault,
            ticker_registry: ticker_address("TEST"),
            token_program: token::ID,
        }
        .to_account_metas(None),
        data: instruction::CancelLaunch {}.data(),
    };
    let payer = ctx.payer.pubkey();
    // An activated market is never cancellable, even with no trades.
    assert!(send(&mut ctx, cancel(payer), &[]).await.is_err());
    let mut account = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let mut state = Launch::try_deserialize(&mut account.data.as_slice()).unwrap();
    state.randomness_ready = false;
    state.activation_requested = false;
    let mut encoded = vec![];
    state.try_serialize(&mut encoded).unwrap();
    account.data[..encoded.len()].copy_from_slice(&encoded);
    ctx.set_account(&launch, &account.into());
    let attacker = Keypair::new();
    assert!(send(&mut ctx, cancel(attacker.pubkey()), &[&attacker])
        .await
        .is_err());
    let before = ctx.banks_client.get_balance(launch).await.unwrap();
    ctx.warp_to_slot(21).unwrap();
    send(&mut ctx, cancel(payer), &[]).await.unwrap();
    let after = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let state = Launch::try_deserialize(&mut after.data.as_slice()).unwrap();
    assert!(state.cancelled);
    assert_eq!(state.developer_budget, 0);
    assert_eq!(before - after.lamports, 10_000_000);
    use solana_sdk::program_pack::Pack;
    let mint_account = ctx.banks_client.get_account(mint).await.unwrap().unwrap();
    assert_eq!(
        token::spl_token::state::Mint::unpack(&mint_account.data)
            .unwrap()
            .supply,
        0
    );
    let registry = ctx
        .banks_client
        .get_account(ticker_address("TEST"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        custom_launchpad::TickerRegistry::try_deserialize(&mut registry.data.as_slice())
            .unwrap()
            .launch,
        Pubkey::default()
    );
    ctx.warp_to_slot(22).unwrap();
    assert!(send(&mut ctx, cancel(payer), &[]).await.is_err());
    assert!(send(&mut ctx, trade(payer, launch, true, 1000, 1), &[])
        .await
        .is_err());
}

#[cfg(feature = "experimental-classic")]
#[tokio::test]
async fn classic_wallet_tokens_roundtrip_and_wrong_treasury_rejection() {
    use custom_launchpad::classic::{ClassicArgs, ClassicLaunch};
    let (mut ctx, _, _, _, treasury) = setup(FeeMode::Burn).await;
    let mint = Keypair::new();
    let creator = ctx.payer.pubkey();
    let program = custom_launchpad::ID;
    let launch = Pubkey::find_program_address(&[b"classic", mint.pubkey().as_ref()], &program).0;
    let config = Pubkey::find_program_address(&[b"config"], &program).0;
    let vault = associated_token::get_associated_token_address(&launch, &mint.pubkey());
    let wallet_tokens = associated_token::get_associated_token_address(&creator, &mint.pubkey());
    send(
        &mut ctx,
        Instruction {
            program_id: program,
            accounts: accounts::CreateClassic {
                creator,
                config,
                mint: mint.pubkey(),
                launch,
                vault,
                token_program: token::ID,
                associated_token_program: associated_token::ID,
                system_program: solana_sdk::system_program::ID,
                metadata: metadata_address(mint.pubkey()),
                metadata_program: anchor_spl::metadata::ID,
                rent: solana_sdk::sysvar::rent::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateClassic {
                args: ClassicArgs {
                    name: "Classic".into(),
                    symbol: "V1".into(),
                    uri: "ipfs://classic-test".into(),
                },
            }
            .data(),
        },
        &[&mint],
    )
    .await
    .unwrap();
    let trade = accounts::TradeClassic {
        trader: creator,
        launch,
        mint: mint.pubkey(),
        vault,
        wallet_tokens,
        token_program: token::ID,
        associated_token_program: associated_token::ID,
        system_program: solana_sdk::system_program::ID,
    };
    let tokens = 1_000_000_000u64;
    send(
        &mut ctx,
        Instruction {
            program_id: program,
            accounts: trade.to_account_metas(None),
            data: instruction::BuyClassic {
                tokens,
                max_lamports: 1_000_000,
                deadline_slot: u64::MAX,
            }
            .data(),
        },
        &[],
    )
    .await
    .unwrap();
    use solana_sdk::program_pack::Pack;
    let wallet = ctx
        .banks_client
        .get_account(wallet_tokens)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        token::spl_token::state::Account::unpack(&wallet.data)
            .unwrap()
            .amount,
        tokens
    );
    // Token authority belongs to the buyer; classic does not create a custody Position.
    let position =
        Pubkey::find_program_address(&[b"position", launch.as_ref(), creator.as_ref()], &program).0;
    assert!(ctx
        .banks_client
        .get_account(position)
        .await
        .unwrap()
        .is_none());
    send(
        &mut ctx,
        Instruction {
            program_id: program,
            accounts: trade.to_account_metas(None),
            data: instruction::SellClassic {
                tokens,
                min_lamports: 1,
                deadline_slot: u64::MAX,
            }
            .data(),
        },
        &[],
    )
    .await
    .unwrap();
    let raw = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let state = ClassicLaunch::try_deserialize(&mut raw.data.as_slice()).unwrap();
    assert_eq!(state.sold, 0);
    assert!(state.fees > 0);
    let bad = Instruction {
        program_id: program,
        accounts: accounts::CollectClassicFees {
            launch,
            treasury: creator,
        }
        .to_account_metas(None),
        data: instruction::CollectClassicFees {}.data(),
    };
    assert!(send(&mut ctx, bad, &[]).await.is_err());
    send(
        &mut ctx,
        Instruction {
            program_id: program,
            accounts: accounts::CollectClassicFees { launch, treasury }.to_account_metas(None),
            data: instruction::CollectClassicFees {}.data(),
        },
        &[],
    )
    .await
    .unwrap();
    let raw = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(
        ClassicLaunch::try_deserialize(&mut raw.data.as_slice())
            .unwrap()
            .fees,
        0
    );
}

#[tokio::test]
async fn creator_rewards_and_vesting_cannot_be_redirected_or_claimed_early() {
    use custom_launchpad::creator_features::CreatorVesting;
    let (mut ctx, mint, launch, vault, _) =
        setup_developer(FeeMode::Creator, false, false, 0, 200_000_000).await;
    let current: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    ctx.warp_to_slot(current.slot + 10).unwrap();
    let creator = ctx.payer.pubkey();
    send(&mut ctx, developer_ix(launch, creator, creator), &[])
        .await
        .unwrap();
    ctx.warp_to_slot(current.slot + 11).unwrap();
    send(&mut ctx, trade(creator, launch, true, 200_000_000, 1), &[])
        .await
        .unwrap();
    let p = Pubkey::find_program_address(
        &[b"position", launch.as_ref(), creator.as_ref()],
        &custom_launchpad::ID,
    )
    .0;
    let vesting = Pubkey::find_program_address(
        &[b"creator-vesting", launch.as_ref()],
        &custom_launchpad::ID,
    )
    .0;
    let amount = 10_000_000_000_000u64;
    send(
        &mut ctx,
        Instruction {
            program_id: custom_launchpad::ID,
            accounts: accounts::LockCreatorTokens {
                creator,
                launch,
                position: p,
                vesting,
                system_program: solana_sdk::system_program::ID,
            }
            .to_account_metas(None),
            data: instruction::LockCreatorTokens { amount }.data(),
        },
        &[],
    )
    .await
    .unwrap();
    let claim = Instruction {
        program_id: custom_launchpad::ID,
        accounts: accounts::ClaimCreatorVesting {
            creator,
            launch,
            vesting,
            mint,
            vault,
            destination: associated_token::get_associated_token_address(&creator, &mint),
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::ClaimCreatorVesting {}.data(),
    };
    assert!(send(&mut ctx, claim.clone(), &[]).await.is_err());
    let before = launch_state(&mut ctx, launch).await;
    assert!(before.coin_fees > 0);
    send(
        &mut ctx,
        Instruction {
            program_id: custom_launchpad::ID,
            accounts: accounts::CollectCreatorFees { launch, creator }.to_account_metas(None),
            data: instruction::CollectCreatorFees {}.data(),
        },
        &[],
    )
    .await
    .unwrap();
    let after = launch_state(&mut ctx, launch).await;
    assert_eq!(after.coin_fees, 0);
    assert_eq!(after.quote, before.quote);
    assert_eq!(after.treasury_fees, before.treasury_fees);
    // Isolate vesting timing from the already separate PumpSwap migration runtime test.
    let mut raw = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let mut state = Launch::try_deserialize(&mut raw.data.as_slice()).unwrap();
    state.graduated = true;
    state.graduated_at = current.unix_timestamp + 100_000;
    let mut bytes = vec![];
    state.try_serialize(&mut bytes).unwrap();
    raw.data[..bytes.len()].copy_from_slice(&bytes);
    ctx.set_account(&launch, &raw.into());
    let mut clock: solana_sdk::clock::Clock = ctx.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = state.graduated_at + launch_core::vesting::CLIFF;
    ctx.set_sysvar(&clock);
    assert!(send(&mut ctx, claim.clone(), &[]).await.is_err());
    clock.unix_timestamp += launch_core::vesting::DURATION / 2;
    ctx.set_sysvar(&clock);
    // Distinct compute-budget instruction avoids duplicate-signature caching of failed claims.
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[
            solana_sdk::compute_budget::ComputeBudgetInstruction::set_compute_unit_limit(300_000),
            claim,
        ],
        Some(&creator),
        &[&ctx.payer],
        hash,
    );
    ctx.banks_client.process_transaction(tx).await.unwrap();
    let raw = ctx
        .banks_client
        .get_account(vesting)
        .await
        .unwrap()
        .unwrap();
    let v = CreatorVesting::try_deserialize(&mut raw.data.as_slice()).unwrap();
    assert_eq!(v.claimed, amount / 2);
}

#[cfg(feature = "experimental-classic")]
#[tokio::test]
async fn classic_actual_pumpswap_graduation_burns_lp_without_custody() {
    classic_graduation_scenario(1_000_000).await;
}

#[tokio::test]
async fn classic_actual_pumpswap_graduation_without_prefunded_authority() {
    classic_graduation_scenario(0).await;
}

async fn classic_graduation_scenario(authority_donation: u64) {
    use base64::Engine;
    use custom_launchpad::migration::{PUMP_SWAP, WSOL};
    use solana_sdk::{compute_budget::ComputeBudgetInstruction, program_pack::Pack};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/external");
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join("pumpswap-global.json"))
            .expect("run scripts/fetch-pumpswap-fixture.mjs first"),
    )
    .unwrap();
    let treasury = Pubkey::new_unique();
    let (config, bump) = Pubkey::find_program_address(&[b"config"], &custom_launchpad::ID);
    let mut config_data = vec![];
    Config {
        treasury,
        bump,
        metadata_authority: Pubkey::default(),
    }
    .try_serialize(&mut config_data)
    .unwrap();
    let mut pt = launchpad_test();
    pt.add_program("spl_token", token::ID, processor!(strict_token_entry));
    pt.add_program(
        "spl_associated_token_account",
        associated_token::ID,
        processor!(associated_token::spl_associated_token_account::processor::process_instruction),
    );
    pt.add_program(
        "spl_token_2022",
        anchor_spl::token_2022::ID,
        processor!(anchor_spl::token_2022::spl_token_2022::processor::Processor::process),
    );
    // Install the captured ELF under the same program ID, only in this local bank.
    let binary = std::fs::read(root.join("pump_amm.so")).unwrap();
    pt.add_account(
        PUMP_SWAP,
        Account {
            lamports: 100_000_000,
            data: binary,
            owner: solana_sdk::bpf_loader::ID,
            executable: true,
            rent_epoch: 0,
        },
    );
    let global: Pubkey = fixture["address"].as_str().unwrap().parse().unwrap();
    pt.add_account(
        global,
        Account {
            lamports: fixture["lamports"].as_u64().unwrap(),
            data: base64::engine::general_purpose::STANDARD
                .decode(fixture["dataBase64"].as_str().unwrap())
                .unwrap(),
            owner: PUMP_SWAP,
            executable: false,
            rent_epoch: 0,
        },
    );
    pt.add_account(
        config,
        Account {
            lamports: 10_000_000,
            data: config_data,
            owner: custom_launchpad::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut native_data = vec![0; token::spl_token::state::Mint::LEN];
    token::spl_token::state::Mint {
        mint_authority: solana_sdk::program_option::COption::None,
        supply: 0,
        decimals: 9,
        is_initialized: true,
        freeze_authority: solana_sdk::program_option::COption::None,
    }
    .pack_into_slice(&mut native_data);
    pt.add_account(
        WSOL,
        Account {
            lamports: 10_000_000,
            data: native_data,
            owner: token::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut ctx = pt.start_with_context().await;

    use custom_launchpad::classic::{ClassicArgs, ClassicLaunch};
    let mint = Keypair::new();
    let mint_key = mint.pubkey();
    let creator = ctx.payer.pubkey();
    let launch =
        Pubkey::find_program_address(&[b"classic", mint_key.as_ref()], &custom_launchpad::ID).0;
    let vault = associated_token::get_associated_token_address(&launch, &mint_key);
    send(
        &mut ctx,
        Instruction {
            program_id: custom_launchpad::ID,
            accounts: accounts::CreateClassic {
                creator,
                config,
                mint: mint_key,
                launch,
                vault,
                token_program: token::ID,
                associated_token_program: associated_token::ID,
                system_program: solana_sdk::system_program::ID,
                metadata: metadata_address(mint_key),
                metadata_program: anchor_spl::metadata::ID,
                rent: solana_sdk::sysvar::rent::ID,
            }
            .to_account_metas(None),
            data: instruction::CreateClassic {
                args: ClassicArgs {
                    name: "Classic migration".into(),
                    symbol: "V1".into(),
                    uri: "ipfs://test".into(),
                },
            }
            .data(),
        },
        &[&mint],
    )
    .await
    .unwrap();
    let wallet_tokens = associated_token::get_associated_token_address(&creator, &mint_key);
    let mut remaining = launch_core::classic::SALE;
    let mut slot = 10;
    while remaining > 0 {
        ctx.warp_to_slot(slot).unwrap();
        send(
            &mut ctx,
            Instruction {
                program_id: custom_launchpad::ID,
                accounts: accounts::TradeClassic {
                    trader: creator,
                    launch,
                    mint: mint_key,
                    vault,
                    wallet_tokens,
                    token_program: token::ID,
                    associated_token_program: associated_token::ID,
                    system_program: solana_sdk::system_program::ID,
                }
                .to_account_metas(None),
                data: instruction::BuyClassic {
                    tokens: remaining.min(launch_core::classic::SUPPLY / 100),
                    max_lamports: 100_000_000_000,
                    deadline_slot: u64::MAX,
                }
                .data(),
            },
            &[],
        )
        .await
        .unwrap();
        remaining -= remaining.min(launch_core::classic::SUPPLY / 100);
        slot += 1;
    }
    let raw = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let before = ClassicLaunch::try_deserialize(&mut raw.data.as_slice()).unwrap();
    let authority =
        Pubkey::find_program_address(&[b"migration", launch.as_ref()], &custom_launchpad::ID).0;
    let pool = Pubkey::find_program_address(
        &[
            b"pool",
            &1u16.to_le_bytes(),
            authority.as_ref(),
            mint_key.as_ref(),
            WSOL.as_ref(),
        ],
        &PUMP_SWAP,
    )
    .0;
    let lp_mint = Pubkey::find_program_address(&[b"pool_lp_mint", pool.as_ref()], &PUMP_SWAP).0;
    let user_lp = associated_token::get_associated_token_address_with_program_id(
        &authority,
        &lp_mint,
        &anchor_spl::token_2022::ID,
    );
    // An independent keeper has too little SOL to fund pool rent; only signs the action.
    let rentless_keeper = Keypair::new();
    let payer = ctx.payer.pubkey();
    send(
        &mut ctx,
        solana_sdk::system_instruction::transfer(&payer, &rentless_keeper.pubkey(), 1_000_000),
        &[],
    )
    .await
    .unwrap();
    // Pre-create one canonical ATA. Graduation must not charge its rent again.
    let prefunded_base = associated_token::get_associated_token_address(&authority, &mint_key);
    send(&mut ctx, associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(
        &payer, &authority, &mint_key, &token::ID), &[]).await.unwrap();
    let prefunded_rent = ctx.banks_client.get_balance(prefunded_base).await.unwrap();
    // An unsolicited authority donation must not be taken or refunded to the keeper.
    send(
        &mut ctx,
        solana_sdk::system_instruction::transfer(&payer, &authority, authority_donation),
        &[],
    )
    .await
    .unwrap();
    let g = accounts::GraduateClassic {
        keeper: rentless_keeper.pubkey(),
        launch,
        mint: mint_key,
        quote_mint: WSOL,
        vault,
        authority,
        user_base: associated_token::get_associated_token_address(&authority, &mint_key),
        user_quote: associated_token::get_associated_token_address(&authority, &WSOL),
        pool,
        global_config: global,
        lp_mint,
        user_lp,
        pool_base: associated_token::get_associated_token_address(&pool, &mint_key),
        pool_quote: associated_token::get_associated_token_address(&pool, &WSOL),
        event_authority: Pubkey::find_program_address(&[b"__event_authority"], &PUMP_SWAP).0,
        pump_program: PUMP_SWAP,
        token_program: token::ID,
        token_2022_program: anchor_spl::token_2022::ID,
        associated_token_program: associated_token::ID,
        system_program: solana_sdk::system_program::ID,
    };
    let ix = Instruction {
        program_id: custom_launchpad::ID,
        accounts: g.to_account_metas(None),
        data: instruction::GraduateClassic {}.data(),
    };
    let launch_before = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let keeper_before = ctx
        .banks_client
        .get_balance(rentless_keeper.pubkey())
        .await
        .unwrap();
    // Real worker shape: an unfunded fee payer cannot start migration or debit curve reserves.
    let unfunded = Keypair::new();
    let mut unfunded_ix = ix.clone();
    unfunded_ix.accounts[0].pubkey = unfunded.pubkey();
    ctx.set_account(&unfunded.pubkey(), &Account { lamports: 1, data: vec![], owner: solana_sdk::system_program::ID, executable: false, rent_epoch: 0 }.into());
    let unfunded_tx = Transaction::new_signed_with_payer(&[unfunded_ix], Some(&unfunded.pubkey()), &[&unfunded], ctx.banks_client.get_latest_blockhash().await.unwrap());
    let insufficient = ctx.banks_client.simulate_transaction(unfunded_tx).await.unwrap();
    assert_eq!(insufficient.result.unwrap(), Err(solana_sdk::transaction::TransactionError::InsufficientFundsForFee));
    let untouched = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(untouched.lamports, launch_before.lamports);
    assert_eq!(untouched.data, launch_before.data);
    // Rejected account substitution must roll back curve funds and temporary accounts.
    let mut bad = ix.clone();
    bad.accounts[6].pubkey = vault;
    assert!(send(&mut ctx, bad, &[&rentless_keeper]).await.is_err());
    let rejected = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(rejected.lamports, launch_before.lamports);
    assert_eq!(rejected.data, launch_before.data);
    assert_eq!(
        ctx.banks_client.get_balance(authority).await.unwrap(),
        authority_donation
    );
    // A rent schedule exceeding the fixed reserve must fail atomically, never raid fees.
    let rent: solana_sdk::rent::Rent = ctx.banks_client.get_sysvar().await.unwrap();
    let mut expensive_rent = rent.clone();
    expensive_rent.lamports_per_byte_year *= 100;
    ctx.set_sysvar(&expensive_rent);
    assert!(send(&mut ctx, ix.clone(), &[&rentless_keeper])
        .await
        .is_err());
    ctx.set_sysvar(&rent);
    let rejected_rent = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(rejected_rent.lamports, launch_before.lamports);
    assert_eq!(rejected_rent.data, launch_before.data);
    assert!(ctx.banks_client.get_account(pool).await.unwrap().is_none());
    assert_eq!(
        ctx.banks_client.get_balance(authority).await.unwrap(),
        authority_donation
    );
    let retry_ix = ix.clone();
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(600_000),
            ix,
        ],
        Some(&rentless_keeper.pubkey()),
        &[&rentless_keeper],
        hash,
    );
    let migration_fee = ctx.banks_client.get_fee_for_message(tx.message.clone()).await.unwrap().unwrap();
    ctx.banks_client.process_transaction(tx).await.unwrap();
    assert_eq!(
        ctx.banks_client
            .get_balance(rentless_keeper.pubkey())
            .await
            .unwrap(),
        keeper_before - migration_fee
    );
    assert_eq!(
        ctx.banks_client.get_balance(authority).await.unwrap(),
        authority_donation
    );
    let mut rent_used = 0u64;
    for address in [
        g.user_base,
        g.user_quote,
        g.pool_base,
        g.pool_quote,
        pool,
        lp_mint,
        user_lp,
    ] {
        let account = ctx
            .banks_client
            .get_account(address)
            .await
            .unwrap()
            .unwrap();
        let token_amount = if address == g.pool_quote || address == g.user_quote {
            token::spl_token::state::Account::unpack(&account.data)
                .unwrap()
                .amount
        } else {
            0
        };
        rent_used += account.lamports - token_amount;
    }
    rent_used -= prefunded_rent;
    assert!(rent_used > 0 && rent_used < custom_launchpad::graduation_costs::MAX_SETUP_LAMPORTS);
    let quote_account = ctx
        .banks_client
        .get_account(g.pool_quote)
        .await
        .unwrap()
        .unwrap();
    let actual_quote = token::spl_token::state::Account::unpack(&quote_account.data)
        .unwrap()
        .amount;
    assert_eq!(actual_quote + rent_used, before.quote);
    let base_account = ctx
        .banks_client
        .get_account(g.pool_base)
        .await
        .unwrap()
        .unwrap();
    let actual_base = token::spl_token::state::Account::unpack(&base_account.data)
        .unwrap()
        .amount;
    assert_eq!(
        actual_base,
        launch_core::mul_div(
            actual_quote,
            launch_core::classic::VIRTUAL_TOKENS - before.sold,
            launch_core::classic::VIRTUAL_SOL + before.quote
        )
        .unwrap()
    );
    let graduated_account = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert!(send(&mut ctx, retry_ix, &[&rentless_keeper]).await.is_err());
    let retried = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(retried.lamports, graduated_account.lamports);
    assert_eq!(retried.data, graduated_account.data);

    let raw = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let after = ClassicLaunch::try_deserialize(&mut raw.data.as_slice()).unwrap();
    assert!(after.graduated);
    assert_eq!(after.quote, 0);
    assert_eq!(after.pool, pool);
    assert_eq!(after.fees, before.fees);
    let wallet = ctx
        .banks_client
        .get_account(wallet_tokens)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        token::spl_token::state::Account::unpack(&wallet.data)
            .unwrap()
            .amount,
        launch_core::classic::SALE
    );
    let lp = ctx
        .banks_client
        .get_account(user_lp)
        .await
        .unwrap()
        .unwrap();
    let parsed = anchor_spl::token_2022::spl_token_2022::extension::StateWithExtensions::<
        anchor_spl::token_2022::spl_token_2022::state::Account,
    >::unpack(&lp.data)
    .unwrap();
    assert_eq!(parsed.base.amount, 0);
    let holder = Keypair::from_bytes(&ctx.payer.to_bytes()).unwrap();
    pumpswap_round_trip(&mut ctx, pool, mint_key, &holder).await;

}

#[tokio::test]
async fn shared_buy_cap_rejects_multiwallet_atomic_buys_and_sell_reset() {
    let (mut ctx, _, launch, _, _) = setup(FeeMode::Burn).await;
    let alice = Keypair::new();
    let bob = Keypair::new();
    for user in [&alice, &bob] {
        let fund = solana_sdk::system_instruction::transfer(
            &ctx.payer.pubkey(),
            &user.pubkey(),
            1_000_000_000,
        );
        send(&mut ctx, fund, &[]).await.unwrap();
    }
    let before = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[
            trade(alice.pubkey(), launch, true, 200_000_000, 1),
            trade(bob.pubkey(), launch, true, 200_000_000, 1),
        ],
        Some(&ctx.payer.pubkey()),
        &[&ctx.payer, &alice, &bob],
        hash,
    );
    assert!(ctx.banks_client.process_transaction(tx).await.is_err());
    let after = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(before.data, after.data);
    assert_eq!(before.lamports, after.lamports);
    send(
        &mut ctx,
        trade(alice.pubkey(), launch, true, 200_000_000, 2),
        &[&alice],
    )
    .await
    .unwrap();
    let balance = position_state(&mut ctx, launch, alice.pubkey())
        .await
        .balance;
    assert!(send(
        &mut ctx,
        trade(bob.pubkey(), launch, true, 200_000_000, 3),
        &[&bob]
    )
    .await
    .is_err());
    send(
        &mut ctx,
        trade(alice.pubkey(), launch, false, balance, 1),
        &[&alice],
    )
    .await
    .unwrap();
    let used = launch_state(&mut ctx, launch).await.slot_bought;
    assert_eq!(used, balance);
    assert!(send(
        &mut ctx,
        trade(bob.pubkey(), launch, true, 200_000_000, 4),
        &[&bob]
    )
    .await
    .is_err());
    ctx.warp_to_slot(21).unwrap();
    send(
        &mut ctx,
        trade(bob.pubkey(), launch, true, 200_000_000, 5),
        &[&bob],
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn classic_shared_buy_cap_cannot_be_split_across_wallets() {
    use custom_launchpad::classic::{ClassicArgs, ClassicLaunch};
    let (mut ctx, _, _, _, _) = setup(FeeMode::Burn).await;
    let creator = ctx.payer.pubkey();
    let mint = Keypair::new();
    let program = custom_launchpad::ID;
    let launch = Pubkey::find_program_address(&[b"classic", mint.pubkey().as_ref()], &program).0;
    let vault = associated_token::get_associated_token_address(&launch, &mint.pubkey());
    let create = Instruction {
        program_id: program,
        accounts: accounts::CreateClassic {
            creator,
            config: Pubkey::find_program_address(&[b"config"], &program).0,
            mint: mint.pubkey(),
            launch,
            vault,
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
            metadata: metadata_address(mint.pubkey()),
            metadata_program: anchor_spl::metadata::ID,
            rent: solana_sdk::sysvar::rent::ID,
        }
        .to_account_metas(None),
        data: instruction::CreateClassic {
            args: ClassicArgs {
                name: "Protected".into(),
                symbol: "SAFE".into(),
                uri: "ipfs://test".into(),
            },
        }
        .data(),
    };
    send(&mut ctx, create, &[&mint]).await.unwrap();
    let alice = Keypair::new();
    let bob = Keypair::new();
    for user in [&alice, &bob] {
        send(
            &mut ctx,
            solana_sdk::system_instruction::transfer(&creator, &user.pubkey(), 2_000_000_000),
            &[],
        )
        .await
        .unwrap();
    }
    let ix = |owner, tokens, buy| Instruction {
        program_id: program,
        accounts: accounts::TradeClassic {
            trader: owner,
            launch,
            mint: mint.pubkey(),
            vault,
            wallet_tokens: associated_token::get_associated_token_address(&owner, &mint.pubkey()),
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: solana_sdk::system_program::ID,
        }
        .to_account_metas(None),
        data: if buy {
            instruction::BuyClassic {
                tokens,
                max_lamports: 1_000_000_000,
                deadline_slot: 1000,
            }
            .data()
        } else {
            instruction::SellClassic {
                tokens,
                min_lamports: 1,
                deadline_slot: 1000,
            }
            .data()
        },
    };
    let cap = launch_core::classic::SUPPLY / 100;
    // Two independently signed buys cannot exceed the shared allowance in one transaction.
    let before = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(
        &[
            ix(alice.pubkey(), cap / 2, true),
            ix(bob.pubkey(), cap / 2 + 1, true),
        ],
        Some(&creator),
        &[&ctx.payer, &alice, &bob],
        hash,
    );
    assert!(ctx.banks_client.process_transaction(tx).await.is_err());
    assert_eq!(
        ctx.banks_client
            .get_account(launch)
            .await
            .unwrap()
            .unwrap()
            .data,
        before.data
    );
    send(&mut ctx, ix(alice.pubkey(), cap, true), &[&alice])
        .await
        .unwrap();
    assert!(send(&mut ctx, ix(bob.pubkey(), 1, true), &[&bob])
        .await
        .is_err());
    send(&mut ctx, ix(alice.pubkey(), cap, false), &[&alice])
        .await
        .unwrap();
    assert!(send(&mut ctx, ix(bob.pubkey(), 2, true), &[&bob])
        .await
        .is_err());
    let raw = ctx.banks_client.get_account(launch).await.unwrap().unwrap();
    assert_eq!(
        ClassicLaunch::try_deserialize(&mut raw.data.as_slice())
            .unwrap()
            .slot_bought,
        cap
    );
    ctx.warp_to_slot(21).unwrap();
    send(&mut ctx, ix(bob.pubkey(), cap, true), &[&bob])
        .await
        .unwrap();
    ctx.warp_to_slot(22).unwrap();
    assert!(send(&mut ctx, ix(alice.pubkey(), cap + 1, true), &[&alice])
        .await
        .is_err());
}
