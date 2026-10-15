// Discovery: publish bond intents and browse the open board.
//
// The board is permissionless, so ranking is the reader's defense: candidates
// are scored by their PUBLIC longevity record — distinct MUTUAL bonds,
// reaffirmations of those bonds, and their age. Every input needs a second key
// to have signed it too (one-sided bonds, reaffirmations of made-up bonds and
// self-backdated timestamps count for nothing), so a lone fresh key scores
// zero. Colluding key pairs can still build a record together: this raises the
// cost of gaming the board, it does not make it impossible. Private bonds never
// contribute to (or leak into) discovery; that is the §2.7 barbell working as
// designed.

import {
  KIND_BOND_HISTORY,
  KIND_BOND_INTENT,
  SEEK_KIND_PREFIX,
  SEEK_TAG,
  buildBondIntentEvent,
  keypairFromSecret,
  parseBondIntent,
  publishEvent,
  resolveEvents,
  verifyEvent,
  type BondIntent,
  type PublishResult,
} from '@mate-protocol/core';

import { DEFAULT_RELAYS } from '@mate-protocol/core';
import type { BondView } from './index.js';
import { listBonds } from './index.js';
import { findMutualPair } from './mutual.js';
import { REAFFIRM_TYPE } from './reaffirm.js';

export interface PublishIntentInput extends BondIntent {
  relays?: string[];
}

export interface PublishIntentResult {
  status: 'open' | 'closed';
  seeking: string[];
  event: { id: string; relays: PublishResult[] };
}

/** Publish (or update) this identity's bond intent — the act of becoming findable. */
export async function publishIntent(secret: Uint8Array, input: PublishIntentInput): Promise<PublishIntentResult> {
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  // Intents are addressable: a relay keeps the newest per author and breaks a
  // same-second tie by lowest id, so an unlist issued in the same second as the
  // open it replaces could silently lose. Always stamp strictly after the
  // current intent.
  const current = await myIntent(secret, relays).catch(() => null);
  const now = Math.floor(Date.now() / 1000);
  const createdAt = current ? Math.max(now, current.created_at + 1) : now;
  const event = buildBondIntentEvent(
    { seeking: input.seeking, about: input.about, profile: input.profile, status: input.status },
    secret,
    { createdAt },
  );
  return {
    status: input.status ?? 'open',
    seeking: input.seeking,
    event: { id: event.id, relays: await publishEvent(relays, event) },
  };
}

/** Unlist this identity from discovery (intent stays addressable, status closed). */
export function closeIntent(secret: Uint8Array, relays?: string[]): Promise<PublishIntentResult> {
  return publishIntent(secret, { seeking: [], status: 'closed', relays });
}

export interface LongevityRecord {
  /** Distinct public bonds this identity is in that are mutual (both parties signed). */
  bonds: number;
  /** Its public reaffirmations of those mutual bonds, at most one per bond per day. */
  reaffirmations: number;
  /**
   * Age in days of its oldest mutual bond, measured from the LATER of the two
   * sides' timestamps — backdating needs the counterparty to backdate too
   * (0 when none).
   */
  oldestBondDays: number;
}

export interface Candidate {
  author: string;
  seeking: string[];
  about?: string;
  profile?: string;
  intentAt: number;
  record: LongevityRecord;
  /** Transparent ranking score — see scoreOf. */
  score: number;
}

/**
 * score = bonds·2 + reaffirmations·3 + ln(1 + oldestBondDays)
 *
 * Reaffirmations weigh heaviest — repeated choice over time, counted only on
 * mutual bonds and at most once a day, is the costliest signal to mint. The
 * formula is deliberately simple and public: ranking must be auditable, or
 * discovery becomes an algorithm to lobby.
 */
export function scoreOf(record: LongevityRecord): number {
  return record.bonds * 2 + record.reaffirmations * 3 + Math.log(1 + record.oldestBondDays);
}

export interface DiscoverOptions {
  /** Only intents seeking this bond kind (e.g. "companion"). */
  kind?: string;
  limit?: number;
}

/**
 * Browse the open board: resolve open intents from these relays, verify each,
 * and rank by the authors' public longevity records. Excludes `selfHex` (a
 * node should not discover itself).
 */
