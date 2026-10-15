// pact-core — the agent-relationship runtime.
//
// Identity, bond signing, and transport come from the L1 protocol package
// (@mate-protocol/core). This package adds the L2 runtime helpers on top.
// (L2 depends on L1; L1 never depends on L2.)

export * from '@mate-protocol/core';
export {
  BOND_STATES,
  isBondState,
  kindFromContent,
  makeBondDocument,
  type BondState,
  type MakeBondOptions,
} from './bond.js';
export { PactError, type PactErrorCode } from './errors.js';
export * from './keystore.js';
export {
  ACCEPTED_STATES,
  CONSENTING_STATES,
  findMutualPair,
  latestPerKey,
  supersedes,
  type MutualPair,
} from './mutual.js';
export { clearUnlisted, isUnlisted, markUnlisted } from './unlisted.js';
export { fetchInbox, listPrivateBonds, type PrivateBondFilter } from './private.js';
export {
  publishIntent,
  closeIntent,
  discover,
  myIntent,
  scoreOf,
  type PublishIntentInput,
  type PublishIntentResult,
  type LongevityRecord,
  type Candidate,
  type DiscoverOptions,
} from './discover.js';
export {
  REAFFIRM_TYPE,
  reaffirmBond,
  listReaffirmations,
  type ReaffirmBondInput,
  type ReaffirmBondResult,
  type ReaffirmationView,
} from './reaffirm.js';

import {
  BOND_TAG,
  DEFAULT_RELAYS,
  buildBondHistoryEvent,
  buildBondStateEvent,
  buildPrivateBondEvents,
  keypairFromSecret,
  pubkeyHexFromIdentity,
  publishEvent,
  resolveEvents,
  signMateDocumentNostr,
  verifyEvent,
  type NostrEvent,
  type PublishResult,
  type RelayFilter,
} from '@mate-protocol/core';

import { randomUUID } from 'node:crypto';

import { kindFromContent, makeBondDocument, type BondState } from './bond.js';
import { PactError } from './errors.js';
import { CONSENTING_STATES, findMutualPair, latestPerKey } from './mutual.js';
import { listPrivateBonds } from './private.js';

function getTag(event: NostrEvent, name: string): string | null {
  return event.tags.find((entry) => entry[0] === name)?.[1] ?? null;
}

/**
 * A fresh opaque, stable bond id (`urn:mate:<uuid>`). The proposer generates one;
 * the counterparty echoes it when accepting. Bond ids are machine identifiers —
 * not host names — so they're globally unique and don't leak local topology.
 */
export function newBondId(): string {
  return `urn:mate:${randomUUID()}`;
}

export type BondVisibility = 'public' | 'private';

export interface FormBondInput {
  /** Counterparty identity (did:nostr / npub / hex). */
  counterparty: string;
  /** Opaque bond id. Omit to auto-generate `urn:mate:<uuid>` (the proposer's id). */
  bondId?: string;
  state: BondState;
  kind?: string;
  relays?: string[];
  /** Also publish a kind:1317 history event (public transport only). */
  history?: boolean;
  /**
   * 'public' (default): a signed kind:30317 event, visible to every relay
   * observer. 'private': the bond stays a NIP-59 gift-wrapped rumor with an
   * embedded BIP-340 document proof — relays see only an ephemeral author and
   * the recipient's p tag; only the two parties (or whoever they disclose the
   * document to) can read or verify it.
   */
  visibility?: BondVisibility;
}

export interface FormBondResult {
  bondId: string;
  state: BondState;
  /** The relationship kind carried by the published document. */
  kind: string;
  visibility: BondVisibility;
  /** Public: the signed kind:30317 event. Private: the rumor id + the counterparty wrap's publish results. */
  stateEvent: { id: string; relays: PublishResult[] };
  historyEvent?: { id: string; relays: PublishResult[] };
  /** Private only: both gift wraps as published. */
  wraps?: {
    toCounterparty: { id: string; relays: PublishResult[] };
    toSelf: { id: string; relays: PublishResult[] };
  };
}

