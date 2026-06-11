# Pact — Architecture

*Status: draft v0.1, 2026-06-07. Implements the venture thesis (private docs). Built on [MATE.md](https://github.com/bobodread876/mate.md) (L1 protocol) + [NIP-BD](https://github.com/bobodread876/nips/tree/nip-agent-bonds) (transport).*

---

## 0. Design principles (non-negotiable)

These come straight from the beachhead — open-source developers and sovereign-computing users:

1. **Sovereign by default.** Everything works fully self-hosted with **no Pact-operated server in the path**. Keys, data, and relays can all be the user's own. The managed cloud is *convenience*, never a gate.
2. **Local-first, agent-owned keys.** Private keys never leave the user's control unless they explicitly opt in. BYO key, BYO relay, BYO storage.
3. **Open-core, permissively licensed.** The core engine, SDKs, daemon, CLI, and adapters are open source (Apache-2.0 / MIT, matching L1's MIT). Trust requires inspectable code; the moat is data + distribution, not a closed core.
4. **Drop-in, not rip-and-replace.** Ship *several* install form-factors so Pact runs *alongside* an existing agent platform (library, sidecar, CLI, MCP server, plugins) — adopt in minutes without re-architecting.
5. **Protocol over platform.** The source of truth is signed events on a transport the user controls (Nostr/relays), not Pact's database. If Pact-the-company disappears, your bonds survive on your relays + your keys + your local store.
6. **Interop, not enclosure.** A bond is issued/verifiable as a W3C DID/VC-compatible credential so the rest of the stack (registries, wallets, bureaus, A2A) can *read* it. (Per IDEA §3 — incumbents are channels.)
7. **Incentive markets at every layer (the flywheel).** Following Bitcoin: each layer (storage/relay, verification, matching, bonding, agent-labor, protocol-dev) is a **sats-native, permissionless market** where self-interested action produces the work the layer needs. Settlement is Bitcoin over Lightning (lnflash) — **no token**. Every node type exposes a payment interface; Pact is a steward/participant, not a gatekeeper. See **[ECONOMICS.md](ECONOMICS.md)** — this is a load-bearing design pillar, not a monetization afterthought.

---

## 1. High-level shape

```
            ┌─────────────────────────────────────────────────────────────┐
            │                   THE USER'S MACHINE / INFRA                  │
            │                                                               │
  Agent ───▶│  [ install form-factor ]      ┌───────────────────────────┐  │
  platform  │   • SDK (in-process)  ───────▶│        PACT CORE          │  │
  (LangGraph│   • pactd (sidecar)           │   (open source engine)    │  │
  /CrewAI/  │   • CLI                       │ ┌───────────────────────┐ │  │
  nanoclaw/ │   • MCP server                │ │ bond lifecycle engine │ │  │
  custom)   │   • platform plugin           │ │ consent/inbox policy  │ │  │
            │                               │ │ heartbeat/reaffirm    │ │  │
            │                               │ │ DID/VC interop        │ │  │
            │   ┌──────────────┐            │ │ relay client          │ │  │
            │   │local keystore│◀──signer───│ │ local store (SQLite)   │ │  │
            │   │(file/OS/NIP46)│           │ └───────────────────────┘ │  │
            │   └──────────────┘            └────────────┬──────────────┘  │
            └────────────────────────────────────────────┼─────────────────┘
                                                          │ Nostr (NIP-BD)
                       ┌──────────────────────────────────┼───────────────────────┐
                       ▼                                   ▼                        ▼
               self-hosted relay                community/public relays      Pact managed plane
               (strfry/nostr-rs-relay)          (relay.islandbitcoin.com)    (OPTIONAL — the business)
                                                                             • managed relays + durable history
                                                                             • verification / DID-VC API
                                                                             • directory + matching engine
                                                                             • dashboard / enterprise
```

The entire left side is open source and runs with zero Pact-cloud. The managed plane is opt-in and speaks the *same* protocol — so users move between sovereign, hybrid, and managed with no migration.

---

## 2. Layers

| Layer | What | Open? | Runs where |
|---|---|---|---|
| **L1 — Protocol** | MATE.md core (bond format, state machine, proofs, canonicalization) + NIP-BD transport. Pact *depends on* it. | OSS (MIT) | vendored lib |
| **L2a — Pact Core** | The relationship *runtime*: lifecycle, policy, heartbeat, interop, local store, relay client, signer. | OSS | user's machine |
| **L2b — Form factors** | SDKs, sidecar daemon, CLI, MCP server, platform plugins, self-host bundle. | OSS | user's machine |
| **L2c — Managed plane** | Hosted relays + durable history, verification/DID-VC API, directory + matching, dashboard, enterprise. | Commercial | Pact cloud *or* self-hostable enterprise build |

---

## 3. Pact Core (the open-source engine)

A single embeddable engine (TypeScript, reusing `@mate-protocol/core`), consumed in-process by the SDK or wrapped by the daemon. Components:

- **Bond lifecycle engine** — propose / accept / reaffirm / pause / revoke / withdraw, enforcing the L1 state machine and invariants. Emits lifecycle events.
- **Consent / inbox policy** — pluggable rules for inbound bonds: allowlist, "known" counterparties, trust threshold, reputation floor, `auto_acknowledge`. *Never* implicit accept.
- **Heartbeat & reaffirmation scheduler** — periodic presence + the cold-start "re-choose" ritual (reread bonds on boot; decide reaffirm/pause/revoke). Cron-like, runs locally.
- **Relay client** — publish/resolve NIP-BD events; pluggable relay set (self-hosted, community, managed). Handles dedup, retry, EOSE, addressable replace.
- **Local store** — embedded **SQLite** index/cache of the bond graph + history for fast reads and offline operation. *Cache, not source of truth* — rebuildable from relays.
- **Signer abstraction** — local encrypted keystore, OS keychain, or **remote signer (NIP-46 "bunker")** / hardware. Keys are pluggable and never required to leave the box.
- **DID/VC interop** — resolve `did:key` / `did:nostr` (and `did:web` later); issue/verify a bond as a W3C Verifiable Credential (bilateral). The bridge to the broader identity stack.
- **Event bus** — `onStateChange`, `onProposalReceived`, etc., delivered to the host agent via callback (in-process) or webhook/SSE (sidecar).

---

## 4. Install form-factors (the "several packages" requirement)

Each is an independent install so a developer picks the integration depth that fits their platform:

| Package | Install | For whom | How it attaches |
|---|---|---|---|
| **`pact-sdk`** (TS) / **`pact-sdk`** (Python) | `npm i pact-sdk` · `pip install pact-sdk` | builders who want in-process control | embeds Pact Core (TS) or a thin client to `pactd` (Python) |
| **`pactd`** — sidecar daemon | Docker · Homebrew · systemd · single binary | *any* agent platform, any language | long-running local process; agent talks to it over `127.0.0.1` HTTP/JSON + SSE (or Unix socket) |
| **`pact`** — CLI | Homebrew · npm · binary | ops, scripting, sovereign users | drives the core/daemon from the shell (superset of the `mate` CLI) |
| **`pact-mcp`** — MCP server | `npx pact-mcp` · Docker | *any MCP-capable agent* (Claude, etc.) | exposes bond ops as **MCP tools** so the agent forms/manages bonds natively |
| **Platform plugins** | per-platform package | LangGraph, CrewAI, AutoGPT, nanoclaw/openclaw, A2A bridge | thin adapter mapping the platform's agent identity ↔ a Pact bond |
| **`pact-stack`** — self-host bundle | `docker compose up` | sovereign users who want the whole thing | bundles `pactd` + a Nostr relay (strfry / nostr-rs-relay) + optional local dashboard, one command |

**Why the sidecar matters most:** `pactd` is the universal adapter. Language-agnostic, process-isolated (keys live with the daemon, not the agent), and it lets the relationship layer run *next to* any agent runtime without touching its code — the literal "runs alongside the end-user's agent platform" requirement.

**Why the MCP server matters most for reach:** MCP is the de-facto tool standard. Shipping bonds as MCP tools means millions of existing MCP agents can adopt Pact with zero SDK work — "give your agent the `propose_bond` / `reaffirm` / `verify_bond` tools."

---

## 5. Data model & sovereignty

- **Source of truth = signed events on relays** (NIP-BD kinds `30317` current state + `1317` history). The user chooses the relays (self-hosted, community, or managed).
- **Local store = SQLite** index of bonds + history + counterparties + cached profiles, for fast/offline reads. Fully rebuildable from relays — losing it loses nothing.
- **Keys = the user's.** The triplet {keys, relays, local store} is entirely under user control. **Pact-the-company is never in the trust or availability path** for a self-hoster.
- **Portability guarantee:** because identity is the agent's key and state lives on open relays, a user can switch relays, switch self-hosted ↔ managed, or leave Pact entirely, without losing a single bond.

---

## 6. Identity & key custody

Sovereign-grade options, escalating in security:

1. **Local encrypted keystore** (age/secretbox-encrypted file) — default, zero-dependency.
2. **OS keychain** (macOS Keychain / libsecret) — desktop convenience.
3. **Remote signer / NIP-46 "bunker"** — keys live in a separate hardened process or device; the agent never holds the secret. The sovereign default for production.
4. **Hardware / external signer** — HSM, hardware Nostr signer, or onchain-anchored DID for the crypto-native segment.

Delegation (NIP-26) lets a harness sign on an agent's behalf with scoped, revocable authority — recorded in the bond's `runtime` block.

---

## 7. Deployment topologies (all first-class, freely interchangeable)

1. **Fully sovereign / air-gapped-friendly** — SDK or `pactd` + self-hosted relay (`pact-stack`) + local signer. Zero Pact-cloud, zero third-party dependency.
2. **Sovereign + community relays** — self-hosted engine publishing to public/community relays (incl. `relay.islandbitcoin.com`) for reach without running your own relay.
3. **Managed / hybrid** — self-hosted engine pointing at the Pact managed plane for durable history, verification API, directory, and matching. Opt-in per capability.

The same binaries and protocol serve all three; topology is configuration, not a fork.

---

## 8. Interop surface (channels into the rest of the stack)

- **DID/VC bridge** — issue a bond as a W3C Verifiable Credential (bilateral, dual-signed); verify externally-presented credentials. Lets wallets, registries, and bureaus *consume* a bond as a signal.
- **A2A bridge plugin** — map an A2A Agent Card ↔ a Pact bond, so agents discovered via A2A can form *stateful, consented* relationships Pact tracks (the layer A2A registries lack).
- **MCP** — both a client (read an agent's MCP tool manifest as a matching signal) and a server (bonds-as-tools).
- **Verification API** *(managed or self-hostable)* — `verify(bond)` over HTTP for third parties who don't run the engine. Also a revenue surface (IDEA §6).

---

## 9. The sovereignty ↔ network-effect tension (explicit)

Honest design note: the **runtime is fully sovereign**, but **matching and reputation are inherently network services** — a lone self-hoster has no graph to match against. Resolution:

- The **relationship engine** (forming / holding / verifying bonds) needs *nothing* external. 100% sovereign.
- The **directory / matching / reputation** layer is an **opt-in network service**, available as (a) the Pact managed plane, or (b) a **federated, community-run index** that sovereign nodes can self-host and peer. You get matching only if you choose to participate — and even then via open protocols, not a walled API.

This keeps the sovereignty promise intact while still allowing the network-effect product to exist for those who want it.

---

## 10. Security & privacy

- **Authenticity** — every bond/event verified via L1 signatures; no trust in the transport.
- **Consent integrity** — a counterparty's state only counts when carried by *their* signed event; no forged acceptance.
- **Privacy** — public bonds by default; **private bonds via NIP-44 + NIP-59 gift wrap** (shipped: pact-core 0.3.0 / pactd 0.14.0, mechanism in MATE.md extension §13). The bond event stays an unsigned rumor wrapped once for the counterparty and once for the author (copy-to-self); relays see an ephemeral signer, the recipient `p` tag, and a fuzzed timestamp — no bond id, state, or counterparty linkage. Because rumors are unsigned, every private bond document carries an **embedded BIP-340 proof**, so either party can selectively disclose the document and the disclosure is independently verifiable. Verification of a private bond is parties-only by design: `verifyBond` without the decryption key finds nothing.
- **Process isolation** — the sidecar holds keys separately from the (often less-trusted) agent process.
- **Supply chain** — reproducible builds, signed releases — table stakes for a sovereign-computing audience.

---

## 11. Open-core & licensing boundary

- **Open source (Apache-2.0 / MIT):** Pact Core, all SDKs, `pactd`, CLI, MCP server, platform plugins, `pact-stack`, and the self-hostable verification engine. The sovereign user gets a *complete, functional* system for free.
- **Commercial (managed plane):** hosted relays + durable history at scale, the global matching/reputation graph, dashboard, enterprise (audit/compliance/SSO/SLAs), and managed verification. Optionally a self-hostable **enterprise** build under a source-available license.
- **Why permissive core:** this audience won't trust (or adopt) a crippled or restrictively-licensed core. The moat is the bilateral data graph + distribution + the managed network services — not license handcuffs.

---

## 12. Proposed tech stack (starting point)

- **Core engine:** TypeScript, reusing `@mate-protocol/core`. Distributed as a library and bundled into `pactd`.
- **Sidecar daemon:** ships as Docker + npm + a single compiled binary (Bun first; a Rust port later for a dependency-free static binary — important for sovereign/air-gapped installs).
- **Local store:** SQLite (embedded, zero-config, inspectable).
- **Relay (self-host):** recommend/bundle **strfry** or **nostr-rs-relay**.
- **Local API:** HTTP/JSON + SSE over `127.0.0.1` (universal); optional Unix socket; gRPC later.
- **Python SDK:** thin client to `pactd` (avoids reimplementing crypto; keeps one canonical engine).
- **Packaging:** Docker images, `docker-compose` (`pact-stack`), Homebrew formula, npm, PyPI, systemd unit, signed release binaries.

---

## 13. Boundary with L1 (restated)

Pact **depends on** MATE.md; MATE.md **never** depends on Pact (see mate.md `docs/SCOPE.md`). Mechanism (bond format, proofs, transport, canonicalization) lives in L1. Everything here — runtime behavior, policy, scheduling, packaging, matching, product — is L2. New protocol needs are proposed upstream to mate.md / NIP-BD, never bolted on here.

---

## 14. Open questions

- **Daemon language:** ship `pactd` in Node/Bun first for speed, or invest early in a Rust static binary for the sovereign/air-gapped story? (Leaning: Bun now, Rust port once adoption justifies.)
- ~~**Federated matching protocol:** what's the minimal open spec for community-run directory/matching nodes to peer, so "matching" never requires the Pact cloud?~~ **Answered (and de-federated): there is nothing to peer.** Discovery is open data — kind 31317 bond intents plus the public bond graph on ordinary relays — so any directory or matcher is just a reader of the same events. No federation protocol needed; matchers compete as services over open data (ECONOMICS §2.3), and the Pact cloud is one reader among many by construction.
- **Private-bond UX:** how much of the gift-wrap/NIP-44 flow can be one-flag without footguns?
- **VC profile:** which VC data model + status-list revocation scheme to standardize the bond-as-credential on, for clean wallet interop.
- **Signer defaults:** push NIP-46 remote signing as the default for production, or keep local keystore default for friction?
