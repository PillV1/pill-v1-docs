# Pill V1 launch guide

Updated 6 November 2026.

Pill offers three launch routes: Old School, New School and onepill mode. They appear on the same Pill board but use different contracts, fees and trading rules. Choosing a route does not change an existing token's contract.

## Choose your route

| | Old School | New School |
|---|---|---|
| Launch options | Stealth Classic V1; Stealth V1.1 | Native Pump Holder Rewards only |
| Before migration | Pill's custom bonding curve | Pump's native SOL bonding curve |
| Where to trade before migration | Pill's coin page | Pill's coin page or providers that support this native Pump mode |
| After migration | PumpSwap, same mint | PumpSwap through Pump's native migration, same mint |
| Rules | Classic fixed rules, or V1.1 selected rules | Native Pump rules; no Pill V1.1 controls |
| Creator-fee recipient | According to the Old School contract | Pump's holder-rewards destination |
| Pill board and discussions | Yes | Yes, for verified launches created through Pill |

“Stealth” means Pill-first trading. Mints, transactions and balances remain public on Solana. A bot recognizing a mint does not prove that it can quote or trade it. Trojan support for Pill's custom curve is not verified.

## onepill mode · powered by Pangea

Launch one coin with the same name, ticker and image across **Ethereum, Base, BNB Chain, Robinhood Chain and Solana**. Pill is the interface; Pangea performs the five-chain launch. Each chain has its own token contract and pool. Matching names do not mean balances or prices are automatically identical across chains.

This route uses Pangea's **standard native-coin pairs with a fixed 1% pool trading fee on each chain**. Stock pairs and special tokenomics modes are not offered through Pill. The 1% is not an additional Pill 2.2% fee. Creator-fee recipients are the connected creator wallets; the pool fee is not a promise that the creator receives the entire 1%.

### Launching through Pangea

1. Choose **onepill mode** on the launch page.
2. Enter a name, ticker and description. Upload a PNG, JPG or WebP image up to 4 MB. The image and metadata are published to public IPFS for the launch.
3. Connect a Solana wallet and an EVM wallet. Confirm ownership of the wallets when requested.
4. Review Pangea's live launch quote. Launch payment is **ETH on Base**, separate from trading fees and wallet network costs.
5. Approve payment in the EVM wallet. Pangea then processes each chain. A payment approval alone does not mean all five pools are live.
6. Use **my OnePill launches** to check progress or resume an interrupted submission. If payment status is uncertain, check the existing launch instead of paying again.

The website lists completed, verified five-chain launches routed through Pill. It does not list every Pangea launch. The piLL mint suffix applies to Pill-generated Solana launches, **not to Pangea-generated contracts**.

### Trading and charts

On Pill, the onepill coin page displays the **Solana market** and offers **Solana buys and sells** through the connected Solana wallet. Its chart, trade amounts, market cap and holder distribution describe that Solana token, not an aggregate of five chains. Quote availability depends on the provider and pool; a visible token is not itself proof that a trade can execute.

The Sell tab reads your Solana token balance and offers 25%, 50% and 100% shortcuts. Amounts use the mint’s actual decimal precision. After a website trade, an on-chain confirmed receipt can appear before Pangea indexes it; it is marked confirmed and merged with the provider row when available. The chart and other visitors still depend on the public provider feed.

All five contract addresses are expanded by default and can be copied individually. For trading on another chain, use Pangea or a provider supporting that chain and pool. Pill's V1.1 locks, taxes and wallet restrictions do not apply to onepill mode. There is **no Pill bonding curve or PumpSwap graduation** in this route.

The board label shows **onepill mode**, **5 chains**, and the chain names. Profiles, discussions, the trades table and the shared coin-page layout remain available.

Pangea: https://www.pangea.trade

## What Holder Rewards means

Pump's current new-launch mode is **Holder Rewards**, not cashback. Creator fees are allocated to holders and distributed by Pump's authorized distribution mechanism. There is no holder claim instruction on Pill for these native rewards. Pill does not control the allocation schedule, recipient selection or payment timing, and does not promise a fixed yield or payment to every holder.

