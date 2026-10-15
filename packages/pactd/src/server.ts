import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  BOND_STATES,
  DEFAULT_RELAYS,
  PactError,
  acceptBond,
  ensureIdentity,
  formBond,
  hasIdentity,
  isBondState,
  listBonds,
  listPrivateBonds,
  closeIntent,
  discover,
  listReaffirmations,
  myIntent,
  publishIntent,
  reaffirmBond,
  loadIdentity,
  loadSecret,
  pubkeyHexFromIdentity,
  verifyBond,
  type BondState,
  type BondVisibility,
  type RelayFilter,
} from 'pact-core';

import { timingSafeEqual } from 'node:crypto';

import {
  VERIFICATION_INVOICE_EXPIRY_SECS,
  consumeVerification,
  ownsPaymentHash,
  pendingVerificationCount,
  pendingVerificationCountFor,
  recordPaymentHash,
  recordVerificationInvoice,
  verificationStatus,
} from './ledger.js';
import { lightningFrom, type LightningProvider } from './lightning.js';
import {
  NOT_DISCOVERABLE_HINT,
  applyConfiguredIntent,
  clearUnlisted,
  configuredIntent,
  discoveryStatus,
  markUnlisted,
  publishedStatus,
} from './intentconfig.js';
import { relaysAreCustom, resolveRelays, saveRelays } from './relayconfig.js';
import { resolveToken } from './tokenconfig.js';
import { renderUI } from './ui.js';
import { clearNwcUri, loadNwcUri, saveNwcUri } from './walletconfig.js';

export const VERSION = '0.20.0';

function truthy(v: string | undefined): boolean {
  return v !== undefined && !['', '0', 'false'].includes(v.toLowerCase());
}

// Bearer token for API access. PACT_TOKEN, else an auto-generated persisted
// token when PACT_AUTO_TOKEN is set, else undefined (open — loopback only;
// index.ts turns the auto token on for any non-loopback bind).
const TOKEN = resolveToken();

/** Whether the API requires a bearer token (the resolved token, not just PACT_TOKEN). */
export function authEnabled(): boolean {
  return Boolean(TOKEN);
}

// The status UI never embeds the bearer token, except when the operator says
// this listener sits behind an authenticating proxy (Umbrel's app_proxy):
// PACT_UI_EMBED_TOKEN=1. PACT_PUBLIC_MODE (the old opt-in) is now the default;
// setting it still forces embedding off.
const EMBED_TOKEN = truthy(process.env.PACT_UI_EMBED_TOKEN) && !truthy(process.env.PACT_PUBLIC_MODE);

// Hosts this daemon answers to (DNS-rebinding defense). Loopback names are
// always allowed. PACT_ALLOWED_HOSTS adds names (comma-separated; `*` = any).
// When it is unset, a token-protected node answers any host (the token is the
// gate and is never on the page), and an open node answers loopback only.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const ALLOWED_HOSTS = (process.env.PACT_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const name = hostnameOf(host);
  if (LOOPBACK_HOSTS.has(name)) return true;
  if (ALLOWED_HOSTS.includes('*') || ALLOWED_HOSTS.includes(name) || ALLOWED_HOSTS.includes(host.toLowerCase())) return true;
  return Boolean(TOKEN) && ALLOWED_HOSTS.length === 0;
}

/**
 * Cross-site request defense. A web page the operator visits can send
 * "simple" requests (no preflight) to a loopback daemon; these checks refuse
 * them. Sec-Fetch-Site is computed by the browser and can't be forged by the
 * page; Origin is the fallback for older browsers.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return true; // not a browser request
  try {
    const o = new URL(origin);
    const forwarded = req.headers['x-forwarded-host'];
    return (
      o.host === req.headers.host ||
      (typeof forwarded === 'string' && o.host === forwarded) ||
      ALLOWED_HOSTS.includes(o.hostname.toLowerCase())
    );
  } catch {
    return false; // "null" and other opaque origins
  }
}

/** A client error with its HTTP status (mapped in the request handler). */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function identityHex(value: string, field: string): string {
  try {
    return pubkeyHexFromIdentity(value);
  } catch {
    throw new HttpError(400, `${field} is not a Nostr identity (did:nostr, npub or 64-hex)`);
  }
}

