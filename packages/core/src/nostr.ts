// Nostr-native bond transport (NIP-BD kinds 30317 + 1317).
//
// NOTE (MVP): faithful port of the relevant parts of MATE.md core's nostr.ts,
// trimmed to the Nostr (secp256k1 / did:nostr) path Pact uses. TODO: replace
// with a dependency on @mate-protocol/core once published.

import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { bech32 } from '@scure/base';

import type { BondDocument } from './bond.js';
import { normalizeBondDocument } from './normalize.js';

secp256k1.hashes.sha256 = sha256;

export const KIND_BOND_STATE = 30317;
export const KIND_BOND_HISTORY = 1317;

export const DEFAULT_RELAYS = [
  'wss://relay.islandbitcoin.com',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

// --- Identity ---------------------------------------------------------------

export interface NostrKeypair {
  did: string;
  npub: string;
  nsec: string;
  pubkeyHex: string;
}

export function generateNostrKeypair(): NostrKeypair {
  return keypairFromSecret(secp256k1.utils.randomSecretKey());
}

export function keypairFromSecret(secret: Uint8Array): NostrKeypair {
  const pubkey = secp256k1.schnorr.getPublicKey(secret);
  const npub = bechEncode('npub', pubkey);
  return {
    did: `did:nostr:${npub}`,
    npub,
    nsec: bechEncode('nsec', secret),
    pubkeyHex: toHex(pubkey),
  };
}

export function secretFromNsec(nsec: string): Uint8Array {
  const { prefix, bytes } = bechDecode(nsec);
  if (prefix !== 'nsec') throw new Error(`expected an nsec secret key, got ${prefix}`);
  if (bytes.length !== 32) throw new Error('nsec must decode to a 32-byte secret');
  return bytes;
}

/** Resolve a did:nostr / npub / nostr:<hex> / 64-hex identity to x-only pubkey hex. */
export function pubkeyHexFromIdentity(id: string): string {
  if (id.startsWith('did:nostr:')) return decodeNpub(id.slice('did:nostr:'.length));
  if (id.startsWith('npub1')) return decodeNpub(id);
  if (id.startsWith('nostr:')) return normalizeHex(id.slice('nostr:'.length));
  if (/^[0-9a-fA-F]{64}$/.test(id)) return id.toLowerCase();
  throw new Error(`identity ${id} is not a Nostr pubkey (did:nostr: / npub1… / nostr:<hex> / 64-hex)`);
}

// --- Events -----------------------------------------------------------------

export interface UnsignedEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface NostrEvent extends UnsignedEvent {
  id: string;
  sig: string;
}

export function serializeEvent(event: UnsignedEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export function computeEventId(event: UnsignedEvent): string {
  return toHex(sha256(new TextEncoder().encode(serializeEvent(event))));
}

export function finalizeEvent(unsigned: UnsignedEvent, secret: Uint8Array): NostrEvent {
  const id = computeEventId(unsigned);
  const sig = toHex(secp256k1.schnorr.sign(hexToBytes(id), secret));
  return { ...unsigned, id, sig };
}

export function verifyEvent(event: NostrEvent): boolean {
  try {
    if (computeEventId(event) !== event.id) return false;
    return secp256k1.schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

export function buildBondStateEvent(doc: BondDocument, secret: Uint8Array, createdAt: number): NostrEvent {
  const pubkey = toHex(secp256k1.schnorr.getPublicKey(secret));
  return finalizeEvent(
    {
      pubkey,
      created_at: createdAt,
      kind: KIND_BOND_STATE,
      tags: [
        ['d', doc.bond.id],
        ['p', pubkeyHexFromIdentity(doc.object.id)],
        ['state', String(doc.bond.state)],
        ['mate', doc.mate_version],
      ],
      content: normalizeBondDocument(doc),
    },
    secret,
  );
}

export function buildBondHistoryEvent(
  doc: BondDocument,
  secret: Uint8Array,
  transition: { from: string | null; to: string; at: string; prev?: string },
  createdAt: number,
): NostrEvent {
  const pubkey = toHex(secp256k1.schnorr.getPublicKey(secret));
  const tags: string[][] = [
    ['d', doc.bond.id],
    ['p', pubkeyHexFromIdentity(doc.object.id)],
    ['state', transition.to],
    ['mate', doc.mate_version],
  ];
  if (transition.prev) tags.push(['prev', transition.prev]);
  return finalizeEvent(
    {
      pubkey,
      created_at: createdAt,
      kind: KIND_BOND_HISTORY,
      tags,
      content: JSON.stringify({
        mate_version: doc.mate_version,
        bond_id: doc.bond.id,
        from: transition.from,
        to: transition.to,
        at: transition.at,
      }),
    },
    secret,
  );
}

export function getTag(event: NostrEvent, name: string): string | null {
  return event.tags.find((entry) => entry[0] === name)?.[1] ?? null;
}

// --- Transport (built-in WebSocket) -----------------------------------------

export interface PublishResult {
  relay: string;
  accepted: boolean;
  message: string;
}

export interface RelayFilter {
  kinds?: number[];
  authors?: string[];
  '#d'?: string[];
  '#p'?: string[];
  limit?: number;
}

export function publishEvent(relays: string[], event: NostrEvent, timeoutMs = 8000): Promise<PublishResult[]> {
  return Promise.all(relays.map((relay) => publishToRelay(relay, event, timeoutMs)));
}

function publishToRelay(relay: string, event: NostrEvent, timeoutMs: number): Promise<PublishResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (accepted: boolean, message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ relay, accepted, message });
    };
    const ws = new WebSocket(relay);
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    ws.addEventListener('open', () => ws.send(JSON.stringify(['EVENT', event])));
    ws.addEventListener('error', () => finish(false, 'connection error'));
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = parseMessage(ev.data);
      if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
        finish(Boolean(msg[2]), String(msg[3] ?? ''));
      }
    });
  });
}