Legacy cashback rewards the buyer. Pump's current creation instruction rejects new cashback coins; existing cashback coins can still trade. Pill's New School creation path explicitly selects Holder Rewards and disables cashback and Mayhem. It does not silently create a regular Pump coin if Holder Rewards is unavailable.

Pump can disable Holder Rewards creation globally. Pill checks the live configuration before preparing a launch and checks again before building the creation transaction. If disabled, creation stops before wallet approval.

## Fees before and after migration

### Old School · Stealth Classic V1

Before migration, each buy and sell pays a **2.2% platform fee** to the configured Pill treasury. The fee is 2.2% of the curve principal; a 1 SOL total buy budget includes approximately 0.021526 SOL in platform fees before slippage, with network/account costs additional. A sell's proceeds depend on the curve quote and fee; buying and selling the same tokens does not guarantee the original SOL back.

Classic website buys, sells and optional initial buys include automatic treasury collection in the same transaction. The collection pays only the treasury fixed in the contract, clears accrued platform fees, and requires no separate claim or wallet approval. Existing uncollected Classic fees are swept with the next successful website trade. This is transaction-triggered collection, not a background sweep of idle coins or trades made through other clients.

After migration, the pool uses PumpSwap's **non-canonical pool fee schedule**. At this guide's date, that is **0.30% per trade: 0.25% LP fee and 0.05% protocol fee**, with no native creator fee. LP fees accrue in pool liquidity; they are not a 0.25% transfer to Pill's treasury. The old 2.2% curve fee does not continue on PumpSwap. Pump may change its native schedule.

### Old School · Stealth V1.1

Normal pre-migration trading fees are **2.5% total: 2.2% platform plus 0.3% for the selected feature**. The randomized opening-protection period has a distinct 99% tax; this is not the normal fee. The treasury portion remains 2.2%, with the remainder funding burns under the contract. Read the selected rules and transaction quote before buying.

After migration, the same native non-canonical PumpSwap schedule described above applies. Pill's custom wallet restrictions and opening tax do not carry over to every external PumpSwap trade.

### New School · native Pump Holder Rewards

Pump's native fee schedule applies before migration and its canonical PumpSwap schedule applies afterward. Rates can depend on the native fee configuration and market-cap tier. The launch page therefore does not mislabel this route with Pill's 2.2% fee or the 0.30% non-canonical pool rate. Quotes use the official Pump SDK and live configuration. Phantom shows the transaction being approved.

Creator fees fund Pump's holder-rewards destination. **Pill adds no separate 2.2% platform fee to this route, and these native creator fees are not Pill revenue.** Network fees, rent/account creation and any initial buy are paid by the launching wallet. Native migration costs and mechanics are controlled by Pump.

Official current schedule: https://pump.fun/docs/fees

## Launching and the optional developer buy

For Old School and New School (Pangea has its own steps above):

1. Select Old School or New School. Old School has separate Classic and V1.1 options.
2. Add the coin name, ticker, image and description. Images and metadata are published by Pill; review them before launch.
3. Connect your Solana wallet. An initial buy is optional; enter zero to create without buying.
4. Review the generated mint and number of wallet approvals. New mints generated by Pill end in **piLL**, exactly with that capitalization.
5. Approve the transaction in your wallet. Pill records the signed transaction before submitting it and waits for finalized confirmation.
6. For New School, the backend verifies the native Pump creation event, creator wallet, token program, SOL quote and Holder Rewards flag before listing it. A submitted or failed transaction is not a launched coin.

A native creation plus initial buy is combined when it fits Solana's transaction-size limit. Larger metadata can require **two approvals**: create first, then buy. The coin exists after creation even if the separate buy is rejected or fails. Others may trade before that buy, and its price can change. The status page lets you finish the remaining step without creating the coin again. The initial-buy budget limits trading spend; account/network costs are additional.