function bondState(value: unknown, fallback: BondState): BondState {
  if (value === undefined) return fallback;
  if (!isBondState(value)) throw new HttpError(400, `state must be one of: ${BOND_STATES.join(', ')}`);
  return value;
}
// Wallet provider: configured at runtime (via the UI / POST /wallet/connect,
// persisted in PACT_HOME) or from PACT_NWC. Mutable so it can be (re)connected.
let lightning = lightningFrom(loadNwcUri());

// Paid-verification market (opt-in): price in sats to verify a bond. 0 = free.
// Only enforced when a wallet is connected (otherwise there's no way to collect).
const VERIFY_PRICE_SATS = Math.max(0, Math.floor(Number(process.env.PACT_VERIFY_PRICE_SATS) || 0));

function positiveIntEnv(name: string, fallback: number): number {
  const n = Math.floor(Number(process.env[name]));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Anonymous callers can make the daemon create invoices in the operator's
// wallet, so issuing is bounded: at most this many unredeemed, unexpired
// verification invoices at once, and at most this many new ones per client
// address per minute. Past either → 429.
const VERIFY_MAX_PENDING = positiveIntEnv('PACT_VERIFY_MAX_PENDING', 200);
const VERIFY_INVOICES_PER_MIN = positiveIntEnv('PACT_VERIFY_INVOICES_PER_MIN', 10);
// ...and at most this many unredeemed invoices held by one client at a time,
// so a single address can't fill the global pool and lock every buyer out.
// The authenticated operator is exempt from both pending caps: they can
// always verify on their own node.
const VERIFY_MAX_PENDING_PER_CLIENT = positiveIntEnv('PACT_VERIFY_MAX_PENDING_PER_CLIENT', 3);
// Behind a reverse proxy or tunnel every request shares the proxy's socket
// address, which would turn the per-client limits into one shared limit. Only
// when the operator says the proxy is trusted do we key on X-Forwarded-For.
const TRUSTED_PROXY = !['', '0', 'false'].includes((process.env.PACT_TRUSTED_PROXY ?? '').toLowerCase());
const invoiceRequests = new Map<string, number[]>();

/**
 * The bucket the per-client limits key on. One IPv6 host usually holds a
 * whole /64, so IPv6 clients are bucketed by prefix; otherwise one machine
 * could rotate through 2^64 "clients".
 */
function clientBucket(addr: string): string {
  const a = addr.replace(/^::ffff:/i, '').replace(/%.*$/, '');
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/** The address the per-client limits key on. */
function clientAddress(req: IncomingMessage): string {
  if (TRUSTED_PROXY) {
    // Proxies APPEND the peer they saw to whatever X-Forwarded-For the client
    // sent, so only the RIGHTMOST entry is the trusted proxy's word; anything
    // left of it is client-chosen and would hand an attacker a fresh bucket
    // per request.
    const fwd = req.headers['x-forwarded-for'];
    const raw = Array.isArray(fwd) ? fwd.join(',') : fwd ?? '';
    const last = raw.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return clientBucket(last);
    if (!warnedNoForwardedFor) {
      warnedNoForwardedFor = true;
      process.stderr.write('pactd: PACT_TRUSTED_PROXY is set but a request arrived without X-Forwarded-For — per-client limits fall back to the socket address (every client shares one bucket). Is the proxy in front?\n');
    }
  }
  return clientBucket(req.socket.remoteAddress ?? 'unknown');
}
let warnedNoForwardedFor = false;

/** Sliding one-minute window per client address. True = allowed (and counted). */
function takeInvoiceSlot(client: string, now = Date.now(), limit = VERIFY_INVOICES_PER_MIN): boolean {
  const recent = (invoiceRequests.get(client) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= limit) {
    invoiceRequests.set(client, recent);
    return false;
  }
  recent.push(now);
  invoiceRequests.set(client, recent);
  if (invoiceRequests.size > 10_000) {
    for (const [k, ts] of invoiceRequests) if (!ts.some((t) => now - t < 60_000)) invoiceRequests.delete(k);
  }
  return true;
}

/** Most `?party=` params a verify request may name. */
const MAX_VERIFY_PARTIES = 10;

// Active relay set. Resolution: relays.json (set via the UI / POST /relays) >
// PACT_RELAYS env > the protocol defaults. Mutable so it can be (re)configured
// at runtime — pick public relays, a bundled relay, or another relay app.
let RELAYS = resolveRelays();

/** The relay set the daemon is currently publishing to (startup hooks read this). */
export function currentRelays(): string[] {
  return RELAYS;
}

// Discovery is opt-in (see intentconfig.ts). This annotates a response with
// whether the identity is findable, and how to opt in when it isn't, at the
// moments an operator would naturally decide: identity creation and the first
// mutual bond. Relay trouble must never fail the operation it decorates.
async function withDiscovery<T extends object>(body: T, secret: Uint8Array): Promise<T & { discoverable?: boolean; hint?: string }> {
  try {
    return { ...body, ...(await discoveryStatus(secret, RELAYS)) };
  } catch {
    return body;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      data += chunk;
      if (data.length > 1_000_000) {
        tooLarge = true;
        reject(new HttpError(413, 'request body too large'));
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!data) return resolve({});
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return reject(new HttpError(400, 'invalid JSON body'));
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return reject(new HttpError(400, 'JSON body must be an object'));
      }
      resolve(parsed as Record<string, unknown>);
    });
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = `Bearer ${TOKEN}`;
  // Constant-time compare — `===` short-circuits on the first differing byte,
  // leaking a timing oracle on the token that gates the money endpoints.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Most `?relay=` params one request may name (deduped). */
const MAX_REQUEST_RELAYS = 10;

function relaysFrom(url: URL): string[] {
  const relays = [...new Set(url.searchParams.getAll('relay'))].slice(0, MAX_REQUEST_RELAYS);
  return relays.length ? relays : RELAYS;
}

export interface DaemonOptions {
  /**
   * Serve the status UI at `/` (default true). The API-only listener
   * (PACT_API_PORT) passes false: it answers `/` with 404, so a host-published
   * direct port never serves a page at all.
   */
  serveUI?: boolean;
  /** Replace the wallet provider (tests inject a stub). `null` = no wallet. */
  lightning?: LightningProvider | null;
}

export function createDaemon(options: DaemonOptions = {}) {
  const serveUI = options.serveUI ?? true;
  if (options.lightning !== undefined) lightning = options.lightning;
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const ln = lightning; // per-request snapshot (const → narrows across awaits)

      if (!hostAllowed(req)) return json(res, 403, { error: 'host not allowed (set PACT_ALLOWED_HOSTS)' });

      // Status UI + health are unauthenticated. The UI page carries no token
      // (see ui.ts); it unlocks with the operator's token.
      if (path === '/' && method === 'GET') {
        if (!serveUI) return json(res, 404, { error: 'not found', path, hint: 'API-only listener; the UI is on the main port' });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
        });
        return res.end(renderUI(TOKEN, process.env.PACT_PUBLIC_PORT, process.env.PACT_RELAY_PUBLIC_PORT, EMBED_TOKEN));
      }
      if (path === '/healthz') {
        return json(res, 200, {
          ok: true,
          version: VERSION,
          auth: Boolean(TOKEN),
          wallet: Boolean(ln),
          verifyPriceSats: VERIFY_PRICE_SATS || undefined,
        });
      }

      if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin request refused' });
      // A non-GET must declare a JSON body. Browsers can only send that
      // cross-origin after a CORS preflight, which pactd never approves.
      if (method !== 'GET' && method !== 'HEAD') {
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') {
          return json(res, 415, { error: 'Content-Type must be application/json' });
        }
      }

      // Paid-verification market: when a price is set AND a wallet is connected
      // to collect it, strangers can buy a verification without the admin
      // token, which also pays invoices and replaces the identity. They get
      // the public verdict only — private sides need this node's key, which is
      // reserved for the operator. With no wallet there is no market, so the
      // route stays admin-only like everything else (a free, unthrottled
      // verify would let anyone make this node hammer its relays).
      if (path === '/bonds/verify' && method === 'GET' && VERIFY_PRICE_SATS > 0 && ln) {
        const authed = authorized(req);
        return await handleVerify(res, url, ln, { authed, client: clientAddress(req) });
      }

      if (!authorized(req)) return json(res, 401, { error: 'unauthorized' });

      // --- identity ---
      if (path === '/identity' && method === 'GET') {
        if (!hasIdentity()) return json(res, 404, { identity: null, hint: 'POST /identity to create' });
        const id = loadIdentity();
        return json(res, 200, { did: id.did, npub: id.npub, pubkeyHex: id.pubkeyHex });
      }
      if (path === '/identity' && method === 'POST') {
        const body = await readJson(req);
        const force = body.force === true;
        if (force && hasIdentity()) {
          // Replacing the key orphans every bond made with it. Require the
          // caller to name the key being replaced, so a stray or forged
          // request can't do it (the old key is also backed up on disk).
          const current = loadIdentity().pubkeyHex;
          if (body.pubkeyHex !== current) {
            return json(res, 409, { error: 'force replaces this node\'s key — pass the current pubkeyHex to confirm', pubkeyHex: current });
          }
        }
        const identity = ensureIdentity(force);
        // A fresh key has no intent anywhere. If the operator pre-chose one
        // (PACT_INTENT_SEEKING), honor that explicit choice now that a key
        // exists; otherwise just say the node isn't discoverable and how to
        // opt in (no relay round trip: a brand-new key cannot have an intent).
        if (identity.created) {
          if (!configuredIntent()) return json(res, 200, { ...identity, discoverable: false, hint: NOT_DISCOVERABLE_HINT });
          try {
            const intent = await applyConfiguredIntent(loadSecret(), RELAYS);
            return json(res, 200, { ...identity, ...publishedStatus(intent), intent });
          } catch (error) {
            return json(res, 200, { ...identity, discoverable: false, hint: `configured intent not published: ${String(error)}` });
          }
        }
        return json(res, 200, await withDiscovery(identity, loadSecret()));
      }

      // --- bonds ---
      if (path === '/bonds' && method === 'POST') {
        if (!hasIdentity()) return json(res, 400, { error: 'no identity — POST /identity first' });
        const body = await readJson(req);
        if (typeof body.counterparty !== 'string') {
          return json(res, 400, { error: 'counterparty (string) is required' });
        }
        identityHex(body.counterparty, 'counterparty');
        const visibility = body.private === true || body.visibility === 'private' ? 'private' : 'public';
        const result = await formBond(loadSecret(), {
          counterparty: body.counterparty,
          // Omit bondId to auto-generate urn:mate:<uuid> (the proposer's id).
          bondId: typeof body.bondId === 'string' ? body.bondId : undefined,
          state: bondState(body.state, 'proposed'),
          kind: typeof body.kind === 'string' ? body.kind : undefined,
          relays: Array.isArray(body.relays) ? (body.relays as string[]) : RELAYS,
          // History events are public-transport only; private bonds carry their
          // canonical timestamp in the rumor.
          history: visibility === 'private' ? false : body.history === undefined ? true : Boolean(body.history),
          visibility,
        });
        // Reciprocating (accepted/active) is the "first bond" moment — the
        // natural point to mention that the board is still opt-in.
        const reciprocal = result.state === 'accepted' || result.state === 'active';
        return json(res, 200, reciprocal ? await withDiscovery(result, loadSecret()) : result);
      }
      if (path === '/bonds/accept' && method === 'POST') {
        if (!hasIdentity()) return json(res, 400, { error: 'no identity — POST /identity first' });
        const body = await readJson(req);
        if (typeof body.bondId !== 'string') {
          return json(res, 400, { error: 'bondId (string) is required — the proposer\'s bond id to echo' });
        }
        // Omit visibility to echo the proposal's channel (private proposal →
        // private accept). body.private/visibility overrides explicitly.
        const acceptVisibility: BondVisibility | undefined =
          body.private === true || body.visibility === 'private'
            ? 'private'
            : body.visibility === 'public'
              ? 'public'
              : undefined;
        const result = await acceptBond(loadSecret(), {
          bondId: body.bondId,
          // Omit counterparty to auto-resolve the proposer from the inbound proposal.
          counterparty: typeof body.counterparty === 'string' ? body.counterparty : undefined,
          state: bondState(body.state, 'active'),
          // Omit kind to echo the proposal's kind; passing one is a deliberate
          // choice to describe the relationship differently than the proposer.
          kind: typeof body.kind === 'string' ? body.kind : undefined,
          relays: Array.isArray(body.relays) ? (body.relays as string[]) : RELAYS,
          history: body.history === undefined ? true : Boolean(body.history),
          visibility: acceptVisibility,
        });
        return json(res, 200, await withDiscovery(result, loadSecret()));
      }
      // --- discovery (bond intents — the open board) ---
      if (path === '/intent' && method === 'POST') {
        if (!hasIdentity()) return json(res, 400, { error: 'no identity — POST /identity first' });
        const body = await readJson(req);
        if (body.status === 'closed') {
          // Record the unlist locally first, so it holds even if no relay keeps the close.
          markUnlisted(loadSecret());
          return json(res, 200, await closeIntent(loadSecret(), Array.isArray(body.relays) ? (body.relays as string[]) : RELAYS));
        }
        const seeking = Array.isArray(body.seeking)
          ? (body.seeking as unknown[]).filter((k): k is string => typeof k === 'string')
          : [];
        if (seeking.length === 0) return json(res, 400, { error: 'seeking (array of bond kinds) is required' });
        const published = await publishIntent(loadSecret(), {
          seeking,
          about: typeof body.about === 'string' ? body.about.slice(0, 400) : undefined,
          profile: typeof body.profile === 'string' ? body.profile : undefined,
          relays: Array.isArray(body.relays) ? (body.relays as string[]) : RELAYS,
        });
        // An explicit open intent is the operator re-listing: lift the unlist.
        clearUnlisted();
        return json(res, 200, published);
      }
      if (path === '/intent' && method === 'GET') {
        if (!hasIdentity()) return json(res, 200, { intent: null });
        return json(res, 200, { intent: await myIntent(loadSecret(), relaysFrom(url)) });
      }
      if (path === '/discover' && method === 'GET') {
        const selfHex = hasIdentity() ? loadIdentity().pubkeyHex : undefined;
        const result = await discover(relaysFrom(url), {
          kind: url.searchParams.get('kind') ?? undefined,
          limit: Number(url.searchParams.get('limit')) || undefined,
        }, selfHex);
        return json(res, 200, result);
      }

      if (path === '/bonds/reaffirm' && method === 'POST') {
        if (!hasIdentity()) return json(res, 400, { error: 'no identity — POST /identity first' });
        const body = await readJson(req);
        if (typeof body.bondId !== 'string') return json(res, 400, { error: 'bondId (string) is required' });
        // Core resolves the bond's counterparty + channel from this node's own
        // view unless both are given (and refuses a bond that isn't mutual) —
        // reaffirmations always follow the bond's channel.
        const counterparty = typeof body.counterparty === 'string' ? body.counterparty : undefined;
        if (counterparty) identityHex(counterparty, 'counterparty');
        const visibility: BondVisibility | undefined =
          body.visibility === 'private' || body.private === true ? 'private' : body.visibility === 'public' ? 'public' : undefined;
        const result = await reaffirmBond(loadSecret(), {
          bondId: body.bondId,
          counterparty,
          visibility,
          relays: Array.isArray(body.relays) ? (body.relays as string[]) : RELAYS,
        });
        return json(res, 200, result);
      }
      if (path === '/reaffirmations' && method === 'GET') {
        if (!hasIdentity()) return json(res, 200, { relaysReached: [], reaffirmations: [] });
        return json(res, 200, await listReaffirmations(loadSecret(), relaysFrom(url)));
      }
      if (path === '/bonds' && method === 'GET') {
        const filter: Pick<RelayFilter, 'authors' | '#d' | '#p'> = {};
        const author = url.searchParams.get('author');
        const counterparty = url.searchParams.get('counterparty');
        const bondId = url.searchParams.get('bond_id');
        // 'all' (default): public events + this node's decryptable gift wraps.
        // 'public' / 'private' narrow to one transport.
        const visibility = url.searchParams.get('visibility') ?? 'all';
        if (author) filter.authors = [identityHex(author, 'author')];
        if (counterparty) filter['#p'] = [identityHex(counterparty, 'counterparty')];
        if (bondId) filter['#d'] = [bondId];
        if (!author && !counterparty && !bondId) {
          // No filter: scope to this node's own bonds. Without an identity there's
          // nothing to scope to — return empty rather than the relays' global
          // kind:30317 firehose (other authors' events, shown as '?' bonds).
          if (!hasIdentity()) {
            return json(res, 200, {
              relaysReached: [],
              bonds: [],
              hint: 'no identity yet — create one (POST /identity) or filter with ?author=/counterparty=/bond_id=',
            });
          }
          filter.authors = [loadIdentity().pubkeyHex];
        }

        const pub =
          visibility === 'private'
            ? { relaysReached: [] as string[], bonds: [] }
            : await listBonds(filter, relaysFrom(url));
        const priv =
          visibility !== 'public' && hasIdentity()
            ? await listPrivateBonds(loadSecret(), relaysFrom(url), {
                bondId: bondId ?? undefined,
                author: author ?? undefined,
                counterparty: counterparty ?? undefined,
              })
            : { relaysReached: [] as string[], bonds: [] };

        return json(res, 200, {
          relaysReached: [...new Set([...pub.relaysReached, ...priv.relaysReached])],
          bonds: [...pub.bonds, ...priv.bonds].sort((a, b) => b.created_at - a.created_at),
        });
      }
      if (path === '/bonds/verify' && method === 'GET') {
        return await handleVerify(res, url, ln, { authed: true, client: clientAddress(req) });
      }

      // --- wallet (non-custodial sats via NWC) ---
      if (path === '/wallet/connect' && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.nwc !== 'string') return json(res, 400, { error: 'nwc (nostr+walletconnect:// URI) required' });
        try {
          const provider = lightningFrom(body.nwc);
          if (!provider) return json(res, 400, { error: 'invalid NWC URI' });
          saveNwcUri(body.nwc);
          lightning = provider;
          return json(res, 200, { connected: true });
        } catch (error) {
          return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (path === '/wallet/disconnect' && method === 'POST') {
        clearNwcUri();
        lightning = null;
        return json(res, 200, { connected: false });
      }
      if (path === '/wallet' && method === 'GET') {
        if (!ln) return json(res, 200, { connected: false, hint: 'connect a wallet via the UI or POST /wallet/connect' });
        const info = await ln.getInfo().catch((e) => ({ error: String(e) }));
        const balanceSats = await ln.getBalanceSats().catch(() => null);
        const capabilities = await ln.getCapabilities().catch(() => null);
        return json(res, 200, { connected: true, balanceSats, capabilities, info });
      }
      if (path === '/wallet/invoice' && method === 'POST') {
        if (!ln) return json(res, 400, { error: 'no wallet connected' });
        const body = await readJson(req);
        const amountSats = Number(body.amountSats);
        if (!Number.isFinite(amountSats) || amountSats <= 0) {
          return json(res, 400, { error: 'amountSats (positive number) required' });
        }
        const description = typeof body.description === 'string' ? body.description : undefined;
        const inv = await ln.makeInvoice(amountSats, description);
        recordPaymentHash(inv.paymentHash);
        return json(res, 200, inv);
      }
      if (path === '/wallet/invoice' && method === 'GET') {
        if (!ln) return json(res, 400, { error: 'no wallet connected' });
        const paymentHash = url.searchParams.get('payment_hash') ?? undefined;
        const invoice = url.searchParams.get('invoice') ?? undefined;
        if (!paymentHash && !invoice) return json(res, 400, { error: 'payment_hash or invoice query param required' });
        return json(res, 200, await ln.lookupInvoice({ paymentHash, invoice }));
      }
      if (path === '/wallet/pay' && method === 'POST') {
        if (!ln) return json(res, 400, { error: 'no wallet connected' });
        const body = await readJson(req);
        if (typeof body.invoice !== 'string') return json(res, 400, { error: 'invoice (bolt11 string) required' });
        const amountSats = typeof body.amountSats === 'number' ? body.amountSats : undefined;
        const payment = await ln.payInvoice(body.invoice, amountSats);
        recordPaymentHash(payment.paymentHash);
        return json(res, 200, payment);
      }
      if (path === '/wallet/transactions' && method === 'GET') {
        if (!ln) return json(res, 400, { error: 'no wallet connected' });
        const limit = Number(url.searchParams.get('limit')) || 20;
        const unpaid = url.searchParams.get('unpaid') === 'true';
        // Scope to Pact-originated payments by default so the agent never sees
        // unrelated transactions from other apps on a shared NWC wallet/node.
        // ?all=true returns the whole wallet (operator escape hatch).
        const all = url.searchParams.get('all') === 'true';
        const fetched = await ln.listTransactions({ limit: all ? limit : 200, unpaid });
        const transactions = all ? fetched : fetched.filter((t) => ownsPaymentHash(t.paymentHash)).slice(0, limit);
        return json(res, 200, { scope: all ? 'all' : 'pact', count: transactions.length, transactions });
      }

      // --- relays (where bonds are published/resolved) ---
      if (path === '/relays' && method === 'GET') {
        return json(res, 200, {
          relays: RELAYS,
          custom: relaysAreCustom(),
          default: DEFAULT_RELAYS,
        });
      }
      if (path === '/relays' && method === 'POST') {
        const body = await readJson(req);
        if (!Array.isArray(body.relays)) return json(res, 400, { error: 'relays (array of ws:// or wss:// URLs) required' });
        const relays = (body.relays as unknown[])
          .filter((r): r is string => typeof r === 'string')
          .map((r) => r.trim())
          .filter(Boolean);
        if (relays.length === 0) return json(res, 400, { error: 'at least one relay URL required' });
        const bad = relays.find((r) => !/^wss?:\/\//.test(r));
        if (bad) return json(res, 400, { error: `invalid relay URL (must start with ws:// or wss://): ${bad}` });
        saveRelays(relays);
        RELAYS = relays;
        return json(res, 200, { relays: RELAYS, custom: true });
      }

      // --- event stream (inbox / heartbeat) ---
      if (path === '/events' && method === 'GET') return startEventStream(req, res, url);

      return json(res, 404, { error: 'not found', path });
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      if (error instanceof PactError) {
        const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
        return json(res, status, { error: error.message });
      }
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

/**
 * GET /bonds/verify. The verdict itself is core's verifyBond (one mutual rule
 * for the daemon, SDK and CLI). Only the authenticated operator gets the
 * gift-wrapped sides this node can decrypt, and only the operator may choose
 * which relays the daemon dials: an anonymous caller (the paid market) is
 * verified against the configured set, so `?relay=` can't point the daemon at
 * arbitrary hosts. `?party=` (repeatable) names claimed parties to fetch
 * directly, so a flood of other authors on the bond id can't crowd them out.
 */
async function handleVerify(
  res: ServerResponse,
  url: URL,
  ln: LightningProvider | null,
  caller: { authed: boolean; client: string },
): Promise<void> {
  const bondId = url.searchParams.get('bond_id');
  if (!bondId) return json(res, 400, { error: 'bond_id query param required' });
  const partyParams = url.searchParams.getAll('party');
  if (partyParams.length > MAX_VERIFY_PARTIES) {
    return json(res, 400, { error: `at most ${MAX_VERIFY_PARTIES} party params` });
  }
  const parties = [...new Set(partyParams.map((p) => identityHex(p, 'party')))];
  const relays = caller.authed ? relaysFrom(url) : RELAYS;

  // Paid-verification market (L402-style). Active only when a price is set
  // AND a wallet is connected to collect to. First request → 402 + invoice;
  // retry with ?payment_hash=<hash> once paid.
  const paywalled = VERIFY_PRICE_SATS > 0 && Boolean(ln);
  if (paywalled && ln) {
    const paymentHash = url.searchParams.get('payment_hash');
    if (!paymentHash) {
      // Each invoice is a bearer token for one verification, so it is never
      // shared between requesters; issuing is bounded instead.
      if (!caller.authed) {
        if (pendingVerificationCountFor(caller.client) >= VERIFY_MAX_PENDING_PER_CLIENT) {
          res.setHeader('Retry-After', '60');
          return json(res, 429, { error: 'too many unpaid verification invoices outstanding for this client — pay or wait for them to expire' });
        }
        if (pendingVerificationCount() >= VERIFY_MAX_PENDING) {
          res.setHeader('Retry-After', '60');
          return json(res, 429, { error: 'too many unpaid verification invoices outstanding — retry later' });
        }
        if (!takeInvoiceSlot(caller.client)) {
          res.setHeader('Retry-After', '60');
          return json(res, 429, { error: 'too many verification invoices requested — retry later' });
        }
      }
      const inv = await ln.makeInvoice(VERIFY_PRICE_SATS, `pact: verify ${bondId}`, VERIFICATION_INVOICE_EXPIRY_SECS);
      if (!inv.paymentHash) {
        return json(res, 502, { error: 'wallet returned no payment hash; cannot gate verification' });
      }
      recordPaymentHash(inv.paymentHash);
      // Bind this invoice to this bond, single-use — see ledger.ts. Throws if
      // it can't be persisted: never hand out an invoice we can't honor.
      recordVerificationInvoice(inv.paymentHash, bondId, Date.now(), caller.authed ? undefined : caller.client);
      return json(res, 402, {
        error: 'payment required',
        price_sats: VERIFY_PRICE_SATS,
        invoice: inv.invoice,
        payment_hash: inv.paymentHash,
        hint: 'pay the invoice, then retry with &payment_hash=<hash>',
      });
    }
    // Anonymous redemption checks are throttled too (own bucket, 3× the
    // issuance budget: a buyer polls a few times while paying): a valid unpaid
    // hash would otherwise cost the operator one NWC round trip per request.
    if (!caller.authed && !takeInvoiceSlot(`${caller.client}#redeem`, Date.now(), VERIFY_INVOICES_PER_MIN * 3)) {
      res.setHeader('Retry-After', '60');
      return json(res, 429, { error: 'too many verification requests — retry later' });
    }
    // Reject before bothering the wallet: the hash must be one we issued,
    // for THIS bond, and not already redeemed. (Cheap local pre-check.)
    const status = verificationStatus(paymentHash, bondId);
    if (status === 'unknown') {
      return json(res, 402, { error: 'unknown payment hash — request a fresh invoice for this bond', price_sats: VERIFY_PRICE_SATS });
    }
    if (status === 'wrong_bond') {
      return json(res, 402, { error: 'payment hash was issued for a different bond', price_sats: VERIFY_PRICE_SATS });
    }
    if (status === 'spent') {
      return json(res, 402, { error: 'payment already redeemed — verification invoices are single-use', price_sats: VERIFY_PRICE_SATS });
    }
    const look = await ln.lookupInvoice({ paymentHash });
    if (!look.paid) {
      return json(res, 402, { error: 'invoice not settled yet', payment_hash: paymentHash, price_sats: VERIFY_PRICE_SATS });
    }
    // Authoritative single-use consume (synchronous after the await; wins
    // the race). Throws (→ 500, nothing served) if it can't be persisted.
    if (!consumeVerification(paymentHash, bondId)) {
      return json(res, 402, { error: 'payment already redeemed — verification invoices are single-use', price_sats: VERIFY_PRICE_SATS });
    }
  }

  // Public events always count; gift-wrapped sides are included when this
  // node holds a key that can decrypt them AND the caller is the operator.
  // To anyone else a private bond is invisible — disclosure-mediated by design.
  const secret = caller.authed && hasIdentity() ? loadSecret() : undefined;
  const verdict = await verifyBond(bondId, relays, { ...(secret ? { secret } : {}), ...(parties.length ? { parties } : {}) });
  return json(res, 200, {
    bond_id: bondId,
    paid: paywalled ? true : undefined,
    price_sats: paywalled ? VERIFY_PRICE_SATS : undefined,
    ...verdict,
  });
}

/**
 * SSE stream of bonds that p-tag this agent (inbound proposals + counterparty
 * state changes). Polls relays on an interval — the daemon's heartbeat/inbox.
 */
function startEventStream(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!hasIdentity()) return json(res, 400, { error: 'no identity — POST /identity first' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const self = loadIdentity().pubkeyHex;
  const relays = relaysFrom(url);
  // A typo (?interval=x) must not become NaN → a 1 ms timer hammering relays.
  const requested = Number(url.searchParams.get('interval') ?? 30000);
  const intervalMs = Number.isFinite(requested) ? Math.max(5000, requested) : 30000;
  const seen = new Map<string, string>();

  res.write(`event: ready\ndata: ${JSON.stringify({ pubkey: self, intervalMs })}\n\n`);

  const poll = async (): Promise<void> => {
    try {
      const [pub, priv] = await Promise.all([
        listBonds({ '#p': [self] }, relays),
        listPrivateBonds(loadSecret(), relays, { counterparty: self }),
      ]);
      for (const b of [...pub.bonds, ...priv.bonds]) {
        const key = `${b.bond}:${b.author}:${b.visibility}`;
        if (seen.get(key) !== (b.state ?? '')) {
          seen.set(key, b.state ?? '');
          res.write(`event: bond\ndata: ${JSON.stringify(b)}\n\n`);
        }
      }
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(error) })}\n\n`);
    }
  };

  // Re-arm only after a poll settles, so slow relays can't stack polls up.
  let closed = false;
  let pollTimer: NodeJS.Timeout | undefined;
  const loop = async (): Promise<void> => {
    await poll();
    if (!closed) pollTimer = setTimeout(() => void loop(), intervalMs);
  };
  void loop();
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => {
    closed = true;
    clearTimeout(pollTimer);
    clearInterval(keepalive);
  });
}
