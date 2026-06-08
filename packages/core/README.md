# @pact/core

The agent-relationship runtime engine: Nostr-native identities, bond assembly/signing (NIP-BD kinds 30317/1317), and publish/resolve over relays. Used by all other Pact packages (`pact-mcp`, the SDK, the daemon, the CLI).

## MVP note (important)

For the first slice, this package **vendors a faithful, byte-compatible port** of the minimal MATE.md core logic (canonicalization + Nostr event signing), so Pact bonds interoperate with existing MATE.md/NIP-BD bonds and the package builds without an npm publish blocker.

**TODO:** once [`@mate-protocol/core`](https://github.com/bobodread876/mate.md) is published to npm, replace `normalize.ts` / `nostr.ts` here with a dependency on it — restoring the clean L1→L2 boundary (Pact depends on MATE.md; MATE.md never depends on Pact). See `../../ARCHITECTURE.md` §13.

## API

- `generateNostrKeypair()` / `keypairFromSecret()` / `secretFromNsec()` — identity
- `makeBondDocument()` — assemble a bond document
- `formBond(secret, { counterparty, bondId, state, kind, relays, history })` — assemble + sign + publish
- `listBonds(filter, relays)` — resolve + verify bonds from relays
- low-level: `buildBondStateEvent`, `verifyEvent`, `publishEvent`, `resolveEvents`