export async function discover(
  relays: string[] = DEFAULT_RELAYS,
  options: DiscoverOptions = {},
  selfHex?: string,
): Promise<{ relaysReached: string[]; candidates: Candidate[] }> {
  const filter: Record<string, unknown> = {
    kinds: [KIND_BOND_INTENT],
    '#t': [options.kind ? SEEK_KIND_PREFIX + options.kind : SEEK_TAG],
    limit: Math.min(200, options.limit ?? 50),
  };
  const { events, relaysReached } = await resolveEvents(relays, filter as never);
  const reached = new Set(relaysReached);

  // Newest valid intent per author FIRST, then drop the closed ones. Filtering
  // before reducing would let a stale open intent on a relay the close never
  // reached re-list a node that unlisted.
  const newest = new Map<string, NonNullable<ReturnType<typeof parseBondIntent>>>();
  const consider = (event: (typeof events)[number]) => {
    if (!verifyEvent(event)) return;
    const parsed = parseBondIntent(event);
    if (!parsed) return;
    const prior = newest.get(parsed.author);
    if (!prior || parsed.created_at > prior.created_at) newest.set(parsed.author, parsed);
  };
  events.forEach(consider);

  // A `seek:<kind>` query never returns closed intents (they carry no seek
  // tags), and a per-kind or limited query may miss an author's newer intent.
  // Re-read every candidate's intents by the generic tag so a newer close can
  // veto the stale open one.
  const candidatesSoFar = [...newest.keys()];
  if (candidatesSoFar.length > 0) {
    const veto = await resolveEvents(relays, {
      kinds: [KIND_BOND_INTENT],
      authors: candidatesSoFar,
      '#t': [SEEK_TAG],
      limit: candidatesSoFar.length * 4,
    } as never);
    veto.events.forEach(consider);
    veto.relaysReached.forEach((r) => reached.add(r));
  }

  const intents = new Map<string, NonNullable<ReturnType<typeof parseBondIntent>>>();
  for (const [author, intent] of newest) {
    if (intent.status !== 'open') continue;
    if (selfHex && author === selfHex) continue;
    if (options.kind && !intent.seeking.includes(options.kind)) continue;
    intents.set(author, intent);
  }

  const authors = [...intents.keys()];
  const records = new Map<string, LongevityRecord>();
  // Per-author queries (bounded concurrency): one prolific author can't use
  // up a shared result limit and zero everyone else's record.
  await mapLimit(authors, 6, async (author) => {
    records.set(author, await longevityRecord(author, relays, reached));
  });

  const candidates = [...intents.values()]
    .map((i) => {
      const record = records.get(i.author) ?? { bonds: 0, reaffirmations: 0, oldestBondDays: 0 };
      return {
        author: i.author,
        seeking: i.seeking,
        about: i.about,
        profile: i.profile,
        intentAt: i.created_at,
        record,
        score: scoreOf(record),
      };
    })
    .sort((a, b) => b.score - a.score || b.intentAt - a.intentAt);

  return { relaysReached: [...reached], candidates };
}

/** Max public bonds examined per candidate. */
const RECORD_BOND_LIMIT = 100;

/**
 * One author's public longevity record, counting only what a second key also
 * signed: bonds that are mutual by findMutualPair, reaffirmations of those
 * bonds (one per bond per UTC day), and age from the later of the two sides.
 */
async function longevityRecord(author: string, relays: string[], reached: Set<string>): Promise<LongevityRecord> {
  const own = await listBonds({ authors: [author], limit: RECORD_BOND_LIMIT }, relays);
  own.relaysReached.forEach((r) => reached.add(r));
  const ownSides = own.bonds.filter((b) => b.signature_valid && b.bond && b.counterparty && b.counterparty !== author);
  if (ownSides.length === 0) return { bonds: 0, reaffirmations: 0, oldestBondDays: 0 };

  // The counterparties' sides for exactly these bond ids. Addressable events
  // are one per (author, d), so the result is bounded by authors × ids.
  const ids = [...new Set(ownSides.map((b) => b.bond as string))];
  const counterparties = [...new Set(ownSides.map((b) => b.counterparty as string))];
  const theirs = await listBonds(
    { '#d': ids, authors: counterparties, '#p': [author], limit: Math.min(1000, ids.length * counterparties.length) },
    relays,
  );
  theirs.relaysReached.forEach((r) => reached.add(r));

  const byBond = new Map<string, BondView[]>();
  for (const side of [...ownSides, ...theirs.bonds]) {
    if (!side.bond) continue;
    const list = byBond.get(side.bond) ?? [];
    list.push(side);
    byBond.set(side.bond, list);
  }

  const now = Math.floor(Date.now() / 1000);
  const mutualIds: string[] = [];
  const formed = new Map<string, number>();
  let oldestBondDays = 0;
  for (const [bondId, sides] of byBond) {
    const pair = findMutualPair(sides);
    if (!pair || !pair.parties.includes(author)) continue;
    mutualIds.push(bondId);
    const formedAt = Math.max(pair.sides[0].created_at, pair.sides[1].created_at);
    formed.set(bondId, formedAt);
    oldestBondDays = Math.max(oldestBondDays, Math.max(0, Math.floor((now - formedAt) / 86400)));
  }
  if (mutualIds.length === 0) return { bonds: 0, reaffirmations: 0, oldestBondDays: 0 };

  const reaffs = await resolveEvents(relays, {
    kinds: [KIND_BOND_HISTORY],
    '#t': [REAFFIRM_TYPE],
    '#d': mutualIds,
    authors: [author],
    limit: 500,
  });
  reaffs.relaysReached.forEach((r) => reached.add(r));
  const days = new Set<string>();
  const mutualSet = new Set(mutualIds);
  for (const event of reaffs.events) {
    if (!verifyEvent(event) || event.pubkey !== author) continue;
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    if (!d || !mutualSet.has(d)) continue;
    // The timestamp is author-chosen: count it only between the moment both
    // sides were signed and now, one per bond per day. Backdating or
    // future-dating can't mint more days than really elapsed.
    if (event.created_at < (formed.get(d) ?? Infinity) || event.created_at > now + 600) continue;
    days.add(`${d}:${Math.floor(event.created_at / 86400)}`);
  }

  return { bonds: mutualIds.length, reaffirmations: days.size, oldestBondDays };
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** This identity's own current intent, if any. */
export async function myIntent(
  secret: Uint8Array,
  relays: string[] = DEFAULT_RELAYS,
): Promise<ReturnType<typeof parseBondIntent>> {
  const selfHex = keypairFromSecret(secret).pubkeyHex;
  const { events } = await resolveEvents(relays, {
    kinds: [KIND_BOND_INTENT],
    authors: [selfHex],
    limit: 5,
  } as never);
  const valid = events
    .filter(verifyEvent)
    .sort((a, b) => b.created_at - a.created_at)
    .map(parseBondIntent)
    .filter(Boolean);
  return valid[0] ?? null;
}
