# Launch routes and integrations

## Old School: Classic V1 and V1.1

Both use Pill's custom Solana program before graduation. Classic uses fixed rules; V1.1 adds configured features, custody and lock rules. The program, SDK and frontend must agree on amounts, fees, accounts and signing. The read API is a projection of chain activity, not the authority over balances.

Classic charges 2.2% of curve principal before migration. V1.1 normal trading is 2.5%: 2.2% platform plus 0.3% selected feature; opening protection has different rules. Read the launch guide before trading.

## PumpSwap graduation

The custom program creates a compatible SPL-token/SOL pool and burns the received LP tokens. Wallet-held Classic tokens keep the same mint. V1.1 custody, claims and developer locks must be handled according to the coin's rules. Existing fee liabilities are separate from pool liquidity. PumpSwap fees apply after graduation; the custom curve fee does not continue as an extra PumpSwap fee.

Code: [programs/launchpad/src/classic_migration.rs](../programs/launchpad/src/classic_migration.rs), `migration.rs`, `graduation_costs.rs`, `settlement.rs`, and [sdk/src/pool-settlement.mjs](../sdk/src/pool-settlement.mjs).

Pill-first discovery is not on-chain secrecy or a guarantee that direct program calls and bots are impossible. Terminal visibility depends on provider integration. Live migration readiness is separate from having migration code; see the launch guide's readiness section.

## New School: native Pump Holder Rewards

Pill uses the official Pump SDK and checks native configuration to prepare Holder Rewards launches. This is separate from Classic and V1.1. Native Pump fees and migration mechanics apply, with no extra Pill 2.2% curve fee. Pump controls reward eligibility and distribution. The route stops if the required native creation mode is disabled.

Code: [services/api/native-pump.mjs](../services/api/native-pump.mjs) and [website/src/native-pump.mjs](../website/src/native-pump.mjs).

## onepill mode: Pangea

Pill is the interface and tracking layer for Pangea's standard five-chain launch: Ethereum, Base, BNB Chain, Robinhood Chain and Solana. The name/ticker is shared; each chain has its own contract and pool, so prices and liquidity can differ. Pill's trading interface uses the Solana pool.

The integration restricts launches to standard native-coin pairs at a fixed 1% pool trading fee. It validates launch parameters, signed proofs, payment details and completed launch results before listing. The 1% is a pool fee, not a promise that all of it goes to Pill or the creator. It does not add Pill's custom 2.2% curve fee. Pangea launches do not follow Pill's custom curve-to-PumpSwap graduation.

Image metadata uses IPFS. Upload credentials stay server-side and are not part of this public source tree. Pangea's APIs and deployed contracts are external dependencies.

Code: [services/api/onepill.mjs](../services/api/onepill.mjs), `onepill-proof.mjs`, `onepill-market.mjs`, [website/src/onepill-trade.mjs](../website/src/onepill-trade.mjs) and [website/pangea-proxy.mjs](../website/pangea-proxy.mjs).

For fees, limits, launch flow, crown milestones and operational status, read [LAUNCH-GUIDE.md](launch-guide.md). This document describes the packaged implementation, not fresh verification of external providers.
