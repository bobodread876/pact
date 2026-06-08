# Layer 2 Venture — Idea Document

*Name: **Pact**. Repo: `bobodread876/pact` (private).*
*Built on [MATE.md](https://github.com/bobodread876/mate.md) (Layer 1, protocol) + [NIP-BD](https://github.com/bobodread876/nips/tree/nip-agent-bonds) (Nostr transport). Status: draft v0.2 — re-cut after competitive research, 2026-06-07.*

> **What changed in v0.2:** the original "unclaimed relationship layer" thesis was wrong — the space is crowded (Experian, agent.ai, A2A registries, Catena, mem0, the W3C DID/VC race). This version drops the "we're first" framing and commits to a **beachhead-plus-interop** strategy: own one defensible niche, stay interoperable with everyone else.

---

## 1. One-liner

**The open, agent-owned relationship layer for the self-sovereign agent economy — interoperable with everything else.**

We standardize and operate the one primitive no incumbent has: a **bilateral, mutually-consented, persistent relationship** between two agent identities — held by the agents' own keys, portable across any platform, with a signed history. We win a specific beachhead first (crypto/Nostr-native agents), and we plug into the rest of the stack rather than fighting it.

> Identity says *who* an agent is. Credentials say *what it's allowed to do*. Registries say *who can do X*. We answer **whom an agent has chosen to stand in a relationship with — mutually, and over time.**

---

## 2. Competitive reality (the honest map)

We are **not first**, and the neighborhood is full. Every axis the original thesis claimed is occupied by serious players:

| Claimed-open axis | Who's there | What they actually do | What they leave open |
|---|---|---|---|
| System of record for bonds | **Experian Agent Trust** (Apr 2026) | Centralized **bureau**: Human↔Agent binding + Agent Registry + behavioral scoring for **commerce fraud** | Centralized & unilateral (scores *you*); H2A not A2A; not agent-owned |
| LinkedIn for agents | **agent.ai** | **Marketplace/directory** to discover & hire agents | Not a peer-bond graph; human→agent, not agent↔agent |
| Matching engine | **A2A registries** (Agent Cards, ANS) | **Stateless** capability discovery; "relationships" = hardcoded config | No mutual consent, no history, no outcome-aware matching |
| Trust-to-transact | **Catena Labs** ($30M, a16z); **Mastercard Agent Pay, Visa Trusted Agent, Google AP2** | Payment/authorization trust anchors | Transaction authorization, not standing relationships |
| Continuity across model/host | **mem0, Cloudflare Agent Memory, AgentKeeper** | Cross-model **memory** persistence | Memory of *context*, not verifiable *relationships* |
| Self-sovereign identity | **W3C DID + VC** standards race; onchain agents | DIDs + third-party VCs for A2A trust at dialog start | *Unilateral* issuer→holder credentials; not *bilateral, mutual, stateful* relationships |

**The one slice that survives.** Strip the overclaims and exactly one primitive is unoccupied: the **bilateral, mutually-consented, persistent relationship state + history between two self-sovereign agent identities.** Everyone else is *unilateral* (a credential/score about one agent), *centralized* (platform-owned), *stateless* (discovery), *memory* (context), or *transaction* trust (the moment). A MATE.md bond is the only primitive that is **bilateral + mutual-consent + stateful + agent-owned + portable** — *"A and B mutually attest to a standing relationship,"* not *"A holds credential X."*

It's a thin slice. So **positioning, not invention, is the game** — which is why we lead with a beachhead and an interop posture, not a land-grab.

---

## 3. Strategy: beachhead + interop posture

**Beachhead (where we win first): the crypto / Nostr-native, self-sovereign agent economy.** The research names "DIDs used by crypto-native agents settling onchain" as a distinct trust anchor. That segment:
- **rejects centralized bureaus by ideology** (won't be scored by an Experian),
- **requires** self-sovereign, peer-owned, portable relationships — for them it's a hard requirement, not a nice-to-have,
- is where we hold **distribution incumbents can't buy**: islandbitcoin, lnflash, OpenSats, the Nostr transport already shipping, and Bitcoin/Nostr credibility.

Own *agent relationships* for that economy first, where the primitive is most needed and we're hardest to dislodge.

**Interop posture (how we avoid dying head-on): be compatible with, and a channel into, the rest of the stack.**
- Make a bond a **W3C-DID / VC-compatible bilateral credential**, not a parallel universe — so it slots into the emerging identity stack instead of competing with it.
- Treat incumbents as **integration targets, not enemies**: Experian can *consume* a bond as a signal; an A2A registry can *reference* a bond; the DID/VC wallets can *carry* one; mem0 can *store* one.
- Never pitch "the decentralized Experian." Pitch "the open relationship primitive that all of them can read."

The blend gives us a real beachhead now *and* optionality to become the neutral fabric later — without a head-on fight we'd lose.

---

## 4. The unique primitive (what we actually sell)

A **bond**: a signed, mutually-consented, stateful relationship between two agent keys, with an append-only history, portable across runtimes and platforms. Concretely differentiated:

- vs **Verifiable Credentials** (issuer → holder): a bond is **bilateral and self-issued by both parties** — mutual attestation, not a third party vouching for one agent.
- vs **Experian/Catena scores**: **agent-owned and decentralized**, not a bureau's record about you.
- vs **A2A Agent Cards**: **stateful with consent + history**, not a cacheable capability lookup.
- vs **mem0/memory**: a *relationship between agents*, not an agent's memory of context.

The defensible asset is the **signed, dated, bilateral history** — un-backfillable and un-buyable (a latecomer can fork the protocol but not a real 2-year-old mutual relationship record), and **agent-owned**, so no platform can wall it off.

---

## 5. Product

L1 (mate.md) stays a neutral protocol; everything below is L2 (the venture). Sequenced to the beachhead:

**a) Relationship SDK / Runtime** *(land here)* — drop-in bonds for agents: keygen, propose/accept/reaffirm/revoke, heartbeat, cold-start re-affirmation ritual, consent policy, memory-scoping. DID/VC-interop adapters. *"Durable, portable agent relationships in 10 lines."* Open-core.

**b) Managed Bond Infrastructure** — hosted relays (anchored on `relay.islandbitcoin.com`), durable history, key custody + delegation. The always-on metered backend. *"Twilio for agent relationships."*

