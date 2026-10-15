// Regression for the stored-XSS audit finding in the pactd operator UI:
// a kind:30317 event's relay-controlled strings (the bond id `d` tag, pubkey
// fields, kind) used to be interpolated into double-quoted HTML attributes
// (data-bond="…", title="…") with an esc() that does not escape quotes, so
//   d = x" autofocus onfocus="alert(1)
// broke out into a live, auto-firing handler. It also shipped the daemon
// bearer token as a JS const in the served page, giving injected script full
// API control. This suite runs the real served page in jsdom against stubbed
// API responses and proves untrusted data lands as inert text only.

import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

import { renderUI } from '../packages/pactd/src/ui.js';

const TEST_TOKEN = 'pact-test-token-0123456789abcdef';
const MY_HEX = '11'.repeat(32);
const OTHER_HEX = '22'.repeat(32);
const MY_NPUB = 'npub1' + 'q'.repeat(58);

// The exact PoC attribute-injection shape, with observable canaries in place
// of alert() so the test can detect execution.
const PAYLOAD_BADSIG = 'x" autofocus onfocus="globalThis.__pwned=1';
const PAYLOAD_VALIDSIG = 'y" autofocus onfocus="globalThis.__pwned=2';

// A bond record shaped like what GET /bonds returns; `bond` is the relay-
// controlled bond id, `author` the relay-controlled pubkey, `kind` relay-
// controlled free text.
function bondRecord(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    bond: 'bond-default',
    author: OTHER_HEX,
    created_at: 1000,
    state: 'proposed',
    visibility: 'public',
    kind: null,
    signature_valid: true,
    counterparty: MY_HEX,
    ...over,
  };
}

const ROWS = [
  // Garbage-signature variant: payload in the bond id AND kind, bad sig.
  bondRecord({
    id: 'evt-badsig',
    bond: PAYLOAD_BADSIG,
    kind: PAYLOAD_BADSIG,
    signature_valid: false,
    created_at: 1000,
  }),
  // Valid-signature variant: same payload shape, verifies fine.
  bondRecord({
    id: 'evt-validsig',
    bond: PAYLOAD_VALIDSIG,
    kind: PAYLOAD_VALIDSIG,
    signature_valid: true,
    created_at: 1001,
  }),
  // The title-attribute vector: npubFromHex() passes non-hex input through
  // raw, so a non-hex author also reaches a quoted attribute.
  bondRecord({
    id: 'evt-titlevec',
    bond: 'bond-title-vector',
    author: PAYLOAD_BADSIG,
    kind: null,
    created_at: 1002,
  }),
];

interface StubResponse {
  status: number;
  json: () => Promise<unknown>;
}
interface FetchInit {
  method?: string;
  body?: string;
}
type FetchStub = (url: string, init?: FetchInit) => Promise<StubResponse>;
interface StubbedWindow {
  fetch: FetchStub;
  EventSource: unknown;
}
interface ApiCall {
  method: string;
  url: string;
  body: unknown;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for the page to render');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('pactd operator UI', () => {
  it('never ships the bearer token in served HTML and sets a CSP', () => {
    for (const publicMode of [false, true]) {
      const html = renderUI(TEST_TOKEN, undefined, undefined, publicMode);
      expect(html).not.toContain(TEST_TOKEN);
      expect(html).toContain('http-equiv="Content-Security-Policy"');
    }
  });

  it('renders relay-supplied bond data as inert text, never as attributes', async () => {
    const calls: ApiCall[] = [];
    const html = renderUI(TEST_TOKEN, undefined, undefined, false);
    const dom = new JSDOM(html, {
      url: 'http://127.0.0.1:8787/',
      runScripts: 'dangerously',
      beforeParse(window) {
        const w = window as unknown as StubbedWindow;
        w.fetch = async (url, init) => {
          const u = String(url);
          const method = (init && init.method) || 'GET';
          let body: unknown = {};
          if (method !== 'GET') {
            let parsed: unknown;
            try {
              parsed = init && init.body ? JSON.parse(String(init.body)) : undefined;
            } catch {
              parsed = undefined;
            }
            calls.push({ method, url: u, body: parsed });
          }
          if (method === 'GET') {
            if (u.startsWith('/healthz')) body = { version: '0.0.0-test' };
            else if (u.startsWith('/identity'))
              body = { pubkeyHex: MY_HEX, npub: MY_NPUB, did: 'did:nostr:' + MY_NPUB };
            else if (u.startsWith('/bonds')) body = { bonds: ROWS };
            else if (u.startsWith('/reaffirmations')) body = { reaffirmations: [] };
            else if (u.startsWith('/intent')) body = {};
            else if (u.startsWith('/discover')) body = { candidates: [] };
            else if (u.startsWith('/wallet')) body = { connected: false };
            else if (u.startsWith('/relays')) body = { relays: [], custom: true, default: [] };
          }
          return { status: 200, json: async () => body };
        };
        w.EventSource = class {
          close(): void {}
        };
      },
    });

    try {
      const doc = dom.window.document;
      await waitFor(() => doc.querySelectorAll('.bond').length === ROWS.length);

      // Drive focus into anything carrying an injected handler (jsdom does
      // not run autofocus focusing steps on parse, so exercise it manually —
      // on the vulnerable page this is what the auto-fire does in a browser).
      for (const node of Array.from(doc.querySelectorAll('[onfocus]'))) {
        (node as HTMLElement).focus();
      }

      const globals = dom.window as unknown as Record<string, unknown>;
      expect(globals.__pwned).toBeUndefined();
      expect(
        doc.querySelectorAll(
          '[onfocus],[onmouseover],[onerror],[onclick],[onload],[autofocus]',
        ).length,
      ).toBe(0);

      // The payload survives as plain inert text (meta line), identical to
      // what benign input looks like.
      const metaTexts = Array.from(doc.querySelectorAll('.meta')).map((n) => n.textContent || '');
      expect(metaTexts.some((t) => t.includes(PAYLOAD_BADSIG))).toBe(true);
      expect(metaTexts.some((t) => t.includes(PAYLOAD_VALIDSIG))).toBe(true);

      // The invalid-signature ⚠ badge and the situation label still render.
      const warns = Array.from(doc.querySelectorAll('.warn')).map((n) => n.textContent || '');
      expect(warns.some((t) => t.includes('⚠'))).toBe(true);
      expect(metaTexts.some((t) => t.includes('They want to bond'))).toBe(true);

      // The action flow still works: clicking Accept POSTs /bonds/accept with
      // the exact (hostile) bond id — row identity via closures, no
      // data-attribute round-trip.
      const accept = Array.from(doc.querySelectorAll('.bond button')).find(
        (b) => b.textContent === 'Accept',
      );
      if (!accept) throw new Error('Accept button not rendered');
      (accept as HTMLButtonElement).click();
      await waitFor(() => calls.some((c) => c.url === '/bonds/accept'));
      const acceptCall = calls.find((c) => c.url === '/bonds/accept');
      if (!acceptCall) throw new Error('unreachable');
      expect(acceptCall.method).toBe('POST');
      expect(acceptCall.body).toEqual({ bondId: PAYLOAD_BADSIG });
    } finally {
      dom.window.close();
    }
  });
});
