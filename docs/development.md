# Development and testing

## Requirements

- Node.js 22.13 or later (the backend uses `node:sqlite`).
- pnpm matching `packageManager` in [package.json](../package.json).
- Rust/Cargo for shared arithmetic tests.
- Anchor 0.31.1 and compatible Solana build tools for program builds.

## Backend and SDK dependencies

From the repository root:

```sh
pnpm install
```

## Shared contract arithmetic

```sh
cargo test -p launch-core
```

This targets the shared fee/curve/vesting crate. Rust tests were not rerun during the publication task because its local Rust toolchain was unavailable.

## JavaScript tests

```sh
node --test tests/*.test.mjs
```

The repository includes test source, but the full suite is not self-contained. Several integration tests require compiled programs, captured public chain accounts and independently generated test fixtures. Those files are not shipped with this publication. See imports and fixture paths in each test before running it; do not use production signing keys as fixtures.

## Website

The website has its own dependency manifest:

```sh
cd website
npm install
npm run build
```

`build.mjs` bundles browser modules from `src`. The main application and styling are maintained in `dist/app.js`, `dist/classic.css` and `dist/style.css`. Production configuration and assets are excluded from this source snapshot; provide local configuration/assets before serving it. The edge origin is an invalid example hostname by design.

## Operational configuration

The backend reads its configuration through `LAUNCHPAD_CONFIG` and RPC connection through `LAUNCHPAD_RPC_URL`. Provider credentials and signer material must be provisioned privately. Live deployment files, signing keys, mint inventories, databases and transaction records are deliberately excluded. This repository is not a production deployment export.

## Verification boundaries

Inspecting source is different from verifying a deployed binary, enabling a keeper or establishing production migration timing. Experimental modules may exist without being enabled. Keep dated evidence and current readiness separate. See [source scope](source-scope.md) and [operational readiness](launch-guide.md#operational-readiness).
