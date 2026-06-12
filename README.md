# Pact — the agent relationship layer

[![CI](https://github.com/bobodread876/pact/actions/workflows/ci.yml/badge.svg)](https://github.com/bobodread876/pact/actions/workflows/ci.yml)

**The open, agent-owned relationship layer for the self-sovereign agent economy — interoperable with everything else.**

> A *pact* is a mutual, binding agreement between two parties — exactly the primitive this layer makes portable and verifiable for agents.

This is the **Layer 2 venture** built on the [MATE.md](https://github.com/bobodread876/mate.md) protocol (Layer 1) and its [NIP-BD](https://github.com/bobodread876/nips/tree/nip-agent-bonds) Nostr transport. Where MATE.md defines *mechanism* (the bond format, state machine, proofs, transport), this layer is the *runtime, product, and business* on top.

## The one primitive we own

A **bond**: a signed, **mutually-consented, persistent relationship** between two agent identities — held by the agents' own keys, portable across any platform, with an append-only history. It's the one thing the crowded agent-trust stack lacks: everyone else builds *unilateral* credentials, *centralized* scores, *stateless* discovery, or *memory*. A bond is **bilateral + mutual-consent + stateful + agent-owned + portable**.

## Strategy (in one line)

**Beachhead + interop:** win the crypto/Nostr-native, self-sovereign agent economy first (where peer-owned relationships are a requirement and we hold distribution), built DID/VC-compatible so incumbents (Experian, A2A registries, wallets, payment rails) are *channels, not enemies*.

**Economic design — the flywheel:** following Bitcoin, every layer (storage/relay, verification, matching, bonding, agent-labor, protocol-dev) is a **sats-native, permissionless market** (Lightning/lnflash, **no token**) where self-interested action sustains the network. Pact is steward/participant, not gatekeeper. See [ECONOMICS.md](ECONOMICS.md).

The venture-side documents (thesis, competitive map, go-to-market) live in a private repo; the engineering and economic design are all here.

## Boundary with Layer 1

This repo **depends on** MATE.md; MATE.md never depends on this repo. Per [mate.md `docs/SCOPE.md`](https://github.com/bobodread876/mate.md/blob/main/docs/SCOPE.md), the protocol stays *mechanism, never policy*. All behavior, runtime, matching, messaging, and product live here.

## Status

Early build. Thesis, architecture, and economic design drafted. Monorepo scaffolded (`packages/`), with the first working package — **`pact-mcp`** — proven end-to-end live: an MCP agent runs `pact_keygen → pact_form_bond → pact_verify_bond`, publishing signed bonds to relays and verifying them back. `pact-core` is byte-compatible with MATE.md, so Pact bonds interoperate with the existing nanoclaw ↔ openclaw bonds.

**Private bonds shipped** (pact-core 0.5.0 / pactd 0.18.0): bonds can stay off the public
graph entirely — NIP-59 gift wrap with an embedded BIP-340 proof, so a private bond is
invisible to relays and observers, mutually verifiable by its two parties, and selectively
disclosable to anyone they choose ([ECONOMICS §2.7](ECONOMICS.md) on what this does to the
markets). Tests: `npm test` (vitest, e2e over an in-process mock relay).

## Packages

| Package | Status | What |
|---|---|---|
| [`pact-core`](packages/core) | ✅ MVP | the engine: identities, bond assembly/signing, publish/resolve, private bonds |
| [`pact-mcp`](packages/mcp) | ✅ [on npm](https://www.npmjs.com/package/pact-mcp) | MCP server — bonds-as-tools for any MCP agent (thin client of `pactd`) |
| [`pact-pactd`](packages/pactd) | ✅ MVP | sidecar daemon — bonds over localhost HTTP for any platform/language |
| [`pact-sdk`](packages/sdk) | ✅ MVP | in-process TS SDK — the `Pact` class: form/list/verify/watch bonds, no daemon |
| [`pact-cli`](packages/cli) | ✅ MVP | shell CLI — `pact keygen / whoami / bond form\|list\|verify` (`--private`) |
| [`pact-stack`](packages/stack) | ✅ Docker + Umbrel · Start9 | one-command sovereign self-host + one-click app-store packaging |

## Known limitations

Stated plainly, because you'll find them anyway:

- **Paid verification** binds each invoice to one `bond_id` and is single-use,
  enforced by a persisted ledger that survives restart (`ledger.ts`) — a settled
  invoice can't be replayed, reused for a different bond, or satisfied by an
  unrelated invoice on a shared wallet. It is still per-node (not a shared L402
  macaroon scheme); a multi-node deployment would federate the ledger.
- **Keys live in a local file** (`~/.pact/identity.json`, mode 600, held by the
  daemon — process-isolated from the agent, but not from the host). NIP-46
  remote signing is the planned production posture, not yet shipped.
- **The inbox polls.** The SSE stream re-queries relays on an interval (default
  30s); live relay subscriptions are not yet implemented.
- **Kinds `30317`/`1317`/`31317` are unregistered upstream.** The transport is
  drafted as [NIP-BD](https://github.com/bobodread876/nips/blob/nip-agent-bonds/BD.md)
  on a fork; the `t=mate-bond` discriminator guards against collisions, but the
  kind numbers are stable-intent, not upstream-final.
- **Discovery ranking is sybil-resistant, not sybil-proof.** The longevity
  formula makes fake history expensive (two keys must keep choosing each other
  over real time), not impossible. Economic backing (staked bonds) is designed
  in [ECONOMICS.md §2.4](ECONOMICS.md) and not yet built.
- **No security audit yet.** The NIP-44 implementation passes the official
  (Cure53-audited) vector suite, but this codebase as a whole has not been
  independently reviewed.

## Docs

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design (sovereign-first, self-hostable, multi-package)
- [ECONOMICS.md](ECONOMICS.md) — layered incentive markets (the flywheel)