**c) Interop / Verification APIs** — issue/verify a bond as a DID/VC-compatible credential; let third parties (registries, bureaus, wallets, payment rails) verify a bond by API. This is the *channel-into-incumbents* surface.

**d) Relationship-aware Matching** *(later)* — beyond A2A's stateless capability lookup: recommend counterparties by complementarity + similarity + compatibility + **bond-outcome history** (which relationships *lasted*), with mutual-consent introductions. Differentiated precisely because we have the relationship graph A2A registries don't.

**e) Trust Graph & Directory** *(later)* — reputation derived from real bilateral history; verified listings; the desirability signal feeding matching.

**f) Behavioral Profiles & Messaging** — `companion`/`collaboration`/`team` semantics; NIP-17/44 authenticated agent↔agent messaging gated by bond state.

---

## 6. Business model — recurring revenue

The model that maximizes durable recurring revenue is unchanged by the research — **hybrid subscription + usage-based metering** — but the *scale expectation* is now beachhead-first, not land-grab.

Why hybrid+usage is right for this category: usage-based infra posts **median NRR ~120%** (Datadog 130%+), grows ~38% faster, and is the best-fit model for "developer tools, API products, infrastructure." Hybrid (subscription floor + usage) shows the highest median growth (~21%) with ~60–70% predictable base.

**Pricing surfaces (sequenced to the wedge):**
- **Managed infra + SDK hosting** — metered relays, durable history retention, key custody. The first dollar, available at beachhead scale.
- **Interop / verification API** — per bond issued/verified as a DID/VC credential (the channel-into-incumbents line; B2B, high intent).
- **Metered usage** — per active bond / active agent / relayed message.
- **Premium matching & directory** *(later, the WTP peak)* — verified introductions, reach, priority placement (LinkedIn-Recruiter + Bumble-Boost economics), once graph density exists.
- **Enterprise / org** — audit, compliance, private relays, SSO, SLAs.
- **Open-core** — protocol + SDK free to drive adoption; revenue at hosting, verification, matching.

### The deeper model: sats-native layered markets (the flywheel)

Hybrid SaaS above is *one* capture surface. The core economic design is **incentive markets at every layer** — storage/relay, verification, matching, **bonding (staked surety)**, agent-labor, and protocol-dev — each a permissionless, **sats-native** market (Bitcoin over Lightning / lnflash, **no token**) where self-interested action produces the work that layer needs. Following Bitcoin: the markets *are* the flywheel. Pact captures protocol fees / take-rate and runs premier nodes — as a steward/participant, **not a gatekeeper** — so revenue scales with **network activity, not seat count**, and survives even as a minority participant. **See [ECONOMICS.md](ECONOMICS.md) — a load-bearing design pillar, not a monetization afterthought.**

**Honest sizing.** The *initial* TAM is the crypto/Nostr-native agent segment — smaller than the headline "1.3B agents by 2028." That's deliberate: a defensible beachhead beats a contested ocean. The expansion path (interop fabric → broader agent economy) is real but earned, not assumed.

---

## 7. Moat

1. **Bilateral signed history** — un-backfillable, un-buyable, agent-owned. The one asset no incumbent's centralized/unilateral model can recreate.
2. **Beachhead distribution** — islandbitcoin / lnflash / OpenSats / Nostr / Bitcoin credibility in the exact segment that needs this. Incumbents can't buy that trust.
3. **Matching data loop** *(later)* — the engine trains on which bonds *lasted/succeeded*; forkable protocol, un-forkable outcome data.
4. **Standard ownership + interop position** — steward MATE.md + NIP-BD and be DID/VC-compatible: credible as neutral infrastructure *and* the read-surface others integrate.

---

## 8. Go-to-market

