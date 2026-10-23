// HTTP attack-surface regression for pactd. The proven chain this suite locks:
// default-open daemon + any-content-type body parsing + no Host/Origin checks
// meant any webpage in the operator's browser could drive writes (CSRF via
// no-preflight text/plain posts), and DNS rebinding could read the API. The
// daemon is now auth-default-on (persisted 0600 token), JSON-only for bodies,
// same-origin for mutating browser requests, and Host-allowlisted on loopback.
//
// Env is read at module import, so this file sets a scratch PACT_HOME /
// PACT_RELAYS BEFORE the dynamic import of the server module (and listens on
// an ephemeral 127.0.0.1 port; the only outbound connections go to the
// in-process mock relay).

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startMockRelay, type MockRelay } from './mock-relay.js';

interface RawResponse {
  status: number;
  body: string;
  json(): unknown;
}

let dir: string;
let relay: MockRelay;
let server: Server;
let port: number;
let sanitizeRelayUrl: (raw: string) => string | undefined;

function daemonToken(): string {
  // The auto-generated token must exist, persisted with operator-only perms.
  const p = join(dir, 'token');
  const token = readFileSync(p, 'utf8').trim();
  expect(token.length).toBeGreaterThan(0);
  expect(statSync(p).mode & 0o777).toBe(0o600);
  return token;
}

function req(opts: {
  method?: string;
  path: string;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  // A body must declare application/json — the daemon's no-preflight CSRF
  // gate (readJson) refuses body-bearing requests without it.
  if (opts.body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          const parsed = (): unknown => JSON.parse(body);
          resolve({ status: res.statusCode ?? 0, body, json: parsed });
        });
      },
    );
    r.on('error', reject);
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pact-httpsec-'));
  relay = await startMockRelay();
  process.env.PACT_HOME = dir;
  process.env.PACT_RELAYS = relay.url; // daemon default relay → in-process mock
  for (const k of [
    'PACT_TOKEN',
    'PACT_AUTO_TOKEN',
    'PACT_NO_AUTH',
    'PACT_HOST',
    'PACT_PUBLIC_MODE',
    'PACT_NWC',
    'PACT_VERIFY_PRICE_SATS',
  ]) {
    delete process.env[k];
  }
  vi.resetModules();
  const serverMod = await import('../packages/pactd/src/server.js');
  const relayMod = await import('../packages/pactd/src/relayconfig.js');
  sanitizeRelayUrl = relayMod.sanitizeRelayUrl;
  server = serverMod.createDaemon();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await relay.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PACT_HOME;
  delete process.env.PACT_RELAYS;
});

describe('auth is default-on with a persisted 0600 token', () => {
  it('rejects API calls without a token and accepts the persisted one', async () => {
    // Given a daemon started with NO PACT_TOKEN (default config),
    // When the API is hit without Authorization,
    // Then the request is rejected.
    const unauth = await req({ path: '/identity' });
    expect(unauth.status).toBe(401);
    const wrong = await req({ path: '/identity', token: 'not-the-token' });
    expect(wrong.status).toBe(401);

    // When the persisted token from PACT_HOME is presented,
    // Then identity creation + reads succeed (same-machine client flow).
    const token = daemonToken();
    const created = await req({ method: 'POST', path: '/identity', token });
    expect(created.status).toBe(200);
    const authed = await req({ path: '/identity', token });
    expect(authed.status).toBe(200);
  });
});

describe('content-type gate (CSRF via no-preflight form posts)', () => {
  it('rejects text/plain bodies with 415 and accepts application/json', async () => {
    const token = daemonToken();
    // Given a valid token, When a write arrives as text/plain (what a browser
    // form can send without a preflight), Then it is refused before parsing.
    const formPost = await req({
      method: 'POST',
      path: '/identity',
      token,
      headers: { 'content-type': 'text/plain' },
      body: '{"force":false}',
    });
    expect(formPost.status).toBe(415);
    // application/json (parameters allowed) is the sole accepted media type.
    const jsonPost = await req({
      method: 'POST',
      path: '/identity',
      token,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: '{"force":false}',
    });
    expect(jsonPost.status).toBe(200);
  });
});

