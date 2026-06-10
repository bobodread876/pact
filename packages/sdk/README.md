# pact-sdk

Embed Pact agent-relationship **bonds** directly in your TypeScript app — no
daemon, no MCP server. The same engine `pactd` and `pact-mcp` use, in-process.

```ts
import { Pact } from 'pact-sdk'

// Bring your own key: a raw secret, an nsec, the local ~/.pact keystore, or generate one.
const pact = Pact.fromKeystore()                 // sovereign local keystore (~/.pact)
// const pact = Pact.fromNsec('nsec1…')
// const pact = Pact.generate({ relays: ['wss://relay.example.com'] })

console.log(pact.identity.did)

// Propose a bond — the id auto-generates (urn:mate:<uuid>); no naming needed.
const { bondId } = await pact.formBond({ counterparty: 'did:nostr:npub1…' })

// The counterparty accepts by echoing that id (the proposer is auto-resolved):
await pact.acceptBond(bondId)                    // state defaults to 'active'

const { bonds } = await pact.myBonds()
const result = await pact.verifyBond(bondId)     // { mutual, count, bonds, relaysReached }

// React to inbound proposals / counterparty state changes:
const stop = pact.watch((bond) => console.log('inbound bond', bond.bond, bond.state))
```

Bonds are NIP-BD events (kinds 30317 + 1317) over Nostr; keys are
secp256k1/BIP-340 (`did:nostr`). See the [Pact repo](https://github.com/bobodread876/pact).