If submission or confirmation is uncertain, keep the saved signature and use **Check transaction**. Do not create a second coin as a retry. If creation finalized but registration was interrupted, reconnect the original wallet and check the saved launch status to finish registration.

## Per-wallet launch and upload limits

| Action | Current limit | What counts |
|---|---|---|
| Old School and New School piLL address reservations | 3 per wallet in a rolling 24 hours, shared across both routes | Each new address reservation, even if the launch is cancelled or never completed |
| onepill mode launch quotes | 6 per wallet in a rolling hour | New launch quote records, not only successfully completed launches |
| Standard Pill image uploads | 10 per wallet in a rolling 24 hours | Upload attempts reserved by the standard media service; this is separate from Pangea's image-upload flow |

These are rolling windows, not midnight resets. A reservation stops counting once it is more than 24 hours old. Retrying the same saved reservation request does not consume another address reservation, but starting a new request can. A reserved address is never reassigned after cancellation.

The three-reservation limit is **not a limit of three successful launches**: cancelling after an address is reserved still uses a slot. The onepill quote limit is an hourly preparation limit, not a stated daily successful-launch cap. Network fees and provider requirements still apply separately.

## The piLL mint suffix

`piLL` is part of the actual token mint address, not a display alias. It does not rename the launchpad program or change existing coins. Solana Base58 excludes lowercase `l`, so lowercase `pill` is impossible.

Pill prepares matching mint keys in advance using a background service targeting 128 unused addresses. This is a refill target, not a guarantee that 128 are always available; a burst of launches can exhaust the current stock. Unused keys are encrypted on the server; an authenticated wallet reserves an address once, and the browser validates the key and suffix before preparing the launch. Reserved addresses are never reassigned, including after cancellation. Mint keys are kept in browser memory only, and wallet private keys remain in the wallet. If the reserve is empty, the form reports that it is refilling instead of starting a long search on your device. An unsigned draft cannot be resumed after reloading; already-signed transactions retain their recovery record.

## Trading, balances and charts

Old School uses Pill's custom trade instructions. New School uses the official native Pump instructions, with Token-2022 balances and Holder Rewards checks. Amounts are handled in integer base units. Confirm the quote, input, minimum output and slippage before signing. Native in-page curve quotes accept up to 10% slippage.

The coin page shows finalized buys and sells, candles, wallet profiles, holder data and discussions. A chart with only one trade can show only one real candle. Market-cap displays use supply and the current SOL/USD quote; USD values change with SOL. Missing data is not filled with fictional trades.

After confirmed migration, the current trade action directs users to PumpSwap; it does not pretend that the old curve remains active. Post-migration trade indexing continues for registered pools. Token recognition and trading support on Axiom, GMGN, Trojan or any other provider depend on that provider. Native Pump compatibility is not a guarantee of a search result or listing on every terminal.

## King of the Hill and bump order

For Old School and New School, Pill's milestone is **85% of the coin's initial curve sale allocation sold**, not whichever coin currently has the largest market cap. The latest first-time qualifying coin becomes the current king. Previously crowned coins keep their crown and recorded qualification time. This is Pill's board milestone, not a promise of a Pump homepage placement or an external listing.

For New School, the initial sale allocation comes from the verified Pump creation event, and progress comes from finalized native trade reserves. The milestone is not a fixed USD amount. Migration remains Pump's own rule.

Finalized buys **and sells** update bump order. Failed transactions do not bump a coin. New School tracking polls only registered Pill launches, with bounded background processing and backlog recovery. It does not scan all Pump coins. Heavy activity or RPC delays can delay the board; a visible quote is not a promise of instant indexing.

For **onepill mode**, the crown milestone is **45 SOL actually held in the verified Solana pool**, not 45 SOL market cap, cumulative volume or a five-chain total. The progress bar follows the pool reserve. Previously earned crowns retain their recorded qualification; reaching this board milestone does not migrate the pool.

## Browsing and live updates

Coin links use **/coin/<Solana mint address>**, including onepill mode. Older hash links continue to resolve. Browser Back and Forward return through visited pages.

