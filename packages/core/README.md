# pact-core

The agent-relationship runtime engine: Nostr-native identities, bond assembly/signing (NIP-BD kinds 30317/1317), and publish/resolve over relays. Used by all other Pact packages (`pact-mcp`, the SDK, the daemon, the CLI).

## L1 dependency

Identity, canonicalization, bond signing, and transport come from the L1 protocol package **[`@mate-protocol/core`](https://www.npmjs.com/package/@mate-protocol/core)** (see `package.json` for the supported range). This package re-exports those and adds the L2 runtime helpers on top. The dependency points one way only — Pact depends on MATE.md; MATE.md never depends on Pact (see `../../ARCHITECTURE.md` §13).

*(Earlier MVP builds vendored a port of the L1 mechanism; that was replaced with this real dependency once `@mate-protocol/core` was published to npm.)*

## API

- `generateNostrKeypair()` / `keypairFromSecret()` / `secretFromNsec()` — identity
- `makeBondDocument()` — assemble a bond document
- `formBond(secret, { counterparty, bondId, state, kind, relays, history })` — assemble + sign + publish. The first write to an existing `bondId` per (author, bond) in a process waits for the wall clock to leave the current second (up to 1 s), so it stamps strictly after anything an earlier process wrote; a bond id the call generates itself skips that wait.
- `listBonds(filter, relays)` — resolve + verify bonds from relays (latest per author + bond id)
- `verifyBond(bondId, relays, { secret?, parties? })` — the mutual verdict (`findMutualPair`: two parties whose latest valid sides name each other, both still consenting, at least one accepted). With `secret`, `inboxTruncated: true` reports a private inbox that could not be read to the end (a flood, a relay that stopped answering mid-read); `mutual` is then forced false only for a bond the secret's key is a party to. `inboxRelaysUnread` names relays that were asked for the private inbox but never served it (down, or NIP-42 auth-required like relay.damus.io); if no relay served it the read counts as incomplete.
- `acceptBond(secret, { bondId, …, allowIncompleteInbox? })` — refuses (`PactError` `conflict`, "inbox incomplete") on a partially-read private inbox; `allowIncompleteInbox: true` is the deliberate operator override that accepts on the partial history
- `reaffirmBond` (conflict "inbox incomplete" when its lookup reads a partial inbox — pass both `counterparty` and `visibility` to skip the lookup), `listReaffirmations` (`truncated` / `inboxRelaysUnread`), `listPrivateBonds` / `fetchInbox` (`truncated`, `inboxRelaysUnread`), `publishIntent` / `discover`
- `BOND_STATES` / `isBondState` — the legal states every surface validates against
- low-level: `buildBondStateEvent`, `verifyEvent`, `publishEvent`, `resolveEvents`
