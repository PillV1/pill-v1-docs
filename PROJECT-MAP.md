# Pill V1 project map

The [public source snapshot](pill-v1-source.zip) includes contracts, SDK, backend/indexer, frontend and tests. Extract it to browse the paths below. This is Pill integration code, not a redistribution of Pangea or Pump's entire protocol.

| Component | Source path in archive | Responsibility |
| --- | --- | --- |
| Custom Anchor program | `programs/launchpad/src/lib.rs` | Program instructions, accounts and route rules |
| Classic V1 | `programs/launchpad/src/classic.rs` | Classic curve buys, sells and fees |
| Classic migration | `programs/launchpad/src/classic_migration.rs` | Graduation into PumpSwap |
| V1.1 migration | `programs/launchpad/src/migration.rs` | Migration with custody/settlement accounting |
| Graduation costs | `programs/launchpad/src/graduation_costs.rs` | Bounded setup costs and reserve accounting |
| Feature modules | `creator_features.rs`, `social_rewards.rs`, `settlement.rs` in the program | Creator rules, reward accounting and settlement |
| Core arithmetic | `crates/launch-core/src/` | Curve calculations, fee arithmetic and vesting |
| Client SDK | `sdk/src/` | Quotes, account decoding and unsigned instructions |
| Pump native route | `services/api/native-pump.mjs`, `website/src/native-pump.mjs` | Native Holder Rewards launches and trading |
| Pangea launch route | `services/api/onepill.mjs` | Standard five-chain launch validation and status |
| Pangea authorization | `services/api/onepill-proof.mjs` | Signed proof and payment validation |
| Pangea markets | `services/api/onepill-market.mjs`, `website/src/onepill-market.mjs` | Solana market data |
| Pangea trading | `website/src/onepill-trade.mjs`, `website/pangea-proxy.mjs` | Solana buy/sell requests and wallet signing |
| Chain indexing | `services/indexer/` | Events, projections, market history and workflow state |
| Community | `services/api/community.mjs`, `profiles.mjs`, `social.mjs` | Threads, profiles and social features |
| Wallet transaction handling | `website/src/wallet-response.mjs`, `wallet.mjs` | Wallet responses and transaction handling |
| Main interface | `website/dist/app.js`, `classic.css` | Board, coin pages and classic styling |

## What publication establishes

These are inspectable source files from the working project, packaged on 7 November 2026. Inclusion of a module does not mean every feature is enabled in production. A source snapshot alone does not prove that a deployed binary matches it or that a migration service is running. See the dated [launch guide](LAUNCH-GUIDE.md) for behavior and readiness notes.

## Running locally

The archive README explains dependencies and exclusions. It is a review snapshot, not a live deployment export. Runtime fixtures, binaries, configuration and private assets are deliberately excluded; fixture-dependent integration tests need independent test setup. No production deployment or funded transaction is performed by publishing this snapshot.