The board uses 48 coins per page and a bracketed pager with up to five numbers visible, such as **[1 2 3 4 5]**. The range shifts as you move through pages. Search, sort direction and the graduated-coins filter control the board results.

Charts default to **15 minutes**; users can change the interval. Market-cap labels are shown in USD when a current SOL/USD quote is available. Native Pump coins show bonding-curve progress and distinguish a completed curve from confirmed migration.

Trade rows link wallet profiles and transaction records. Profiles support a display name and image, and coin discussions support messages and images. A shortened wallet name is a display label; always check the full address when identifying a wallet.

The header rotates recent activity every 4 seconds and requests fresh activity every 2 seconds. Rotation pauses on hover or focus. Active Old School and New School charts and the open trades list refresh every second, including during trade review; the board and onepill market refresh every 2 seconds. Concurrent requests are bounded and public responses are shared through short caches. These are indexed updates, not an instant execution feed: confirmation, RPC and provider delays can affect how soon external trades appear. A 1–2 second end-to-end update time is not currently guaranteed.

## Migration and liquidity

Old School's custom graduation transfers liquidity to PumpSwap and burns the LP tokens received by the launch contract. Setup costs come from curve funds, subject to the existing contract cap. Pill does not promise the same custom graduation budget or LP procedure for native Pump launches.

New School follows Pump's native migration and pool rules. Pill marks migration only after the expected canonical PumpSwap pool exists on chain. Completing a curve and finishing migration are distinct states; trading may pause between them.

Classic tokens remain in holders' wallets through migration under the same mint. V1.1 can use custody, locks and claims; do not assume every V1.1 balance is automatically delivered to a wallet at migration. Eligibility depends on that launch's rules. No fixed live migration completion time is guaranteed.

## Developer locks and Quick Mode

Read the warning and unlock status for the specific coin before launching or buying. The current launch form describes a **24-hour developer-purchase lock** for V1.1 and a **one-hour selling lock after activation** for Quick Mode. Developer purchases have their separate lock, and further purchases can extend it. Timed unlocks do not require migration. Earlier launches can have different deployed rules; a website change does not retroactively rewrite a coin's contract. The verified on-chain settings and trade quote take precedence over a general guide.

## Community, rewards and restrictions

Coin discussions and wallet profiles are Pill features. V1.1 rule labels describe verified settings. Native Holder Rewards coins do not inherit Pill's wallet cap, blocklist, shared per-slot cap, randomized opening tax, raider reward mode or developer vesting. Those controls must not be advertised on New School coins.

Old School holder/raider rewards and native Pump Holder Rewards are separate systems. The statistics page's Old School holder-distribution total does not claim to include Pump's off-site distributions.

## Operational readiness

Public access does not mean every automated workflow has been cleared for a large launch. Live custom migration automation was last verified disabled; automatic migration and V1.1 holder delivery still require production verification. Do not rely on an unattended migration until operational readiness is confirmed. This is separate from Pump's native migration and Pangea's launch service.

Public-read load tests do not establish capacity for thousands of simultaneous wallet trades. Each route's launch, buy, sell and recovery behavior must be checked separately. Quotes can expire, wallet approvals can be rejected and providers can be unavailable; review the visible transaction status before retrying.

## Verification and limits

The integration uses official Pump SDK 4.3.1. Read-only mainnet simulations on 6 November 2026 succeeded for creation without a buy, creation with an initial buy, and a create → buy → sell sequence. No funds were spent or real coin created by those simulations.

Automated tests cover holder-only flags, disabled-mode rejection, event provenance, authenticated registration, duplicate protection, trading history and crown persistence. Simulations and tests are not a security audit or a guarantee of flawless operation at thousands of concurrent users. A user-signed launch and its finalized appearance on Pill remain the end-to-end production check.

## Primary references

- Pump Holder Rewards specification: https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md
- Pump fee schedule: https://pump.fun/docs/fees
- Official SDK: https://www.npmjs.com/package/@pump-fun/pump-sdk