/** Last created_at this process stamped per (author, bond), on either channel. */
const lastStamp = new Map<string, number>();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Assemble, sign, and publish a bond state (and optional history) from a secret key. */
export async function formBond(secret: Uint8Array, input: FormBondInput): Promise<FormBondResult> {
  const subjectDid = keypairFromSecret(secret).did;
  const bondId = input.bondId ?? newBondId();
  const doc = makeBondDocument(subjectDid, input.counterparty, {
    bondId,
    state: input.state,
    kind: input.kind,
  });
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  const startedMs = Date.now();

  // Relays keep the newest side per (author, d) and readers break a same-second
  // tie by lowest id, so a quick follow-up (propose → withdraw) could lose the
  // tie to the side it is meant to replace. Stamp strictly after this author's
  // current side, on both channels:
  // - Within one process, a stamp per (author, bond) orders every write.
  // - Across processes (every `pact` CLI command is one; CLI and pactd may
  //   share a key), the first write this process makes for a bond waits for
  //   the wall clock to leave the second the call started in. Anything written
  //   before this process existed is then in an earlier second, with no inbox
  //   read. Costs at most a second, once per (author, bond) per process.
  // - The public prior is one cheap addressable query (it also catches a
  //   prior stamped ahead of the clock); the inbox is read only for a private
  //   write whose bond this process has not stamped yet, so a flooded inbox
  //   can't slow down public writes at all.
  const selfHex = keypairFromSecret(secret).pubkeyHex;
  const stampKey = `${selfHex}:${bondId}`;
  // A bond id generated by this very call has no prior side anywhere, so the
  // wait and the prior query would be pure cost (up to a second per propose).
  const generatedId = input.bondId === undefined;
  const firstStamp = !generatedId && !lastStamp.has(stampKey);
  const [publicPrior] = await Promise.all([
    generatedId ? null : listBonds({ authors: [selfHex], '#d': [bondId], limit: 5 }, relays).catch(() => null),
    firstStamp ? sleep(Math.max(0, (Math.floor(startedMs / 1000) + 1) * 1000 - Date.now())) : null,
  ]);
  let priorAt = Math.max(
    lastStamp.get(stampKey) ?? 0,
    ...(publicPrior?.bonds ?? []).filter((b) => b.author === selfHex).map((b) => b.created_at),
  );
  if (input.visibility === 'private' && firstStamp) {
    const privatePrior = await listPrivateBonds(secret, relays, { bondId, author: selfHex }).catch(() => null);
    priorAt = Math.max(priorAt, ...(privatePrior?.bonds ?? []).map((b) => b.created_at));
  }
  // Read the clock only now: after the first-stamp wait (and any inbox read).
  let createdAt = Math.floor(Date.now() / 1000);
  if (firstStamp) createdAt = Math.max(createdAt, Math.floor(startedMs / 1000) + 1);
  if (priorAt >= createdAt) createdAt = priorAt + 1;
  lastStamp.set(stampKey, createdAt);
  if (lastStamp.size > 10_000) lastStamp.delete(lastStamp.keys().next().value as string);

  if (input.visibility === 'private') {
    // Rumors are unsigned — the embedded proof is the bond's authorship
    // evidence and what selective disclosure verifies (extension §13.3).
    doc.proofs = [signMateDocumentNostr(doc, secret)];
    const events = buildPrivateBondEvents(doc, secret, { createdAt });
    const toCounterparty = await publishEvent(relays, events.toCounterparty);
    const toSelf = await publishEvent(relays, events.toSelf);
    return {
      bondId,
      state: input.state,
      kind: doc.bond.kind ?? 'companion',
      visibility: 'private',
      stateEvent: { id: events.rumor.id, relays: toCounterparty },
      wraps: {
        toCounterparty: { id: events.toCounterparty.id, relays: toCounterparty },
        toSelf: { id: events.toSelf.id, relays: toSelf },
      },
    };
  }

  const stateEvent = buildBondStateEvent(doc, secret, { createdAt });
  const result: FormBondResult = {
    bondId,
    state: input.state,
    kind: doc.bond.kind ?? 'companion',
    visibility: 'public',
    stateEvent: { id: stateEvent.id, relays: await publishEvent(relays, stateEvent) },
  };

  if (input.history) {
    const historyEvent = buildBondHistoryEvent(
      doc,
      secret,
      { from: null, to: input.state, at: doc.bond.updated_at ?? new Date().toISOString() },
      { createdAt },
    );
    result.historyEvent = { id: historyEvent.id, relays: await publishEvent(relays, historyEvent) };
  }
  return result;
}

export interface BondView {
  id: string;
  author: string;
  bond: string | null;
  counterparty: string | null;
  state: string | null;
  /** bond.kind from the carried MATE.md document, when parseable. */
  kind: string | null;
  created_at: number;
  /**
   * Public: the Nostr event signature verified. Private: the full unwrap chain
   * held AND the embedded document proof verified against the authenticated
   * author (see private.ts).
   */
  signature_valid: boolean;
  visibility: BondVisibility;
}

