//! Exercises the captured PumpSwap executable, not a mock AMM.
use anchor_spl::{associated_token, token, token_2022};
use base64::Engine;
use solana_program_test::{processor, ProgramTest};
use solana_sdk::{
    account::Account,
    compute_budget::ComputeBudgetInstruction,
    instruction::{AccountMeta, Instruction},
    program_pack::Pack,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
#[tokio::test]
async fn disabled_transfer_hook_mint_is_rejected_by_actual_pumpswap() {
    let pump = custom_launchpad::migration::PUMP_SWAP;
    let wsol = custom_launchpad::migration::WSOL;
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/external");
    let fixture: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("pumpswap-global.json")).unwrap()).unwrap();
    let mut pt = ProgramTest::default();
    pt.add_program(
        "spl_token",
        token::ID,
        processor!(token::spl_token::processor::Processor::process),
    );
    pt.add_program(
        "spl_associated_token_account",
        associated_token::ID,
        processor!(associated_token::spl_associated_token_account::processor::process_instruction),
    );
    pt.add_program(
        "spl_token_2022",
        token_2022::ID,
        processor!(token_2022::spl_token_2022::processor::Processor::process),
    );
    pt.add_account(
        pump,
        Account {
            lamports: 100_000_000,
            data: std::fs::read(root.join("pump_amm.so")).unwrap(),
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
            owner: pump,
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
        wsol,
        Account {
            lamports: 10_000_000,
            data: native_data,
            owner: token::ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut ctx = pt.start_with_context().await;
    let creator = ctx.payer.pubkey();
    let mint = Keypair::new();
    let m = mint.pubkey();
    use token_2022::spl_token_2022::{
        extension::{transfer_hook::instruction as hook, ExtensionType},
        instruction as ti,
        state::Mint,
    };
    let len =
        ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook]).unwrap();
    let rent = ctx.banks_client.get_rent().await.unwrap();
    let base = associated_token::get_associated_token_address_with_program_id(
        &creator,
        &m,
        &token_2022::ID,
    );
    let quote = associated_token::get_associated_token_address(&creator, &wsol);
    let make_ata = |owner: &Pubkey, mint: &Pubkey, program: &Pubkey| {
        associated_token::spl_associated_token_account::instruction::create_associated_token_account(
            &creator, owner, mint, program,
        )
    };
    let ixs = vec![
        solana_sdk::system_instruction::create_account(
            &creator,
            &m,
            rent.minimum_balance(len),
            len as u64,
            &token_2022::ID,
        ),
        hook::initialize(&token_2022::ID, &m, Some(creator), None).unwrap(),
        ti::initialize_mint2(&token_2022::ID, &m, &creator, None, 6).unwrap(),
        make_ata(&creator, &m, &token_2022::ID),
        make_ata(&creator, &wsol, &token::ID),
        ti::mint_to(
            &token_2022::ID,
            &m,
            &base,
            &creator,
            &[],
            1_000_000_000_000_000,
        )
        .unwrap(),
        solana_sdk::system_instruction::transfer(&creator, &quote, 85_000_000_000),
        token::spl_token::instruction::sync_native(&token::ID, &quote).unwrap(),
        ti::set_authority(
            &token_2022::ID,
            &m,
            None,
            ti::AuthorityType::MintTokens,
            &creator,
            &[],
        )
        .unwrap(),
        ti::set_authority(
            &token_2022::ID,
            &m,
            None,
            ti::AuthorityType::TransferHookProgramId,
            &creator,
            &[],
        )
        .unwrap(),
    ];
    let hash = ctx.banks_client.get_latest_blockhash().await.unwrap();
    ctx.banks_client
        .process_transaction(Transaction::new_signed_with_payer(
            &ixs,
            Some(&creator),
            &[&ctx.payer, &mint],
            hash,
        ))
        .await
        .unwrap();
    let pool = Pubkey::find_program_address(
        &[
            b"pool",
            &1u16.to_le_bytes(),
            creator.as_ref(),
            m.as_ref(),
            wsol.as_ref(),
        ],
        &pump,
    )
    .0;
    let lp = Pubkey::find_program_address(&[b"pool_lp_mint", pool.as_ref()], &pump).0;
    let lp_ata = associated_token::get_associated_token_address_with_program_id(
        &creator,
        &lp,
        &token_2022::ID,
    );
    let pool_base =
        associated_token::get_associated_token_address_with_program_id(&pool, &m, &token_2022::ID);
    let pool_quote = associated_token::get_associated_token_address(&pool, &wsol);
    let event = Pubkey::find_program_address(&[b"__event_authority"], &pump).0;
    let keys = [
        pool,
        global,
        creator,
        m,
        wsol,
        lp,
        base,
        quote,
        lp_ata,
        pool_base,
        pool_quote,
        solana_sdk::system_program::ID,
        token_2022::ID,
        token_2022::ID,
        token::ID,
        associated_token::ID,
        event,
        pump,
    ];
    let writes = [
        true, false, true, false, false, true, true, true, true, true, true, false, false, false,
        false, false, false, false,
    ];
    let accounts = keys
        .into_iter()
        .enumerate()
        .map(|(i, k)| {
            if writes[i] {
                AccountMeta::new(k, i == 2)
            } else {
                AccountMeta::new_readonly(k, i == 2)
            }
        })
        .collect();
    let mut data = vec![233, 146, 209, 142, 207, 104, 64, 188];
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&200_000_000_000_000u64.to_le_bytes());
    data.extend_from_slice(&85_000_000_000u64.to_le_bytes());
    data.extend_from_slice(Pubkey::default().as_ref());
    data.extend_from_slice(&[0, 0]);
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(0);
    let tx = Transaction::new_signed_with_payer(
        &[
            ComputeBudgetInstruction::set_compute_unit_limit(1_400_000),
            make_ata(&pool, &m, &token_2022::ID),
            make_ata(&pool, &wsol, &token::ID),
            Instruction {
                program_id: pump,
                accounts,
                data,
            },
        ],
        Some(&creator),
        &[&ctx.payer],
        hash,
    );
    let error = ctx
        .banks_client
        .process_transaction(tx)
        .await
        .expect_err("acceptance would invalidate the documented token-architecture constraint");
    assert!(
        format!("{error:?}").contains("Custom(6006)"),
        "unexpected failure: {error:?}"
    );
    assert!(ctx.banks_client.get_account(pool).await.unwrap().is_none());
}
