// Private bond runtime: resolve and authenticate gift-wrapped bonds.
//
// The wire mechanism (NIP-44, NIP-59, embedded-proof rule) is L1
// (@mate-protocol/core, extension §13); this module is the L2 runtime view —
// turning an encrypted inbox into the same BondView shape the public path
// produces, so daemons and SDKs can treat both transports uniformly.

import {
  KIND_BOND_STATE,
  KIND_GIFT_WRAP,
  keypairFromSecret,
  pubkeyHexFromIdentity,
  selectBondRumors,
  verifyProof,
  type MateDocument,
  type NostrEvent,
  type PrivateBondRumor,
  type RelayFilter,
} from '@mate-protocol/core';

import { kindFromContent } from './bond.js';
import type { BondView } from './index.js';
import { latestPerKey } from './mutual.js';

/** Wraps requested per page when reading an inbox (a relay may cap it lower). */
const INBOX_PAGE = 200;
/** Upper bound on pages read per relay, so a flood can't hang a read. */
const INBOX_MAX_PAGES = 50;
/** Per-page relay timeout. */
const PAGE_TIMEOUT_MS = 8000;

interface PageResult {
  /** The socket opened. */
  reached: boolean;
  events: NostrEvent[];
  /** The relay said EOSE: it has sent everything it will for this filter. */
  eose: boolean;
  /** The relay answered CLOSED (rate limit, auth, error) instead of finishing. */
  closed?: string;
}

/**
 * One NIP-01 REQ against one relay, reporting HOW it ended. resolveEvents from
 * @mate-protocol/core returns whatever arrived before EOSE, a timeout, a
 * socket error, or a CLOSED alike — fine for a best-effort lookup, but a
 * paging reader must not mistake "the relay stopped answering" for "history
 * ends here". Only a page ending in EOSE is a complete page.
 */
function queryPage(relay: string, filter: RelayFilter, timeoutMs = PAGE_TIMEOUT_MS): Promise<PageResult> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    const subId = `pact-inbox-${Math.random().toString(36).slice(2, 10)}`;
    let reached = false;
    let settled = false;
    let ws: WebSocket;
    const finish = (eose: boolean, closed?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (eose && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(['CLOSE', subId]));
        ws.close();
      } catch {
        // ignore
      }
      resolve({ reached, events, eose, ...(closed === undefined ? {} : { closed }) });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      ws = new WebSocket(relay);
    } catch {
      clearTimeout(timer);
      resolve({ reached: false, events, eose: false });
      return;
    }
    ws.addEventListener('open', () => {
      reached = true;
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });
    ws.addEventListener('error', () => finish(false));
    ws.addEventListener('close', () => finish(false));
    ws.addEventListener('message', (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg) || msg[1] !== subId) return;
      if (msg[0] === 'EVENT' && msg[2]) events.push(msg[2] as NostrEvent);
      else if (msg[0] === 'EOSE') finish(true);
      else if (msg[0] === 'CLOSED') finish(false, String(msg[2] ?? ''));
    });
  });
}

/**
 * Fetch every kind:1059 gift wrap addressed to `secret`'s key, paging backwards
 * with `until` cursors. One fixed window is not enough: the inbox is
 * public-write and shared with NIP-17 DMs, and NIP-59 backdates wraps by up to
 * two days, so a single page of the newest wraps can push a real proposal out.
 *
 * `truncated` is set whenever some relay's history could not be read to the
 * end. Consumers must then treat the inbox as incomplete — a withdrawal may be
 * hiding in what was not read — rather than act on what they got.
 */
