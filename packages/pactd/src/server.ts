import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  DEFAULT_RELAYS,
  acceptBond,
  ensureIdentity,
  formBond,
  hasIdentity,
  listBonds,
  listPrivateBonds,
  listReaffirmations,
  reaffirmBond,
  loadIdentity,
  loadSecret,
  pubkeyHexFromIdentity,
  type BondState,
  type BondVisibility,
  type RelayFilter,
} from 'pact-core';

import { ownsPaymentHash, recordPaymentHash } from './ledger.js';
import { lightningFrom } from './lightning.js';
import { relaysAreCustom, resolveRelays, saveRelays } from './relayconfig.js';
import { resolveToken } from './tokenconfig.js';
import { renderUI } from './ui.js';
import { clearNwcUri, loadNwcUri, saveNwcUri } from './walletconfig.js';

export const VERSION = '0.16.0';

// Bearer token for API access. PACT_TOKEN, else an auto-generated persisted
// token when PACT_AUTO_TOKEN is set, else undefined (open — loopback only).
const TOKEN = resolveToken();

// Public-exposure mode: when set, the status UI never embeds the bearer token in
// the page HTML (the operator enters it; agents read it from config). Turn this
// on for any node reachable beyond a trusted LAN / login (e.g. a public reverse
// proxy), so loading the page can't leak the token to anonymous visitors.
const PUBLIC_MODE = !['', '0', 'false'].includes((process.env.PACT_PUBLIC_MODE ?? '').toLowerCase());
// Wallet provider: configured at runtime (via the UI / POST /wallet/connect,
// persisted in PACT_HOME) or from PACT_NWC. Mutable so it can be (re)connected.
let lightning = lightningFrom(loadNwcUri());

// Paid-verification market (opt-in): price in sats to verify a bond. 0 = free.
// Only enforced when a wallet is connected (otherwise there's no way to collect).
const VERIFY_PRICE_SATS = Math.max(0, Math.floor(Number(process.env.PACT_VERIFY_PRICE_SATS) || 0));