describe('origin check on mutating requests', () => {
  it('rejects cross-origin posts and allows absent/same Origin', async () => {
    const token = daemonToken();
    // Given a valid token, When a mutating request carries a foreign Origin,
    // Then 403 — a browser page on another origin cannot drive the API.
    const evil = await req({
      method: 'POST',
      path: '/identity',
      token,
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.status).toBe(403);
    // Absent Origin (curl, server-to-server, MCP) is allowed.
    const curl = await req({ method: 'POST', path: '/identity', token });
    expect(curl.status).toBe(200);
    // Same-origin (the operator UI served by this daemon) is allowed.
    const sameOrigin = await req({
      method: 'POST',
      path: '/identity',
      token,
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    expect(sameOrigin.status).toBe(200);
  });
});

describe('host allowlist on loopback binds (DNS rebinding)', () => {
  it('rejects foreign Host even with a valid token and on open routes', async () => {
    const token = daemonToken();
    const rebound = await req({
      path: '/identity',
      token,
      headers: { host: 'evil.example' },
    });
    expect(rebound.status).toBe(403);
    const reboundHealth = await req({ path: '/healthz', headers: { host: 'evil.example' } });
    expect(reboundHealth.status).toBe(403);
  });
});

describe('unauthenticated shell routes', () => {
  it('serves / without the token anywhere in the HTML, and /healthz openly', async () => {
    const token = daemonToken();
    const ui = await req({ path: '/' });
    expect(ui.status).toBe(200);
    expect(ui.body).not.toContain(token);
    const health = await req({ path: '/healthz' });
    expect(health.status).toBe(200);
  });
});

describe('relay URL sanitization (SSRF pivot)', () => {
  it('sanitizeRelayUrl admits only bare ws:// and wss:// URLs', () => {
    expect(sanitizeRelayUrl('urn:foo')).toBeUndefined();
    expect(sanitizeRelayUrl('https://x')).toBeUndefined();
    expect(sanitizeRelayUrl('ws://user:pass@127.0.0.1:9876/x')).toBeUndefined();
    expect(sanitizeRelayUrl('ws://exa mple.com')).toBeUndefined();
    expect(sanitizeRelayUrl('not a url')).toBeUndefined();
    expect(sanitizeRelayUrl('ws://127.0.0.1:9876/x')).toBe('ws://127.0.0.1:9876/x');
    expect(sanitizeRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com');
    expect(sanitizeRelayUrl('  wss://relay.example.com/nip  ')).toBe('wss://relay.example.com/nip');
  });

  it('ignores invalid ?relay= overrides, falling back to the configured set', async () => {
    const token = daemonToken();
    // Given ?relay= overrides that fail sanitization, When bonds are queried,
    // Then the daemon never dials them — it uses the configured (mock) relay.
    const res = await req({ path: '/bonds?relay=urn:foo&relay=https://x', token });
    expect(res.status).toBe(200);
    const reached = (res.json() as { relaysReached: string[] }).relaysReached;
    expect(reached).toContain(relay.url);
    expect(reached.some((r) => !r.startsWith('ws'))).toBe(false);
    // A valid ws:// override is honored.
    const ok = await req({ path: `/bonds?relay=${encodeURIComponent(relay.url)}`, token });
    expect(ok.status).toBe(200);
    expect((ok.json() as { relaysReached: string[] }).relaysReached).toContain(relay.url);
  });

  it('POST /relays rejects the whole request with a 400 naming the bad URLs', async () => {
    const token = daemonToken();
    const bad = await req({
      method: 'POST',
      path: '/relays',
      token,
      body: JSON.stringify({ relays: ['ws://user:pass@127.0.0.1:9876/x', 'wss://ok.example'] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(bad.status).toBe(400);
    expect((bad.json() as { error: string }).error).toContain('ws://user:pass@127.0.0.1:9876/x');
    // An all-valid set is accepted and persisted (also proves the 400 above
    // did not partially apply the good entry: it appears only now).
    const good = await req({
      method: 'POST',
      path: '/relays',
      token,
      body: JSON.stringify({ relays: ['ws://127.0.0.1:9876/x'] }),
      headers: { 'content-type': 'application/json' },
    });
    expect(good.status).toBe(200);
    const listed = (good.json() as { relays: string[] }).relays;
    expect(listed).toEqual(['ws://127.0.0.1:9876/x']);
  });
});

describe('no CORS preflight surface', () => {
  it('OPTIONS is 404, not a route', async () => {
    const res = await req({ method: 'OPTIONS', path: '/identity' });
    expect(res.status).toBe(404);
  });
});
