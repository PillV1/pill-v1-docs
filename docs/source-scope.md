# Public source scope

Prepared 7 November 2026 from a separate staging directory. The production project was not modified.

## Included

Custom contracts and shared arithmetic, SDK, API/indexer modules, frontend source and test sources. Files are published directly in Git so their changes can be inspected in commit history.

## Excluded

- Wallet/private keys, signing seeds and mint-reserve inventory
- API credentials, OAuth secrets and environment files
- Production deployment configuration, server addresses and infrastructure runbooks
- Databases, user/session records, logs, backups and signed transaction captures
- Compiled binaries, dependencies and private test fixtures
- Repository history and unrelated workspace files

The edge origin is replaced with an invalid example hostname. The website build resolves esbuild from its installed dependencies rather than a private sibling project. Public program identifiers and public provider URLs remain where needed to understand the code; they are not private keys.

## Checks and limits

The selected text files were checked for private-key headers, common credential token formats, secret-like literals, numeric key arrays, long encoded literals, private local paths and infrastructure addresses. Flagged values were reviewed as test placeholders or loopback/documentation addresses. No credential values were found in the selected files by these checks. This is a publication screening, not a security audit or proof that the contracts are vulnerability-free.

Rust tests were not rerun for this publication because the local Rust toolchain was unavailable. Fixture-dependent tests require separate test setup. Historical validation statements remain dated in the launch guide.

Publication does not grant a reuse license for first-party code. Third-party notices remain with their files.
