# Pact — Layered Incentive Markets (the flywheel)

*Status: draft v0.1, 2026-06-07. The economic design pillar. Read alongside [IDEA.md](IDEA.md) (thesis) and [ARCHITECTURE.md](ARCHITECTURE.md) (system).* 

---

## 0. The principle

Bitcoin sustains itself not because of cryptography but because **every layer has a market**, and self-interested action at each layer produces the work the whole system needs. Miners secure the chain for block rewards and fees; routing nodes provide liquidity for channel fees; developers improve the protocol for grants and reputation; traders provide price discovery for spreads. No central coordinator schedules any of it. **The markets are the flywheel.**

The underlying idea is older than Bitcoin: *human action* is purposeful and incentive-driven. A system stays alive only if, at every layer, there is a **productive tension** — a scarce resource people compete for — that makes action rewarding and inaction costly. Remove the tension and the layer goes inert.

**Pact is designed this way on purpose.** It is not an open-core SaaS with a protocol attached. It is a set of **sats-native incentive markets**, one at every layer of the agent-relationship stack, where the activity that strengthens the network is the same activity that pays the participants who provide it.

### Three commitments this implies

1. **Sats-native, Lightning-settled, no token.** Every market settles in Bitcoin over Lightning (leveraging lnflash). There is **no Pact token** — a token would be gameable, off-brand for this audience, and unnecessary. Value flows in sats; Pact captures protocol fees/take-rate, not seigniorage.
2. **Permissionless markets; Pact is a steward and participant, not a gatekeeper.** Anyone can run a relay, a verifier, a matcher, or stake on a bond and earn. Pact earns by being the most-trusted operator and the protocol steward — the flywheel keeps turning even if Pact is just one node. (This is what keeps the sovereignty promise honest.)
3. **"Bond" made literal.** A relationship bond can carry **economic weight** — staked collateral, escrow, surety — so trust has skin in the game. The financial meaning of *bond* (a surety instrument) and the relational meaning (a connection) fuse.

---

## 1. Bitcoin → Pact (the mapping)

| Bitcoin layer | Tension (scarce resource) | Who acts, and why | Pact analog |
|---|---|---|---|
| Mining | block space / security | miners earn reward + fees | **Relay/storage market** — operators earn sats for durable, available bond history |
| Lightning | inbound liquidity / routing | routing nodes earn fees | **Verification & matching markets** — nodes earn fees for verifying bonds and brokering good matches |
| Protocol dev | maintenance / improvement | devs earn grants + reputation | **Protocol-dev market** — grants/bounties (OpenSats model), funded partly by protocol fees |
| Asset trading | price discovery / liquidity | traders earn spreads | **Reputation & bonding market** — stakers earn for backing relationships that last, slashed when they defect |

---

## 2. The markets, layer by layer

Each layer is a market with a tension, actors, a fee, and a flywheel.

### 2.1 Storage / relay market
- **Tension:** durable, available bond history is scarce (storage + bandwidth + uptime).
- **Actors:** relay operators (incl. `relay.islandbitcoin.com`, community relays, Pact-managed).
- **Fee:** sats per store / serve / retention tier (a paid-relay model, already native to Nostr).
- **Flywheel:** more bonds → more demand for durable serving → more operators & capacity → more reliable history → more bonds.

### 2.2 Verification market
- **Tension:** third parties (registries, wallets, bureaus, payment rails) need to verify a bond but don't run the engine.
- **Actors:** verifier nodes (anyone can run one).
- **Fee:** pay-per-verify, sats. Bond-as-VC verification on demand.
- **Flywheel:** more bonds in circulation → more external parties needing to verify → more verifier demand → more places a bond is *useful* → more bonds.

### 2.3 Matchmaking / discovery market
- **Tension:** finding the *right* counterparty is scarce (attention + fit), and being found is valuable.
- **Actors:** competing matcher nodes; agents seeking partners; agents wanting discoverability.
- **Fee:** introduction fee / priority placement / boost — sats. Permissionless: matchers compete on match quality (which intros *lasted*).
- **Flywheel:** more bonds + outcomes → better matching signal → better matches → more activity → more bonds. (The data loop from IDEA §7, now a market.)

### 2.4 Reputation & bonding (surety) market — *the keystone*
- **Tension:** trust is scarce and, without stake, cheap to fake.
- **Actors:** agents and humans who **stake sats** to back a bond or vouch for an agent; counterparties who require collateral before relying on one.
- **Mechanism:** a bond can reference **escrowed/staked collateral**. Stakers earn yield when the relationship performs and are **slashed on defection** — an underwriting/insurance market for agent relationships. Reputation becomes *economically backed*, not just a number.
- **Flywheel:** staking makes bonds trustworthy → trustworthy bonds get used for higher-value work → higher-value work demands more bonding → more staking. This is where "bond" the relationship and "bond" the surety become one instrument.