/** Max authors in verifyBond's direct follow-up fetch for pairs inferred from unknown authors. */
const DIRECT_FETCH_CAP = 50;

/** Default cap on events per bond query (a relay serves the newest first). */
const BOND_QUERY_LIMIT = 200;

/**
 * Resolve bond-state events from relays and verify each signature, reduced to
 * the latest event per (author, bond id) across every relay reached: a revoke
 * that reached only one relay supersedes the stale `active` another still
 * serves (the same newest-then-lowest-id rule listPrivateBonds applies).
 */
export async function listBonds(
  filter: Pick<RelayFilter, 'authors' | '#d' | '#p'> & { limit?: number },
  relays: string[] = DEFAULT_RELAYS,
): Promise<{ relaysReached: string[]; bonds: BondView[] }> {
  // #t scopes the query to MATE bonds — kinds 30317/1317 are unallocated, so
  // filtering by the discriminator tag avoids resolving unrelated apps' events.
  const { events, relaysReached } = await resolveEvents(relays, {
    kinds: [30317],
    '#t': [BOND_TAG],
    limit: BOND_QUERY_LIMIT,
    ...filter,
  });
  const views = events.map((event: NostrEvent) => ({
    id: event.id,
    author: event.pubkey,
    bond: getTag(event, 'd'),
    counterparty: getTag(event, 'p'),
    state: getTag(event, 'state'),
    kind: kindFromContent(event.content),
    created_at: event.created_at,
    signature_valid: verifyEvent(event),
    visibility: 'public' as const,
  }));
  // A forged event must not shadow a real one, so reduce valid and invalid
  // events separately; invalid ones stay visible (flagged) for reporting.
  const valid = latestPerKey(views.filter((v) => v.signature_valid), (v) => `${v.author}:${v.bond ?? v.id}`);
  const invalid = views.filter((v) => !v.signature_valid);
  const bonds = [...valid, ...invalid].sort((a, b) => b.created_at - a.created_at);
  return { relaysReached, bonds };
}

export interface VerifyBondResult {
  bondId: string;
  relaysReached: string[];
  count: number;
  /**
   * Two different parties each have a signature-valid latest side naming the
   * other, both still consenting and at least one accepted (see findMutualPair).
   */
  mutual: boolean;
  /** The two parties (hex pubkeys) when mutual. */
  parties?: [string, string];
  /** True when any side of the bond arrived via the private transport. */
  private?: boolean;
  /**
   * True when this node's private inbox could not be read to the end (a
   * flooded second, a relay that stopped answering mid-read, or the page
   * budget), so private sides may be missing. When this node is one of the
   * pair's parties, `mutual` is forced false then: its counterparty's private
   * revocation would be wrapped to it and could be hiding in what was not
   * read. A non-party's inbox never holds either side's private state, so its
   * verdict on someone else's bond is unaffected (the flag is still reported).
   */
  inboxTruncated?: boolean;
  /** Every side seen (latest per author + channel), including ones that did not count. */
  bonds: BondView[];
  /** Sides that failed verification; reported, never counted. */
  invalid?: BondView[];
}

export interface VerifyBondOptions {
  /**
   * This node's secret key. When given, the verdict also covers the private
   * transport: gift wraps addressed to this key are unwrapped and merged into
   * the mutuality check. Without it only public events are visible — a private
   * bond verifies as "not found" to outsiders, by design.
   */
  secret?: Uint8Array;
  /**
   * Parties to look for explicitly (any identity form). Their sides are
   * fetched with `authors` filters, so other authors' events for the same bond
   * id can't crowd them out of a relay's result limit. The secret's own key is
   * always included.
   */
  parties?: string[];
}

/**
 * Resolve every state event for a bond id, verify signatures, and decide whether
 * the bond is *mutual* (findMutualPair). Shared by pactd's /bonds/verify and the
 * SDK/CLI.
 *
 * With `options.secret`, private (gift-wrapped) sides this key can decrypt are
 * included — so the two parties see their mutual private bond verified, while
 * third parties see nothing.
 */