// Active relay set. Resolution: relays.json (set via the UI / POST /relays) >
// PACT_RELAYS env > the protocol defaults. Mutable so it can be (re)configured
// at runtime — pick public relays, a bundled relay, or another relay app.
let RELAYS = resolveRelays();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        req.destroy();
        reject(new Error('request body too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

function relaysFrom(url: URL): string[] {
  const relays = url.searchParams.getAll('relay');
  return relays.length ? relays : RELAYS;
}

export function createDaemon() {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const ln = lightning; // per-request snapshot (const → narrows across awaits)

      // Status UI + health are unauthenticated (the UI itself injects the token
      // for its API calls; on Umbrel the page is behind app_proxy).
      if (path === '/' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(renderUI(TOKEN, process.env.PACT_PUBLIC_PORT, process.env.PACT_RELAY_PUBLIC_PORT, PUBLIC_MODE));
      }
      if (path === '/healthz') {
        return json(res, 200, {
          ok: true,
          version: VERSION,
          wallet: Boolean(ln),
          verifyPriceSats: VERIFY_PRICE_SATS || undefined,
        });
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
        return json(res, 200, ensureIdentity(Boolean(body.force)));
      }

      // --- bonds ---
      if (path === '/bonds' && method === 'POST') {
        if (!hasIdentity()) return json(res, 400, { error: 'no identity — POST /identity first' });
        const body = await readJson(req);
        if (typeof body.counterparty !== 'string') {
          return json(res, 400, { error: 'counterparty (string) is required' });
        }
        const visibility = body.private === true || body.visibility === 'private' ? 'private' : 'public';
        const result = await formBond(loadSecret(), {
          counterparty: body.counterparty,
          // Omit bondId to auto-generate urn:mate:<uuid> (the proposer's id).
          bondId: typeof body.bondId === 'string' ? body.bondId : undefined,
          state: (typeof body.state === 'string' ? body.state : 'proposed') as BondState,
          kind: typeof body.kind === 'string' ? body.kind : undefined,
          relays: Array.isArray(body.relays) ? (body.relays as string[]) : RELAYS,
          // History events are public-transport only; private bonds carry their
          // canonical timestamp in the rumor.
          history: visibility === 'private' ? false : body.history === undefined ? true : Boolean(body.history),
          visibility,
        });
        return json(res, 200, result);
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
          state: (typeof body.state === 'string' ? body.state : 'active') as BondState,
          kind: typeof body.kind === 'string' ? body.kind : undefined,
          relays: Array.isArray(body.relays) ? (body.relays as string[]) : RELAYS,
          history: body.history === undefined ? true : Boolean(body.history),
          visibility: acceptVisibility,
        });
        return json(res, 200, result);
      }
      if (path === '/bonds/reaffirm' && method === 'POST') {
        if (!hasIdentity()) return json(res, 400, { error: 'no identity — POST /identity first' });
        const body = await readJson(req);
        if (typeof body.bondId !== 'string') return json(res, 400, { error: 'bondId (string) is required' });
        // Resolve the bond's counterparty + channel from this node's own view
        // unless given — reaffirmations always follow the bond's channel.
        let counterparty = typeof body.counterparty === 'string' ? body.counterparty : undefined;
        let visibility: BondVisibility | undefined =
          body.visibility === 'private' || body.private === true ? 'private' : body.visibility === 'public' ? 'public' : undefined;
        if (!counterparty || !visibility) {
          const selfHex = loadIdentity().pubkeyHex;
          const [pub, priv] = await Promise.all([
            listBonds({ '#d': [body.bondId], authors: [selfHex] }, RELAYS),
            listPrivateBonds(loadSecret(), RELAYS, { bondId: body.bondId, author: selfHex }),
          ]);
          const own = [...priv.bonds, ...pub.bonds][0];
          if (!own) return json(res, 404, { error: `no bond ${body.bondId} authored by this node — form or accept it first` });
          counterparty = counterparty ?? own.counterparty ?? undefined;
          visibility = visibility ?? own.visibility;
        }
        if (!counterparty) return json(res, 400, { error: 'could not resolve counterparty — pass it explicitly' });
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
        if (author) filter.authors = [pubkeyHexFromIdentity(author)];
        if (counterparty) filter['#p'] = [pubkeyHexFromIdentity(counterparty)];
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
        const bondId = url.searchParams.get('bond_id');
        if (!bondId) return json(res, 400, { error: 'bond_id query param required' });

        // Paid-verification market (L402-style). Active only when a price is set
        // AND a wallet is connected to collect to. First request → 402 + invoice;
        // retry with ?payment_hash=<hash> once paid.
        const paywalled = VERIFY_PRICE_SATS > 0 && Boolean(ln);
        if (paywalled && ln) {
          const paymentHash = url.searchParams.get('payment_hash');
          if (!paymentHash) {
            const inv = await ln.makeInvoice(VERIFY_PRICE_SATS, `pact: verify ${bondId}`);
            recordPaymentHash(inv.paymentHash);
            return json(res, 402, {
              error: 'payment required',
              price_sats: VERIFY_PRICE_SATS,
              invoice: inv.invoice,
              payment_hash: inv.paymentHash,
              hint: 'pay the invoice, then retry with &payment_hash=<hash>',
            });
          }
          const look = await ln.lookupInvoice({ paymentHash });
          if (!look.paid) {
            return json(res, 402, { error: 'invoice not settled yet', payment_hash: paymentHash, price_sats: VERIFY_PRICE_SATS });
          }
        }

        // Public events always count; gift-wrapped sides are included when this
        // node holds a key that can decrypt them. To anyone else a private bond
        // is invisible — verification of one is disclosure-mediated by design.
        const pubSide = await listBonds({ '#d': [bondId] }, relaysFrom(url));
        const privSide = hasIdentity()
          ? await listPrivateBonds(loadSecret(), relaysFrom(url), { bondId })
          : { relaysReached: [] as string[], bonds: [] };
        const bonds = [...pubSide.bonds, ...privSide.bonds];
        const authors = new Set(bonds.map((b) => b.author));
        const mutual =
          bonds.length >= 2 &&
          bonds.every((b) => b.signature_valid) &&
          bonds.some((b) => authors.has(b.counterparty ?? ''));
        return json(res, 200, {
          bond_id: bondId,
          paid: paywalled ? true : undefined,
          price_sats: paywalled ? VERIFY_PRICE_SATS : undefined,
          relaysReached: [...new Set([...pubSide.relaysReached, ...privSide.relaysReached])],
          count: bonds.length,
          mutual,
          private: bonds.some((b) => b.visibility === 'private') || undefined,
          bonds,
        });
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
      return json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
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
  const intervalMs = Math.max(5000, Number(url.searchParams.get('interval') ?? 30000));
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

  void poll();
  const pollTimer = setInterval(() => void poll(), intervalMs);
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => {
    clearInterval(pollTimer);
    clearInterval(keepalive);
  });
}