### 2.5 Agent labor market — *the top of the stack*
- **Tension:** agents need to hire *trusted* agents; trust gates value.
- **Actors:** agents transacting services with each other (and with humans), **paying in sats over the bond as the trust rail**.
- **Fee:** thin protocol fee on agent-to-agent commerce conducted over bonds.
- **Flywheel:** the bond graph becomes the trust substrate for an **agent economy**; every paid interaction uses and strengthens a bond, which feeds reputation/matching/bonding below it.

### 2.6 Protocol-development market
- **Tension:** the protocol (MATE.md / NIP-BD / Pact) needs ongoing work.
- **Actors:** developers.
- **Funding:** grants, bounties, sponsorships (OpenSats-style), optionally funded by a sliver of protocol fees — plus the reputation that comes from stewarding an adopted standard.
- **Flywheel:** funded dev → better protocol → more adoption → more fees → more dev funding.

---

## 3. The flywheel

```
        ┌───────────────────────────────────────────────┐
        │                                               ▼
   more activity ──▶ more fees ──▶ more participants & capacity
        ▲           (sats)        (relays, verifiers, matchers,
        │                          stakers, devs, agents)
        │                                   │
        └──────── better service, deeper ◀──┘
                  liquidity, richer graph,
                  more trustworthy bonds
```

Two reinforcing loops: the **fee loop** (activity pays participants who add capacity that enables more activity) and the **graph loop** (every bond deepens reputation/matching/bonding, which makes the upper markets more valuable, which drives more bonds). Both are powered by sats, both run without a central operator.

---

## 4. Where Pact (the company) captures value

Without gatekeeping — capture is by *participation and stewardship*, not lock-in:

- **Protocol fees / take-rate** on the markets Pact facilitates (matching, verification, bonding/escrow, agent-commerce settlement).
- **Premier nodes** — run the most reliable relays, verifiers, and matchers; earn fees by being best, in open competition.
- **Managed convenience + enterprise** — the SaaS surface (hosted scale, dashboard, compliance) for those who don't want to run nodes.
- **Lightning rails** — settlement infrastructure (lnflash synergy) underneath all of it.

The point: Pact's revenue scales with **network activity**, not seat count — and survives even as a minority participant, because the markets are the product.

---

## 5. Why this beats open-core SaaS alone

- **Self-sustaining** (a flywheel) vs. linear, sales-driven growth.
- **Sovereign / permissionless** — markets, not a gatekept API; fits the beachhead's values exactly.
- **Sats-native** — leverages Bitcoin/Lightning distribution and lnflash; the audience already lives here.
- **Value capture tracks activity**, so it compounds with the bond graph rather than with headcount.

(Open-core SaaS isn't discarded — it's *one* capture surface among several, for the users who want managed convenience.)

---

## 6. Design implications (feeding back into ARCHITECTURE)

- **Lightning is a first-class component**, not an add-on: every node type (relay, verifier, matcher) exposes a payment interface; the SDK/daemon can pay and get paid in sats (LN/lnflash, ideally non-custodial).
- **Bonds carry optional economic references** — escrow/collateral/stake pointers in the bond's `extensions`, settled and slashed via Lightning/contracts off the critical path of L1 (which stays pure mechanism).
- **Each market is an open protocol** (relay-fee, verify-fee, match-fee, bonding) so participation is permissionless and federatable — never a Pact-only API.
- **No protocol change to L1.** All incentive mechanics live in L2 and in `extensions`; MATE.md stays a neutral, fee-agnostic standard.

---

## 7. Risks & honest tensions

- **Marketplace cold-start (chicken-and-egg liquidity at each layer).** → Pact bootstraps each market as the first/anchor participant; subsidize early supply; the free SDK/infra seeds the bond supply that the upper markets need.
- **Over-financialization of relationships** (gameable reputation, pay-to-win matching). → Design fee markets that reward genuine *fit and longevity* (outcomes), not raw spend; slashing aligns stake with honesty; keep a free, unstaked tier so trust isn't strictly pay-to-play.
- **Regulatory surface** (staking, escrow, surety, payments can look like money transmission / insurance / securities). → Keep settlement **non-custodial Lightning** where possible; sats-native; be careful with the "insurance/yield" framing; jurisdiction-aware; this is a real area to get counsel on before shipping the bonding market.
- **Don't let markets compromise sovereignty.** → Every market must be runnable by anyone; Pact's nodes compete, they don't gate. If a market can only run through Pact, it's mis-designed.

---

## 8. The one-line version

**Bitcoin keeps moving because every layer pays someone to do the work that layer needs. Pact applies the same law to agent relationships: sats-native, permissionless markets at every layer — storage, verification, matching, bonding, agent-labor, and protocol dev — so the activity that strengthens the bond graph is the same activity that pays the people and agents who sustain it.**