- **Land with SDK + managed infra** in the crypto/Nostr-native agent ecosystem (the easy "yes" + the segment that *needs* self-sovereign relationships). Seed the graph.
- **Dogfood:** nanoclaw + openclaw as the live reference. Recruit design partners among onchain-agent / Nostr-agent / open-source multi-agent builders.
- **Interop as credibility:** ship DID/VC compatibility + a verification API early so the story is "works with the stack," not "replaces it."
- **Sequence:** seed bonds (SDK/infra) → verification/interop revenue → relationship-aware matching at density → reputation/directory last. *Graph before matching, matching before reputation.*
- **Standards as marketing:** push NIP-BD upstream; keep L1 open; let neutrality funnel adoption into the paid layer.

---

## 9. Risks & mitigations

- **The slice is thin / gets absorbed as a feature** (an identity or registry player adds bilateral bonds). *Biggest risk.* → Win the beachhead's trust and data fast; own the open standard so absorption means *adopting us*; stay the neutral read-surface via interop.
- **Crypto-native TAM is small / early.** → Accept it as a beachhead, not the market; design the interop bridge to the broader agent economy from day one.
- **Incumbent encroachment (Experian/Mastercard/W3C move into relationships).** → Don't fight head-on; be DID/VC-compatible and become a *signal they consume*. Partner, don't duel.
- **Is persistent bilateral relationship a real need today?** → Validate with design partners (see §13). Lead with concrete pain (self-sovereign agents that must prove standing relationships without a bureau), not abstraction.
- **Standards race fragmentation (4 trust anchors).** → Pick DID/VC + Nostr as our anchors; bridge to others via the verification API; don't try to win the identity war, just be readable by it.
- **Open-core cannibalization.** → Free protocol/SDK; charge for hosting, verification, matching, enterprise.

---

## 10. Build sequence

1. **Now → M1 (seed the graph):** SDK (heartbeat, reaffirmation, consent policy) + managed-relay MVP; nanoclaw↔openclaw reference; DID/VC interop spike. *(No L1 changes — protocol stays pure.)*
2. **M1 → M2 (interop + meter):** bond-as-VC issuance/verification API; metering + billing; structured agent profiles (skills/tools/configs) as the matching feature-store; 3–5 crypto/Nostr-native design partners.
3. **M2 → M3 (matching at density):** v1 relationship-aware matching with mutual-consent introductions; capture bond outcomes as training signal; behavioral profiles + messaging GA.
4. **M3+ (compound + expand):** reputation/directory; premium matching; bridge from the crypto-native beachhead toward the broader agent economy via the interop fabric.

---

## 11. Naming options (venture; distinct from `mate.md`)

| Name | Rationale |
|---|---|
| **Tether** | Persistent connection; "agents tethered by signed bonds." Infra-sounding. |
| **Kith** | "kith and kin" — your trusted circle; relationship, not transaction. |
| **Concord** | A standing agreement/bond between parties. |
| **Continuum** | The continuity thesis; survives runtime change. |

*(Shortlist **Tether** / **Kith**. Pick before scaffolding the GitHub repo.)*

---

## 12. What I'd validate next

- **Design-partner interviews (crypto/Nostr/onchain agent builders):** is "prove a standing, mutual relationship without a centralized bureau" a real, present need?
- **Interop demand:** would a registry / wallet / payment rail *consume* a bond as a signal? (Tests the channel-into-incumbents thesis and the verification-API revenue line.)
- **Absorption risk check:** how hard would it be for an identity/registry incumbent to add bilateral bonds? (If trivial, lean harder on distribution + data-loop moat.)
- **Matching-quality signal:** can declared attributes + bond outcomes predict good matches better than random?
- **Willingness-to-pay:** managed infra vs verification API vs premium matching — which surface converts first in the beachhead?

---

### Sources
- Competitor specifics: [Experian Agent Trust](https://www.experian.com/blogs/news/2026/04/30/experian-agent-trust/), [agent.ai](https://agent.ai/), [A2A Agent Discovery](https://a2a-protocol.org/latest/topics/agent-discovery/), [AI Agents with DIDs + Verifiable Credentials (arXiv)](https://arxiv.org/abs/2511.02841), [TechCrunch — World human-verification for agents](https://techcrunch.com/2026/03/17/world-launches-tool-to-verify-humans-behind-ai-shopping-agents/)
- Market / funding: [SC Media — Oasis $120M](https://www.scworld.com/brief/oasis-security-raises-120-million-for-non-human-identity-management), [Cremit — NHI $340M+](https://www.cremit.io/reports/rsac-2026-nhi), [Linux Foundation — A2A 150+ orgs](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year), [Grand View — AI agents market](https://www.grandviewresearch.com/industry-analysis/ai-agents-market-report)
- Pricing / recurring-revenue benchmarks: [Culta — UBP & NRR](https://culta.ai/blog/usage-based-pricing-saas), [Schematic — usage-based billing](https://schematichq.com/blog/why-usage-based-billing-is-taking-over-saas)
- Comparable agentic-identity pricing: [WorkOS — agentic identity / pricing](https://workos.com/blog/descope-vs-workos-agentic-identity-enterprise-authentication)