export async function verifyBond(
  bondId: string,
  relays: string[] = DEFAULT_RELAYS,
  options: VerifyBondOptions = {},
): Promise<VerifyBondResult> {
  const known = new Set((options.parties ?? []).map((p) => pubkeyHexFromIdentity(p)));
  if (options.secret) known.add(keypairFromSecret(options.secret).pubkeyHex);

  const queries = [listBonds({ '#d': [bondId] }, relays)];
  if (known.size > 0) {
    // Targeted queries for the parties we already know: a flood of other
    // authors' events on this d tag can't push these out of the limit.
    queries.push(listBonds({ '#d': [bondId], authors: [...known] }, relays));
    queries.push(listBonds({ '#d': [bondId], '#p': [...known] }, relays));
  }
  const publicResults = await Promise.all(queries);
  let sides = publicResults.flatMap((r) => r.bonds);
  const reached = new Set(publicResults.flatMap((r) => r.relaysReached));

  // Once a candidate pair is visible, fetch both of its parties' sides
  // directly, so each party's latest side is what gets evaluated. A known
  // party's own counterparty is always fetched: that is the only pair the
  // caller cares about, and junk authors must not be able to switch it off.
  const direct = new Set<string>();
  for (const side of sides) {
    if (side.signature_valid && side.counterparty && known.has(side.author)) direct.add(side.counterparty);
  }
  // Pairs inferred from unknown authors are a best-effort extra, capped so a
  // flood of junk keys can't turn this into an unbounded authors filter.
  const inferred = new Set<string>();
  for (const side of sides) {
    if (side.signature_valid && side.counterparty && !known.has(side.author)) {
      inferred.add(side.author);
      inferred.add(side.counterparty);
    }
  }
  if (direct.size + inferred.size <= DIRECT_FETCH_CAP) for (const a of inferred) direct.add(a);
  for (const k of known) direct.delete(k); // already fetched by the authors query above
  if (direct.size > 0) {
    const fetched = await listBonds({ '#d': [bondId], authors: [...direct] }, relays);
    sides = [...sides, ...fetched.bonds];
    for (const r of fetched.relaysReached) reached.add(r);
  }

  let inboxTruncated = false;
  const selfHex = options.secret ? keypairFromSecret(options.secret).pubkeyHex : null;
  if (options.secret) {
    const priv = await listPrivateBonds(options.secret, relays, { bondId });
    sides = [...sides, ...priv.bonds];
    for (const r of priv.relaysReached) reached.add(r);
    inboxTruncated = priv.truncated;
  }

  // Dedupe (several queries return the same events), then latest per
  // (author, channel) for the report. Mutuality is evaluated across channels.
  const unique = [...new Map(sides.map((s) => [`${s.id}:${s.visibility}`, s])).values()];
  const validSides = latestPerKey(
    unique.filter((s) => s.signature_valid),
    (s) => `${s.author}:${s.visibility}`,
  );
  const invalid = unique.filter((s) => !s.signature_valid);
  const bonds = [...validSides, ...invalid].sort((a, b) => b.created_at - a.created_at);

  const pair = findMutualPair(validSides);
  const anyPrivate = bonds.some((b) => b.visibility === 'private');
  return {
    bondId,
    relaysReached: [...reached],
    count: bonds.length,
    // An incomplete inbox can hide a revocation wrapped to this node — which
    // only happens for a bond this node is a party to. Never report such a
    // bond mutual on a partial read; anyone else's bond is unaffected.
    mutual: pair !== null && !(inboxTruncated && selfHex !== null && pair.parties.includes(selfHex)),
    ...(inboxTruncated ? { inboxTruncated: true } : {}),
    ...(pair ? { parties: pair.parties } : {}),
    ...(anyPrivate ? { private: true } : {}),
    bonds,
    ...(invalid.length ? { invalid } : {}),
  };
}

export interface AcceptBondInput {
  /** The proposer's bond id, echoed back so both sides share one `d` tag. */
  bondId: string;
  /** The proposer's identity. Omit to auto-resolve from the inbound proposal. */
  counterparty?: string;
  /** State to publish on accept. Defaults to `active`. */
  state?: BondState;
  /**
   * Omit to echo the proposal's kind, so both sides describe the same
   * relationship. Set explicitly only to deliberately change it — the two
   * documents will then disagree on kind, which verifiers can see.
   */
  kind?: string;
  relays?: string[];
  history?: boolean;
  /**
   * Omit to echo the proposal's channel: a privately-proposed bond is accepted
   * privately, a public one publicly. Set explicitly to override (e.g. the
   * §13.7 consensual go-public transition).
   */
  visibility?: BondVisibility;
  /**
   * Deliberate operator override: accept even though this identity's private
   * inbox could not be read to the end (a flood of gift wraps, a relay that
   * stopped answering). The proposal's state is then judged on the partial
   * history that WAS read — a withdrawal hiding in the unread part would be
   * missed. Without it, an incomplete inbox refuses the accept (conflict).
   */
  allowIncompleteInbox?: boolean;
}

