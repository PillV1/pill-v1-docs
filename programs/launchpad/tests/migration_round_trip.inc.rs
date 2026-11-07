// Local-bank rehearsal against the captured PumpSwap ELF and its published v2 ABI.
async fn token_balance(ctx: &mut ProgramTestContext, address: Pubkey) -> u64 {
    use solana_sdk::program_pack::Pack;
    let account = ctx.banks_client.get_account(address).await.unwrap().unwrap();
    token::spl_token::state::Account::unpack(&account.data).unwrap().amount
}

async fn pumpswap_round_trip(ctx: &mut ProgramTestContext, pool: Pubkey, mint: Pubkey, holder: &Keypair) {
    use base64::Engine;
    use custom_launchpad::migration::{PUMP_SWAP, WSOL};
    use solana_sdk::{instruction::AccountMeta, program_pack::Pack};
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../artifacts/external");
    let fixture: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("pumpswap-global.json")).unwrap()).unwrap();
    let global: Pubkey = fixture["address"].as_str().unwrap().parse().unwrap();
    let global_bytes = base64::engine::general_purpose::STANDARD.decode(fixture["dataBase64"].as_str().unwrap()).unwrap();
    let recipient = Pubkey::new_from_array(global_bytes[643..675].try_into().unwrap());
    let buyback = associated_token::get_associated_token_address(&recipient, &WSOL);
    let fees: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("pumpswap-fees.json")).unwrap()).unwrap();
    let fee_key: Pubkey = "5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx".parse().unwrap();
    let f = &fees["result"]["value"];
    ctx.set_account(&fee_key, &Account { lamports: f["lamports"].as_u64().unwrap(), data: base64::engine::general_purpose::STANDARD.decode(f["data"][0].as_str().unwrap()).unwrap(), owner: f["owner"].as_str().unwrap().parse().unwrap(), executable: false, rent_epoch: 0 }.into());
    if ctx.banks_client.get_account(buyback).await.unwrap().is_none() {
        let mut data = vec![0; token::spl_token::state::Account::LEN];
        token::spl_token::state::Account::pack(token::spl_token::state::Account {
            mint: WSOL, owner: recipient, amount: 0, delegate: solana_sdk::program_option::COption::None,
            state: token::spl_token::state::AccountState::Initialized, is_native: solana_sdk::program_option::COption::Some(2_039_280),
            delegated_amount: 0, close_authority: solana_sdk::program_option::COption::None,
        }, &mut data).unwrap();
        ctx.set_account(&buyback, &Account { lamports: 2_039_280, data, owner: token::ID, executable: false, rent_epoch: 0 }.into());
    }
    let user = holder.pubkey();
    let base = associated_token::get_associated_token_address(&user, &mint);
    let quote = associated_token::get_associated_token_address(&user, &WSOL);
    let payer = ctx.payer.pubkey();
    send(ctx, associated_token::spl_associated_token_account::instruction::create_associated_token_account_idempotent(&payer, &user, &WSOL, &token::ID), &[]).await.unwrap();
    let pool_base = associated_token::get_associated_token_address(&pool, &mint);
    let pool_quote = associated_token::get_associated_token_address(&pool, &WSOL);
    let volume = Pubkey::find_program_address(&[b"user_volume_accumulator", user.as_ref()], &PUMP_SWAP).0;
    let event = Pubkey::find_program_address(&[b"__event_authority"], &PUMP_SWAP).0;
    let keys = [pool,user,global,mint,WSOL,base,quote,pool_base,pool_quote,token::ID,token::ID,solana_sdk::system_program::ID,volume,fee_key,buyback,event,PUMP_SWAP];
    let instruction = |discriminator: [u8;8], amount: u64, minimum: u64| {
        let mut data = discriminator.to_vec(); data.extend(amount.to_le_bytes()); data.extend(minimum.to_le_bytes());
        Instruction { program_id: PUMP_SWAP, accounts: keys.iter().enumerate().map(|(i,key)| {
            if [0,1,5,6,7,8,12,14].contains(&i) { AccountMeta::new(*key,i==1) } else { AccountMeta::new_readonly(*key,i==1) }
        }).collect(), data }
    };
    let initial = token_balance(ctx,base).await;
    let sell_amount = initial.min(1_000_000_000);
    assert!(sell_amount > 0);
    let before_quote = token_balance(ctx,quote).await;
    let before_pool_quote = token_balance(ctx,pool_quote).await;
    // Unachievable slippage must not consume the holder's tokens.
    assert!(send_independent(ctx,instruction([93,246,130,60,231,233,64,178],sell_amount,u64::MAX),holder).await.is_err());
    assert_eq!(token_balance(ctx,base).await,initial);
    send_independent(ctx,instruction([93,246,130,60,231,233,64,178],sell_amount,1),holder).await.unwrap();
    assert_eq!(token_balance(ctx,base).await,initial-sell_amount);
    let proceeds = token_balance(ctx,quote).await-before_quote;
    assert!(proceeds > 0);
    assert!(token_balance(ctx,pool_quote).await < before_pool_quote);
    // Spend only the actual sell proceeds, proving a usable two-way market.
    send_independent(ctx,instruction([194,171,28,70,104,77,91,47],proceeds,1),holder).await.unwrap();
    let final_base = token_balance(ctx,base).await;
    assert!(final_base > initial-sell_amount);
    assert!(final_base < initial, "round trip must pay pool trading fees");
    assert_eq!(token_balance(ctx,quote).await,before_quote);
}