export async function fetchInbox(
  secret: Uint8Array,
  relays: string[],
): Promise<{ relaysReached: string[]; events: NostrEvent[]; truncated: boolean; inboxRelaysUnread: string[] }> {
  const selfHex = keypairFromSecret(secret).pubkeyHex;
  const byId = new Map<string, NostrEvent>();
  const reached = new Set<string>();
  let truncated = false;
  // One cursor PER relay. A shared cursor takes the minimum created_at across
  // relays, so a relay whose first page only covered the last few minutes
  // would be asked for `until = <weeks ago>` next and everything in between
  // would never be read. The inbox is public-write, so that skew can be
  // arranged on purpose (fresh junk on one relay, backdated junk on another)
  // to hide a withdrawal. Each relay pages down its own history.
  await Promise.all(
    relays.map(async (relay) => {
      let until: number | undefined;
      // Set after a page made entirely of the cursor's second was stepped past.
      let steppedPastSecond = false;
      for (let page = 0; page < INBOX_MAX_PAGES; page++) {
        const filter = {
          kinds: [KIND_GIFT_WRAP],
          '#p': [selfHex],
          limit: INBOX_PAGE,
          ...(until === undefined ? {} : { until }),
        } as RelayFilter;
        const res = await queryPage(relay, filter);
        if (!res.reached) {
          // Down from the start: not reached, which relaysReached reports.
          // Down partway through: what it already served is partial history.
          if (page > 0) truncated = true;
          return;
        }
        if (!res.eose && page === 0 && res.events.length === 0) {
          // The relay refused or failed to serve the inbox at all (NIP-42
          // `auth-required` CLOSED — relay.damus.io does this for every #p
          // kind:1059 REQ — a rate limit on the first page, a dropped
          // socket). It contributed nothing, so it cannot have made the
          // result partial: treat it exactly like an unreachable relay, which
          // relaysReached reports. Flagging it would mark every inbox read on
          // the default relay set incomplete and push operators to the
          // allowIncompleteInbox override as a matter of routine.
          // TODO(NIP-42): answer the AUTH challenge with a kind:22242 signed by
          // the inbox key and re-send the REQ; damus then serves the inbox to
          // its recipient, which is the NIP-17 design.
          return;
        }
        reached.add(relay);
        let oldest = Infinity;
        for (const event of res.events) {
          if (!byId.has(event.id)) byId.set(event.id, event);
          oldest = Math.min(oldest, event.created_at);
        }
        // A page that ended without EOSE (timeout, dropped socket) or with
        // CLOSED (rate limit) after serving part of the history says nothing
        // about what lies below it.
        if (!res.eose) {
          truncated = true;
          return;
        }
        // Only an empty page proves this relay's history is exhausted. A short
        // page does not: relays may cap `limit` below what we ask for.
        if (!Number.isFinite(oldest)) return;
        if (steppedPastSecond) {
          // Older history exists below a page that was all one second. An
          // uncapped relay would have served it in that page, so the relay
          // capped it: that second was served at the cap and may hold more.
          truncated = true;
          steppedPastSecond = false;
        }
        if (until !== undefined && oldest >= until) {
          // Nothing older than the cursor (`until` is inclusive, so its second
          // is re-read). Either history ends here, or the page is saturated by
          // that one second and the cursor cannot advance through it. Step
          // past the second to find out: a full page is flagged now, a short
          // one only if older history turns up (see above).
          if (res.events.length >= INBOX_PAGE) truncated = true;
          else steppedPastSecond = true;
          until = oldest - 1;
          continue;
        }
        until = oldest;
      }
      // Page budget exhausted with history still coming.
      truncated = true;
    }),
  );
  // Relays that were asked but never served the inbox (down, or refusing it,
  // e.g. NIP-42 auth-required). Reported by name because a surface that unions
  // public and private reach would otherwise list such a relay as "reached"
  // when its inbox was never read. If NO relay served the inbox, nothing was
  // read at all: that is an incomplete read, not an empty inbox.
  const inboxRelaysUnread = relays.filter((r) => !reached.has(r));
  if (relays.length > 0 && reached.size === 0) truncated = true;
  return { relaysReached: [...reached], events: [...byId.values()], truncated, inboxRelaysUnread };
}

export interface PrivateBondFilter {
  /** Match a specific bond id (post-decryption — wraps carry no bond tags). */
  bondId?: string;
  /** Match rumors authored by this identity. */
  author?: string;
  /** Match rumors p-tagging this identity. */
  counterparty?: string;
}

/**
 * Authenticate a private bond rumor end-to-end and project it as a BondView.
 *
 * `signature_valid` for a private bond means the full chain held:
 * seal signature (checked during unwrap) → seal/rumor author match → embedded
 * document proof verifies → document subject is the authenticated author.
 * Public bonds get the same flag from the event signature alone; the embedded
 * proof is what survives disclosure, so it is what we verify here.
 */