/**
 * Accept a proposed bond: publish the reciprocal side using the proposer's bond
 * id (so the two events share one `d` tag and resolve as mutual). If no
 * counterparty is given, it's resolved from the relays — the author of the
 * inbound proposal (public event or decryptable gift wrap) that p-tags this
 * identity for `bondId`.
 */
export async function acceptBond(secret: Uint8Array, input: AcceptBondInput): Promise<FormBondResult> {
  const relays = input.relays?.length ? input.relays : DEFAULT_RELAYS;
  let counterparty = input.counterparty;
  let visibility = input.visibility;
  let kind = input.kind;

  // Always resolve the proposal, even when every field was passed: the
  // proposer's current state decides whether there is anything to accept.
  const selfHex = keypairFromSecret(secret).pubkeyHex;
  const counterpartyFilter = counterparty ? [pubkeyHexFromIdentity(counterparty)] : undefined;
  const { bonds: publicBonds } = await listBonds(
    { '#d': [input.bondId], '#p': [selfHex], ...(counterpartyFilter ? { authors: counterpartyFilter } : {}) },
    relays,
  );
  const { bonds: privateBonds, truncated } = await listPrivateBonds(secret, relays, {
    bondId: input.bondId,
    counterparty: selfHex,
  });
  if (truncated && !input.allowIncompleteInbox) {
    // Part of the inbox could not be read (a flooded second, a relay that
    // stopped answering, or the page budget). The proposer's current state may
    // be hiding in what was skipped — a withdrawal, say — so accepting now
    // would act on a partial history. Junk wraps never expire, so waiting does
    // not help; the operator decides.
    throw new PactError(
      'conflict',
      `inbox incomplete on these relays — could not read the full private history for bond ${input.bondId}; nothing accepted. To accept on the partial history anyway (a hidden withdrawal would be missed), pass allowIncompleteInbox (pactd: "allowIncompleteInbox": true, CLI: --allow-incomplete-inbox)`,
    );
  }
  const inbound = [...publicBonds, ...privateBonds].filter((b) => b.author !== selfHex && b.signature_valid);
  const proposers = [...new Set(inbound.map((b) => b.author))];

  if (!counterparty) {
    if (proposers.length === 0) {
      throw new PactError(
        'not_found',
        `no inbound proposal for bond ${input.bondId} (none p-tagging this identity) — pass counterparty explicitly`,
      );
    }
    if (proposers.length > 1) {
      throw new PactError(
        'conflict',
        `ambiguous: ${proposers.length} proposers for bond ${input.bondId} — pass counterparty explicitly`,
      );
    }
    counterparty = proposers[0];
  }

  // The caller may pass did:nostr / npub / hex; event authors are hex. Normalize
  // once so an explicit counterparty finds its proposal (and its channel + kind).
  // The proposer's latest side across both channels is the one that counts.
  const counterpartyHex = pubkeyHexFromIdentity(counterparty);
  const proposal = latestPerKey(
    inbound.filter((b) => b.author === counterpartyHex),
    () => counterpartyHex,
  )[0];

  if (proposal && !ACCEPTABLE_STATES.has(proposal.state ?? '')) {
    // A withdrawn / rejected / revoked proposal is the proposer saying no.
    // Accepting over it would publish consent they took back.
    throw new PactError('conflict', `proposal ${input.bondId} is ${proposal.state ?? 'unknown'} — nothing to accept`);
  }

  if (!visibility) {
    // Echo the channel the proposer used. Never guess: a private proposal we
    // can't see (a flooded inbox, a relay that's down) must not be answered
    // with a public event that links the two parties for everyone.
    if (!proposal) {
      throw new PactError(
        'not_found',
        `proposal ${input.bondId} not visible on these relays — pass visibility explicitly`,
      );
    }
    visibility = proposal.visibility;
  }

  if (!kind) {
    // Echo the proposer's kind. Falls back to the document default when the
    // proposal isn't visible to us — the explicit `kind` input overrides both.
    kind = proposal?.kind ?? undefined;
  }

  return formBond(secret, {
    counterparty,
    bondId: input.bondId,
    state: input.state ?? 'active',
    kind,
    relays: input.relays,
    history: input.history,
    visibility,
  });
}

/** Proposer states an accept may answer. */
// A proposal can be accepted while the proposer still consents — the same set
// the mutuality rule counts (mutual.ts), so "accept" and "mutual" never disagree
// about `paused`.
const ACCEPTABLE_STATES: ReadonlySet<string> = CONSENTING_STATES;
