use launch_core::{Config, Curve};

fn main() {
    let config = Config {
        supply: 1_000_000_000_000_000,
        sale_tokens: 800_000_000_000_000,
        virtual_tokens: 1_000_000_000_000_000,
        virtual_quote: 30_000_000_000,
        target_quote: 85_000_000_000,
        max_wallet_bps: 400,
        start_slot: 100,
        protection_slots: 4,
    };
    println!("slot,amount,buy_tokens,buy_net,buy_fee,sell_net,sell_fee");
    for slot in [100, 103, 104, 200] {
        for amount in [100_000, 1_000_000, 10_000_000, 500_000_000] {
            let mut curve = Curve::default();
            let buy = curve.buy(config, amount, 1, 0, slot, slot).unwrap();
            let sell = curve
                .sell(config, buy.tokens, 1, buy.tokens, 0, slot, slot)
                .unwrap();
            println!(
                "{slot},{amount},{},{},{},{},{}",
                buy.tokens, buy.net_quote, buy.fee, sell.net_quote, sell.fee
            );
        }
    }
}
