// Discovery: publish bond intents and browse the open board.
//
// The board is permissionless, so ranking is the reader's defense: candidates
// are scored by their PUBLIC longevity record — distinct bonds, reaffirmations,
// and age — which a fresh sybil cannot fake. Private bonds never contribute to
// (or leak into) discovery; that is the §2.7 barbell working as designed.

import {
  BOND_TAG,
  KIND_BOND_HISTORY,
  KIND_BOND_INTENT,
  KIND_BOND_STATE,
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
  const event = buildBondIntentEvent(
    { seeking: input.seeking, about: input.about, profile: input.profile, status: input.status },
    secret,
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
  /** Distinct public bonds this identity has authored. */
  bonds: number;
  /** Public reaffirmations it has published. */
  reaffirmations: number;
  /** Age in days of its oldest public bond event (0 when none). */
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
 * Reaffirmations weigh heaviest — repeated choice over time is the one signal
 * a sybil cannot mint in bulk. The formula is deliberately simple and public:
 * ranking must be auditable, or discovery becomes an algorithm to lobby.
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

  // newest valid open intent per author
  const intents = new Map<string, ReturnType<typeof parseBondIntent>>();
  for (const event of events) {
    if (!verifyEvent(event)) continue;
    const parsed = parseBondIntent(event);
    if (!parsed || parsed.status !== 'open') continue;
    if (selfHex && parsed.author === selfHex) continue;
    const prior = intents.get(parsed.author);
    if (!prior || parsed.created_at > prior.created_at) intents.set(parsed.author, parsed);
  }

  const authors = [...intents.keys()];
  const records = new Map<string, LongevityRecord>(
    authors.map((a) => [a, { bonds: 0, reaffirmations: 0, oldestBondDays: 0 }]),
  );

  if (authors.length > 0) {
    // Two batched queries cover every candidate's public record.
    const [states, reaffs] = await Promise.all([
      resolveEvents(relays, { kinds: [KIND_BOND_STATE], '#t': [BOND_TAG], authors, limit: 500 }),
      resolveEvents(relays, { kinds: [KIND_BOND_HISTORY], '#t': [REAFFIRM_TYPE], authors, limit: 500 }),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const bondsSeen = new Map<string, Set<string>>();
    for (const event of states.events) {
      if (!verifyEvent(event)) continue;
      const rec = records.get(event.pubkey);
      if (!rec) continue;
      const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? event.id;
      const set = bondsSeen.get(event.pubkey) ?? new Set();
      if (!set.has(d)) {
        set.add(d);
        bondsSeen.set(event.pubkey, set);
        rec.bonds += 1;
      }
      rec.oldestBondDays = Math.max(rec.oldestBondDays, Math.floor((now - event.created_at) / 86400));
    }
    for (const event of reaffs.events) {
      if (!verifyEvent(event)) continue;
      const rec = records.get(event.pubkey);
      if (rec) rec.reaffirmations += 1;
    }
  }

  const candidates = [...intents.values()]
    .filter((i): i is NonNullable<typeof i> => i !== null)
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

  return { relaysReached, candidates };
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
