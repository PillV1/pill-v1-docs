<p align="center">
  <img src="docs/assets/pill-v1.svg" width="88" alt="Pill V1" />
</p>

<h1 align="center">Pill V1</h1>
<p align="center"><strong>Old is gold. Bringing the early days home.</strong></p>
<p align="center"><a href="https://pillv1.fun">Website</a> · <a href="docs/README.md">Documentation</a> · <a href="https://x.com/PillV1dotfun">Official X</a></p>

Pill brings custom bonding curves, native Pump Holder Rewards and Pangea five-chain launches onto one community board. This repository contains the public project source and documentation.

## Launch routes

| Route | Launch and trading model | Learn more |
| --- | --- | --- |
| **Old School · Classic V1** | Pill's custom Solana curve with fixed rules; PumpSwap graduation. | [Launch guide](docs/launch-guide.md#choose-your-route) |
| **Old School · V1.1** | Custom curve with configurable features, custody and lock rules. | [Rules and fees](docs/launch-guide.md#fees-before-and-after-migration) |
| **New School** | Native Pump Holder Rewards, using Pump's native configuration. | [Pump integration](docs/integrations.md#new-school-native-pump-holder-rewards) |
| **onepill mode** | Standard five-chain launches through Pangea; Pill trading uses the Solana pool. | [Pangea integration](docs/integrations.md#onepill-mode-pangea) |

## Explore the code

| Directory | Contents |
| --- | --- |
| [programs/launchpad](programs/launchpad) | Anchor contracts, Classic/V1.1 trading, migration and settlement |
| [crates/launch-core](crates/launch-core) | Curve arithmetic, fee calculations and vesting |
| [sdk/src](sdk/src) | Account readers, quotes and instruction builders |
| [services/api](services/api) | Launch/trade APIs, native Pump and Pangea integrations |
| [services/indexer](services/indexer) | Chain ingestion, market projections and workflow state |
| [website](website) | Frontend, wallet signing, charts and route integration |
| [tests](tests) | JavaScript test sources; Rust and Python tests also live beside their modules |
| [docs](docs) | User guide, architecture, integrations and development notes |

## Documentation

- **[Start here](docs/README.md)** — choose the guide for your task.
- **[Launch guide](docs/launch-guide.md)** — fees, developer buys, locks, limits, milestones and migration.
- **[Architecture](docs/architecture.md)** — component responsibilities and source links.
- **[Integrations](docs/integrations.md)** — custom PumpSwap graduation, native Pump and Pangea.
- **[Development](docs/development.md)** — dependencies, local checks and fixture requirements.
- **[Source scope](docs/source-scope.md)** — publication checks and intentionally excluded operational files.

## Development

Requires Node.js 22.13+ for the backend and a Rust toolchain for the on-chain code. Dependency versions are pinned in the project manifests. See [development setup](docs/development.md) before running the integration tests.

```sh
pnpm install
cargo test -p launch-core
```

## Project status

This is a public source snapshot, not a verified build of the deployed binary or an independent security audit. The [launch guide](docs/launch-guide.md#operational-readiness) preserves dated operational-readiness notes. Some tests require separately obtained chain fixtures or locally built binaries; production configuration and secrets are excluded.

Pill is independent of Pump.fun. Pangea and Pump integrations depend on their respective providers. Third-party notices remain with their files; no first-party reuse license is granted by publication alone.
