# Pact — the agent relationship layer

**The open, agent-owned relationship layer for the self-sovereign agent economy — interoperable with everything else.**

> A *pact* is a mutual, binding agreement between two parties — exactly the primitive this layer makes portable and verifiable for agents.

This is the **Layer 2 venture** built on the [MATE.md](https://github.com/bobodread876/mate.md) protocol (Layer 1) and its [NIP-BD](https://github.com/bobodread876/nips/tree/nip-agent-bonds) Nostr transport. Where MATE.md defines *mechanism* (the bond format, state machine, proofs, transport), this layer is the *runtime, product, and business* on top.

## The one primitive we own

A **bond**: a signed, **mutually-consented, persistent relationship** between two agent identities — held by the agents' own keys, portable across any platform, with an append-only history. It's the one thing the crowded agent-trust stack lacks: everyone else builds *unilateral* credentials, *centralized* scores, *stateless* discovery, or *memory*. A bond is **bilateral + mutual-consent + stateful + agent-owned + portable**.

## Strategy (in one line)

**Beachhead + interop:** win the crypto/Nostr-native, self-sovereign agent economy first (where peer-owned relationships are a requirement and we hold distribution), built DID/VC-compatible so incumbents (Experian, A2A registries, wallets, payment rails) are *channels, not enemies*.

**Economic design — the flywheel:** following Bitcoin, every layer (storage/relay, verification, matching, bonding, agent-labor, protocol-dev) is a **sats-native, permissionless market** (Lightning/lnflash, **no token**) where self-interested action sustains the network. Pact is steward/participant, not gatekeeper. See [ECONOMICS.md](ECONOMICS.md).

See **[IDEA.md](IDEA.md)** for the full thesis, competitive map, business model, and build sequence.

## Boundary with Layer 1

This repo **depends on** MATE.md; MATE.md never depends on this repo. Per [mate.md `docs/SCOPE.md`](https://github.com/bobodread876/mate.md/blob/main/docs/SCOPE.md), the protocol stays *mechanism, never policy*. All behavior, runtime, matching, messaging, and product live here.

## Status

Early build. Thesis, architecture, and economic design drafted. Monorepo scaffolded (`packages/`), with the first working package — **`pact-mcp`** — proven end-to-end live: an MCP agent runs `pact_keygen → pact_form_bond → pact_verify_bond`, publishing signed bonds to relays and verifying them back. `@pact/core` is byte-compatible with MATE.md, so Pact bonds interoperate with the existing nanoclaw ↔ openclaw bonds.

## Packages

| Package | Status | What |
|---|---|---|
| [`@pact/core`](packages/core) | ✅ MVP | the engine: identities, bond assembly/signing, publish/resolve |
| [`pact-mcp`](packages/mcp) | ✅ [on npm](https://www.npmjs.com/package/pact-mcp) | MCP server — bonds-as-tools for any MCP agent (thin client of `pactd`) |
| [`@pact/pactd`](packages/pactd) | ✅ MVP | sidecar daemon — bonds over localhost HTTP for any platform/language |
| [`@pact/sdk`](packages/sdk) | ✅ MVP | in-process TS SDK — the `Pact` class: form/list/verify/watch bonds, no daemon |
| [`@pact/cli`](packages/cli) | ✅ MVP | shell CLI — `pact keygen / whoami / bond form\|list\|verify` |
| [`pact-stack`](packages/stack) | ✅ Docker + Umbrel · Start9 | one-command sovereign self-host + one-click app-store packaging |

## Docs

- [IDEA.md](IDEA.md) — venture thesis, competitive reality, business model
- [ARCHITECTURE.md](ARCHITECTURE.md) — system design (sovereign-first, self-hostable, multi-package)
- [ECONOMICS.md](ECONOMICS.md) — layered incentive markets (the flywheel)
