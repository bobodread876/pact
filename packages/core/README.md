# pact-core

The agent-relationship runtime engine: Nostr-native identities, bond assembly/signing (NIP-BD kinds 30317/1317), and publish/resolve over relays. Used by all other Pact packages (`pact-mcp`, the SDK, the daemon, the CLI).

## L1 dependency

Identity, canonicalization, bond signing, and transport come from the L1 protocol package **[`@mate-protocol/core`](https://www.npmjs.com/package/@mate-protocol/core)** (see `package.json` for the supported range). This package re-exports those and adds the L2 runtime helpers on top. The dependency points one way only — Pact depends on MATE.md; MATE.md never depends on Pact (see `../../ARCHITECTURE.md` §13).

*(Earlier MVP builds vendored a port of the L1 mechanism; that was replaced with this real dependency once `@mate-protocol/core` was published to npm.)*

## API

- `generateNostrKeypair()` / `keypairFromSecret()` / `secretFromNsec()` — identity
- `makeBondDocument()` — assemble a bond document
- `formBond(secret, { counterparty, bondId, state, kind, relays, history })` — assemble + sign + publish
- `listBonds(filter, relays)` — resolve + verify bonds from relays (latest per author + bond id)
- `verifyBond(bondId, relays, { secret?, parties? })` — the mutual verdict (`findMutualPair`: two parties whose latest valid sides name each other, both still consenting, at least one accepted). With `secret`, `inboxTruncated: true` reports a private inbox that could not be read to the end (a flood, a relay that stopped answering mid-read); `mutual` is then forced false only for a bond the secret's key is a party to
- `acceptBond(secret, { bondId, …, allowIncompleteInbox? })` — refuses (`PactError` `conflict`, "inbox incomplete") on a partially-read private inbox; `allowIncompleteInbox: true` is the deliberate operator override that accepts on the partial history
- `reaffirmBond` (conflict "inbox incomplete" when its lookup reads a partial inbox — pass both `counterparty` and `visibility` to skip the lookup), `listReaffirmations` (`truncated` on a partial inbox), `listPrivateBonds` / `fetchInbox` (`truncated`), `publishIntent` / `discover`
- `BOND_STATES` / `isBondState` — the legal states every surface validates against
- low-level: `buildBondStateEvent`, `verifyEvent`, `publishEvent`, `resolveEvents`
