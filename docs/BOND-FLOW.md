# The Bond Flow — canonical UX specification

**Status:** v1 — implemented in pactd's built-in web UI (0.15.0).
**Audience:** anyone building a Pact surface (web UI, mobile app, dashboard,
voice agent, game). This document is the portable contract: implement this
flow against the pactd HTTP API and your surface behaves like every other
Pact surface.

The protocol underneath (MATE.md, NIP-BD, gift wrap) is deliberately
technical. The flow on top must not be. The measure of success: **two
non-technical people, each running a Pact node (Umbrel, Start9, anything),
can form a mutual private bond in under a minute without seeing a bond id,
a state name, or the word "npub".**

---

## 1. The three moves

Everything reduces to three moves. Each move is one screen action for one
person.

```
   ALICE                                    BOB
   ─────                                    ───
1  SHARE    copies her bond address  ──────▶ (receives it over any channel:
            (one tap)                         chat, email, in person)

2                                            PROPOSE  pastes Alice's address,
                                  ◀──────    picks private/public + a kind,
                                             one tap "Propose bond"

3  ACCEPT   sees the proposal in her
            inbox, one tap "Accept"  ──────▶ both sides now show
                                             ● Mutual · active
```

**Rules that make this work:**

- The **bond address** (the agent's npub) is the ONLY artifact humans
  exchange, and the exchange happens out-of-band (any messenger). It is
  shareable like a Lightning address: public, low-stakes, reusable.
- **Bond ids never surface.** The daemon auto-generates them
  (`urn:mate:<uuid>`) and the accept flow echoes them. UIs may show a bond
  id in an expandable "details" affordance, never in the primary flow.
- **States never surface as state-machine vocabulary.** See the wording
  table (§4). A user sees "Waiting for them", not `proposed`.
- **The channel echoes automatically.** Accepting a private proposal
  produces a private accept; the accepter is not asked. (Surfaces MAY offer
  an advanced override — see §5.)
- **No step requires the two nodes to be online simultaneously.** Relays
  hold everything; the inbox is poll/stream-based.

## 2. Screen inventory

A conforming surface has four regions. They can be cards on one page
(pactd's UI), tabs, or screens — the regions and their priority order are
the contract, not the layout.

### 2.1 Identity ("Your bond address")

- Shows the npub, rendered as the agent's shareable address.
- **Primary action: Copy.** (Optional enhancements: QR code, NIP-05-style
  display name once supported.)
- If no identity exists: a single "Create identity" action and nothing else
  — the other regions are inert until this exists.

### 2.2 Inbox ("Needs your response")

- Inbound proposals: bonds authored by someone else, p-tagging this
  identity, for which this identity has not yet published its own side.
- Each row: counterparty address (shortened), kind, privacy marker,
  relative time.
- **Primary action: Accept. Secondary: Decline.**
- This region appears ABOVE the bond list when non-empty, and disappears
  when empty. It is the highest-priority region after identity creation —
  an unanswered proposal is the one thing that needs a human.

### 2.3 Form a bond ("Propose")

Three inputs, one button:

1. **Their bond address** — text input. Accepts `npub1…`, `did:nostr:…`,
   or 64-hex; validate client-side or on first API error. Reject the
   node's own address with a friendly message.
2. **Privacy** — a two-way choice, **default Private**:
   - **Private** (default): "Only the two of you can see this bond exists."
   - **Public**: "Anyone can look it up — useful when the relationship
     itself is a credential."
   The default is private because the protocol's premise is consent: going
   public is the act that needs a deliberate choice, not privacy.
3. **Kind** — what the relationship is. Offer the conventional kinds
   (`companion`, `collaboration`, `team`, `guardian`) plus free text.
   Default `companion`.

Button: **Propose bond**. On success show "Proposal sent — waiting for
them to accept" and surface it in the bond list as outgoing/pending.

### 2.4 Bonds (the list)

Bonds **grouped by bond id** (one row per relationship, never one row per
side/event). Each row shows:

- counterparty address (shortened, copy on tap), kind
- privacy marker (e.g. a lock) for private bonds
- a single human status (wording table, §4) + mutual badge when both sides
  are active
- a validity indicator only when something is WRONG (a failed signature is
  shown; a valid one is silent — checkmarks everywhere train people to
  ignore them)

Row actions by situation (§3): Withdraw (my pending proposal), Accept /
Decline (their pending proposal — same actions as Inbox), End (mutual or
active bond), Resume/Pause where supported. Destructive actions
(End/Decline/Withdraw) take one confirmation, never more.

## 3. Situations → actions matrix

A bond's *situation* is computed from the pair of sides (mine, theirs),
where "mine" is the side authored by this identity. This mapping is the
core client-side logic and MUST be consistent across surfaces:

| Situation | Computed from | Show status | Actions |
|---|---|---|---|
| **Incoming proposal** | theirs=`proposed`, mine=absent | "They want to bond" | Accept, Decline |
| **Outgoing proposal** | mine=`proposed`, theirs=absent | "Waiting for them" | Withdraw |
| **Mutual** | both sides `accepted`/`active` | "● Mutual" (+kind) | End, (Pause) |
| **One-sided active** | mine=`active`/`accepted`, theirs=`proposed` | "Waiting for them" | End |
| **They ended it** | theirs=`revoked`/`rejected` | "Ended by them" | Archive/dismiss |
| **I ended it** | mine=`revoked`/`withdrawn`/`rejected` | "Ended" | Archive/dismiss |
| **Paused** | either side `paused` | "Paused" | Resume, End |

Effective state is the *minimum* of the two sides along the lifecycle
(NIP-BD "Mutual bonds") — a surface never shows "Mutual" unless both sides
have published acceptance/activation.

## 4. Wording

Protocol vocabulary stays in the protocol. The contract wording (English
reference; translate freely, keep register):

| Protocol | Humans see |
|---|---|
| npub / did:nostr | **bond address** |
| `proposed` (inbound) | "**They want to bond**" / "Proposal from …" |
| `proposed` (outbound) | "**Waiting for them**" |
| `accepted` / `active` (both) | "**Mutual**" |
| `paused` | "Paused" |
| `revoked` | "Ended" |
| `rejected` | "Declined" |
| `withdrawn` | "Withdrawn" |
| `expired` | "Expired" |
| private visibility | "**Private** — only the two of you can see this bond exists" |
| public visibility | "**Public** — anyone can look this bond up" |
| accept action | "Accept" |
| reject action | "Decline" |
| revoke action | "End bond" |
| withdraw action | "Withdraw" |

Never show: bond ids (except inside "details"), event ids, kind numbers,
"gift wrap", "rumor", "NIP"-anything, hex keys (npub form only).

## 5. API mapping

Everything above maps onto five pactd endpoints — this is the entire
integration surface:

| Flow step | Call |
|---|---|
| Create identity | `POST /identity` |
| Your bond address | `GET /identity` → `npub` |
| Propose | `POST /bonds` `{ counterparty, kind, private }` (no bondId, no state — defaults do the right thing) |
| Inbox + list | `GET /bonds` (mine + private inbox) **and** `GET /bonds?counterparty=<my npub>` (toward me); merge, group by `bond` |
| Accept | `POST /bonds/accept` `{ bondId }` (echoes the channel automatically) |
| Decline | `POST /bonds/accept` `{ bondId, state: "rejected" }` |
| Withdraw / End / Pause / Resume | `POST /bonds` `{ counterparty, bondId, state: "withdrawn"\|"revoked"\|"paused"\|"active", private: <same as the bond> }` |
| Live updates | poll the two GETs, or `GET /events` (SSE) |

Notes:

- Lifecycle updates MUST reuse the existing `bondId` and MUST publish on
  the bond's existing channel (pass `private: true` for a private bond) —
  a surface that drops the privacy flag on revoke leaks the relationship.
- The channel-override on accept (`visibility` in the accept body) is an
  advanced affordance; if offered at all, hide it behind "details" with
  copy explaining that taking a private proposal public exposes the
  relationship.

## 6. Errors (the only ones users should meet)

| Condition | Message shape |
|---|---|
| Bad address pasted | "That doesn't look like a bond address (npub…)." |
| Own address pasted | "That's this node's own address." |
| No identity yet | inert regions + "Create identity" |
| 0 relays accepted a publish | "Couldn't reach any relay — check the Relays card." |
| Accept can't find the proposal | "Couldn't find that proposal on your relays — ask them to re-send, or check Relays." |
| Daemon unreachable / 401 | surface-specific (pactd UI: unlock flow) |

Partial relay acceptance (≥1 accepted) is success; surfaces MAY show a
quiet "delivered to n/m relays" detail, never a scary warning.

## 7. Future extensions (kept out of v1 deliberately)

- **QR / deep link** for the address exchange (`pact:bond?to=<npub>` URI
  scheme — would collapse Share+Propose into scan).
- **Petnames**: local labels for counterparty addresses (purely local;
  never published).
- **Profile names** via kind:0 / NIP-05 lookup (display only, verified
  marker only with NIP-39 proof).
- **Paid affordances**: the verify-disclosure market (402 flow) and
  staking, as separate cards — they extend the bond row, not the flow.
- **Reaffirmation**: a "still us" tap on mutual bonds publishing
  `bond.reaffirmed` history — the heartbeat that makes longevity legible.

The three moves do not change as these arrive.
