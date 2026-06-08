import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import {
  DEFAULT_RELAYS,
  ensureIdentity,
  formBond,
  hasIdentity,
  listBonds,
  loadIdentity,
  loadSecret,
  pubkeyHexFromIdentity,
  type BondState,
  type RelayFilter,
} from '@pact/core';

import { lightningFromEnv } from './lightning.js';

export const VERSION = '0.1.0';

const TOKEN = process.env.PACT_TOKEN; // optional bearer token for local access control
const lightning = lightningFromEnv(); // null unless PACT_NWC is set

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
  return relays.length ? relays : DEFAULT_RELAYS;
}

export function createDaemon() {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // Health is unauthenticated.
      if (path === '/healthz') return json(res, 200, { ok: true, version: VERSION, wallet: Boolean(lightning) });

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
        if (typeof body.counterparty !== 'string' || typeof body.bondId !== 'string') {
          return json(res, 400, { error: 'counterparty and bondId (strings) are required' });
        }
        const result = await formBond(loadSecret(), {
          counterparty: body.counterparty,
          bondId: body.bondId,
          state: (typeof body.state === 'string' ? body.state : 'proposed') as BondState,
          kind: typeof body.kind === 'string' ? body.kind : undefined,
          relays: Array.isArray(body.relays) ? (body.relays as string[]) : undefined,
          history: body.history === undefined ? true : Boolean(body.history),
        });
        return json(res, 200, result);
      }
      if (path === '/bonds' && method === 'GET') {
        const filter: Pick<RelayFilter, 'authors' | '#d' | '#p'> = {};
        const author = url.searchParams.get('author');
        const counterparty = url.searchParams.get('counterparty');
        const bondId = url.searchParams.get('bond_id');
        if (author) filter.authors = [pubkeyHexFromIdentity(author)];
        if (counterparty) filter['#p'] = [pubkeyHexFromIdentity(counterparty)];
        if (bondId) filter['#d'] = [bondId];
        if (!author && !counterparty && !bondId && hasIdentity()) filter.authors = [loadIdentity().pubkeyHex];
        return json(res, 200, await listBonds(filter, relaysFrom(url)));
      }
      if (path === '/bonds/verify' && method === 'GET') {
        const bondId = url.searchParams.get('bond_id');
        if (!bondId) return json(res, 400, { error: 'bond_id query param required' });
        const { relaysReached, bonds } = await listBonds({ '#d': [bondId] }, relaysFrom(url));
        const authors = new Set(bonds.map((b) => b.author));
        const mutual =
          bonds.length >= 2 &&
          bonds.every((b) => b.signature_valid) &&
          bonds.some((b) => authors.has(b.counterparty ?? ''));
        return json(res, 200, { bond_id: bondId, relaysReached, count: bonds.length, mutual, bonds });
      }

      // --- wallet (non-custodial sats via NWC) ---
      if (path === '/wallet' && method === 'GET') {
        if (!lightning) return json(res, 200, { connected: false, hint: 'set PACT_NWC to a nostr+walletconnect:// URI' });
        const info = await lightning.getInfo().catch((e) => ({ error: String(e) }));
        const balanceSats = await lightning.getBalanceSats().catch(() => null);
        return json(res, 200, { connected: true, balanceSats, info });
      }
      if (path === '/wallet/invoice' && method === 'POST') {
        if (!lightning) return json(res, 400, { error: 'no wallet connected — set PACT_NWC' });
        const body = await readJson(req);
        const amountSats = Number(body.amountSats);
        if (!Number.isFinite(amountSats) || amountSats <= 0) {
          return json(res, 400, { error: 'amountSats (positive number) required' });
        }
        const description = typeof body.description === 'string' ? body.description : undefined;
        return json(res, 200, await lightning.makeInvoice(amountSats, description));
      }
      if (path === '/wallet/invoice' && method === 'GET') {
        if (!lightning) return json(res, 400, { error: 'no wallet connected — set PACT_NWC' });
        const paymentHash = url.searchParams.get('payment_hash') ?? undefined;
        const invoice = url.searchParams.get('invoice') ?? undefined;
        if (!paymentHash && !invoice) return json(res, 400, { error: 'payment_hash or invoice query param required' });
        return json(res, 200, await lightning.lookupInvoice({ paymentHash, invoice }));
      }
      if (path === '/wallet/pay' && method === 'POST') {
        if (!lightning) return json(res, 400, { error: 'no wallet connected — set PACT_NWC' });
        const body = await readJson(req);
        if (typeof body.invoice !== 'string') return json(res, 400, { error: 'invoice (bolt11 string) required' });
        return json(res, 200, await lightning.payInvoice(body.invoice));
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
      const { bonds } = await listBonds({ '#p': [self] }, relays);
      for (const b of bonds) {
        const key = `${b.bond}:${b.author}`;
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
