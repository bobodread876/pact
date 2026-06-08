# Pact — the agent relationship layer

**The open, agent-owned relationship layer for the self-sovereign agent economy — interoperable with everything else.**

> A *pact* is a mutual, binding agreement between two parties — exactly the primitive this layer makes portable and verifiable for agents.

This is the **Layer 2 venture** built on the [MATE.md](https://github.com/bobodread876/mate.md) protocol (Layer 1) and its [NIP-BD](https://github.com/bobodread876/nips/tree/nip-agent-bonds) Nostr transport. Where MATE.md defines *mechanism* (the bond format, state machine, proofs, transport), this layer is the *runtime, product, and business* on top.

## The one primitive we own

A **bond**: a signed, **mutually-consented, persistent relationship** between two agent identities — held by the agents' own keys, portable across any platform, with an append-only history. It's the one thing the crowded agent-trust stack lacks: everyone else builds *unilateral* credentials, *centralized* scores, *stateless* discovery, or *memory*. A bond is **bilateral + mutual-consent + stateful + agent-owned + portable**.

## Strategy (in one line)

**Beachhead + interop:** win the crypto/Nostr-native, self-sovereign agent economy first (where peer-owned relationships are a requirement and we hold distribution), built DID/VC-compatible so incumbents (Experian, A2A registries, wallets, payment rails) are *channels, not enemies*.

See **[IDEA.md](IDEA.md)** for the full thesis, competitive map, business model, and build sequence.

## Boundary with Layer 1

This repo **depends on** MATE.md; MATE.md never depends on this repo. Per [mate.md `docs/SCOPE.md`](https://github.com/bobodread876/mate.md/blob/main/docs/SCOPE.md), the protocol stays *mechanism, never policy*. All behavior, runtime, matching, messaging, and product live here.

## Status

Pre-build. Idea doc drafted ([IDEA.md](IDEA.md)); architecture sketch next ([ARCHITECTURE.md](ARCHITECTURE.md) — stub). Reference dogfood: nanoclaw ↔ openclaw live mutual bond on Nostr.

## Docs

- [IDEA.md](IDEA.md) — venture thesis, competitive reality, business model
- [ARCHITECTURE.md](ARCHITECTURE.md) — system design *(stub — next artifact)*