export async function resolveEvents(
  relays: string[],
  filter: RelayFilter,
  timeoutMs = 8000,
): Promise<{ events: NostrEvent[]; relaysReached: string[] }> {
  const perRelay = await Promise.all(relays.map((relay) => resolveFromRelay(relay, filter, timeoutMs)));
  const byId = new Map<string, NostrEvent>();
  const relaysReached: string[] = [];
  for (const result of perRelay) {
    if (result.reached) relaysReached.push(result.relay);
    for (const event of result.events) byId.set(event.id, event);
  }
  return { events: [...byId.values()], relaysReached };
}

function resolveFromRelay(
  relay: string,
  filter: RelayFilter,
  timeoutMs: number,
): Promise<{ relay: string; reached: boolean; events: NostrEvent[] }> {
  return new Promise((resolve) => {
    const events: NostrEvent[] = [];
    let reached = false;
    let settled = false;
    const subId = `pact-${filter.kinds?.join('-') ?? 'q'}`;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.send(JSON.stringify(['CLOSE', subId]));
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ relay, reached, events });
    };
    const ws = new WebSocket(relay);
    const timer = setTimeout(finish, timeoutMs);
    ws.addEventListener('open', () => {
      reached = true;
      ws.send(JSON.stringify(['REQ', subId, filter]));
    });
    ws.addEventListener('error', finish);
    ws.addEventListener('message', (ev: MessageEvent) => {
      const msg = parseMessage(ev.data);
      if (!Array.isArray(msg)) return;
      if (msg[0] === 'EVENT' && msg[1] === subId && msg[2]) events.push(msg[2] as NostrEvent);
      else if (msg[0] === 'EOSE' && msg[1] === subId) finish();
    });
  });
}

function parseMessage(data: unknown): unknown {
  try {
    return JSON.parse(typeof data === 'string' ? data : String(data));
  } catch {
    return null;
  }
}

// --- Encoding helpers -------------------------------------------------------

function bechEncode(prefix: string, bytes: Uint8Array): string {
  return bech32.encode(prefix, bech32.toWords(bytes), 1000);
}

function bechDecode(value: string): { prefix: string; bytes: Uint8Array } {
  const decoded = bech32.decode(value as `${string}1${string}`, 1000);
  return { prefix: decoded.prefix, bytes: Uint8Array.from(bech32.fromWords(decoded.words)) };
}

function decodeNpub(npub: string): string {
  const { prefix, bytes } = bechDecode(npub);
  if (prefix !== 'npub') throw new Error(`expected npub, got ${prefix}`);
  return toHex(bytes);
}

function normalizeHex(value: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('expected a 64-character hex pubkey');
  return value.toLowerCase();
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}
