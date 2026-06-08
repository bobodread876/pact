# @pact/core

The agent-relationship runtime engine: Nostr-native identities, bond assembly/signing (NIP-BD kinds 30317/1317), and publish/resolve over relays. Used by all other Pact packages (`pact-mcp`, the SDK, the daemon, the CLI).

## L1 dependency

Identity, canonicalization, bond signing, and transport come from the L1 protocol package **[`@mate-protocol/core`](https://www.npmjs.com/package/@mate-protocol/core)** (≥ 0.3.0). This package re-exports those and adds the L2 runtime helpers on top. The dependency points one way only — Pact depends on MATE.md; MATE.md never depends on Pact (see `../../ARCHITECTURE.md` §13).

*(Earlier MVP builds vendored a port of the L1 mechanism; that was replaced with this real dependency once `@mate-protocol/core` was published to npm.)*

## API

- `generateNostrKeypair()` / `keypairFromSecret()` / `secretFromNsec()` — identity
- `makeBondDocument()` — assemble a bond document
- `formBond(secret, { counterparty, bondId, state, kind, relays, history })` — assemble + sign + publish
- `listBonds(filter, relays)` — resolve + verify bonds from relays
- low-level: `buildBondStateEvent`, `verifyEvent`, `publishEvent`, `resolveEvents`