export function toBondView(r: PrivateBondRumor): BondView | null {
  let proofValid = false;
  try {
    const doc = JSON.parse(r.rumor.content) as MateDocument;
    const proofs = doc.proofs ?? [];
    proofValid =
      proofs.length > 0 &&
      // Every proof verifies AND is made by the authenticated author's key
      // (verifyProof checks the signature, not who the verificationMethod is).
      proofs.every((proof) => verifyProof(doc, proof) && pubkeyHexFromIdentity(proof.verificationMethod) === r.author) &&
      pubkeyHexFromIdentity(doc.subject.id) === r.author;
    if (proofValid) {
      // Once the embedded document verifies it is authoritative — the view is
      // filed under the DOCUMENT's bond/counterparty/state. The d tag is the
      // rumor's FILE KEY: a d tag naming a different bond id than the sealed
      // document is an attempt to inject the seal into another bond's context
      // (the tampered-transport attack) — drop it entirely. A mere state or
      // counterparty mismatch stays visible but flagged invalid (below): the
      // honest transport carried a doc that outranks its own tags.
      if (doc.bond.id !== r.bond) {
        return null;
      }
      // d agrees; a state or counterparty mismatch still means the sealed doc
      // outranks its own tags — file under the tags (what the verdict counts)
      // but flag invalid: the disclosure proves something other than what was
      // counted.
      const counterparty = pubkeyHexFromIdentity(doc.object.id);
      const state = String(doc.bond.state);
      const agrees = counterparty === r.counterparty && state === r.state;
      return {
        id: r.rumor.id,
        author: r.author,
        bond: r.bond,
        counterparty: r.counterparty,
        state: r.state,
        kind: kindFromContent(r.rumor.content),
        created_at: r.rumor.created_at,
        signature_valid: agrees,
        visibility: 'private',
      };
    }
  } catch {
    proofValid = false;
  }
  return {
    id: r.rumor.id,
    author: r.author,
    bond: r.bond,
    counterparty: r.counterparty,
    state: r.state,
    kind: kindFromContent(r.rumor.content),
    created_at: r.rumor.created_at,
    signature_valid: false,
    visibility: 'private',
  };
}

/**
 * Resolve this identity's private bond inbox: fetch kind:1059 gift wraps
 * addressed to the key, unwrap + authenticate each, and project bond rumors
 * to BondViews. Wraps that fail any check are skipped (inboxes are
 * public-write), and only the latest rumor per (author, bond) survives —
 * kind:1059 is a regular kind, so the client performs the replaceable
 * reduction the relay does for public kind:30317.
 */
export async function listPrivateBonds(
  secret: Uint8Array,
  relays: string[],
  filter: PrivateBondFilter = {},
): Promise<{ relaysReached: string[]; bonds: BondView[]; truncated: boolean; inboxRelaysUnread: string[] }> {
  const { events, relaysReached, truncated, inboxRelaysUnread } = await fetchInbox(secret, relays);
  return { relaysReached, truncated, inboxRelaysUnread, bonds: privateBondViews(events, secret, filter) };
}

/**
 * The bond-state views in an already-fetched inbox (see listPrivateBonds), so
 * a caller that also needs the raw wraps reads the inbox once.
 */
export function privateBondViews(events: NostrEvent[], secret: Uint8Array, filter: PrivateBondFilter = {}): BondView[] {
  return bondViewsFromRumors(selectBondRumors(events, secret), filter);
}

/** As privateBondViews, from rumors already unwrapped (so one inbox is unwrapped once). */
export function bondViewsFromRumors(rumors: PrivateBondRumor[], filter: PrivateBondFilter = {}): BondView[] {
  const authorHex = filter.author ? pubkeyHexFromIdentity(filter.author) : null;
  const counterpartyHex = filter.counterparty ? pubkeyHexFromIdentity(filter.counterparty) : null;

  const views: BondView[] = [];
  for (const rumor of rumors) {
    // State views come from kind:30317 rumors only; kind:1317 lifecycle rumors
    // (reaffirmations etc.) are resolved separately by listReaffirmations.
    if (rumor.rumor.kind !== KIND_BOND_STATE) continue;
    if (filter.bondId && rumor.bond !== filter.bondId) continue;
    if (authorHex && rumor.author !== authorHex) continue;
    if (counterpartyHex && rumor.counterparty !== counterpartyHex) continue;
    const view = toBondView(rumor);
    if (view) views.push(view);
  }

  // kind:1059 is a regular kind, so perform the replaceable reduction the relay
  // does for public kind:30317: latest per (author, bond).
  return latestPerKey(views, (v) => `${v.author}:${v.bond ?? v.id}`).sort((a, b) => b.created_at - a.created_at);
}
