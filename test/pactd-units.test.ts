// Unit-level fixes from the Simon review of main: the wallet disconnect
// survives a restart, invoices count as paid only when settled, NWC URIs are
// validated whole, the paywall ledger refuses to serve what it can't persist,
// `force` never destroys a key, the UI escapes attributes, and every surface
// agrees on the legal bond states.

import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BOND_STATES } from '../packages/core/src/index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pact-units-'));
  process.env.PACT_HOME = dir;
  vi.resetModules();
});
afterEach(() => {
  try {
    chmodSync(dir, 0o700);
  } catch {
    // ignore
  }
  rmSync(dir, { recursive: true, force: true });
  delete process.env.PACT_HOME;
  delete process.env.PACT_NWC;
});

const NWC = `nostr+walletconnect://${'a'.repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${'b'.repeat(64)}`;

describe('wallet disconnect is persisted', () => {
  it('connect → disconnect → restart with PACT_NWC set stays disconnected', async () => {
    process.env.PACT_NWC = NWC;
    let wc = await import('../packages/pactd/src/walletconfig.js');
    expect(wc.loadNwcUri()).toBe(NWC); // env fallback before any choice
    wc.saveNwcUri(NWC);
    wc.clearNwcUri();
    vi.resetModules();
    wc = await import('../packages/pactd/src/walletconfig.js');
    expect(wc.loadNwcUri()).toBeUndefined();
    // An explicit reconnect overrides the marker.
    wc.saveNwcUri(NWC);
    expect(wc.loadNwcUri()).toBe(NWC);
  });
});

describe('lightning', () => {
  it('an unpaid incoming invoice with a preimage is NOT paid; settlement is', async () => {
    const { invoicePaid } = await import('../packages/pactd/src/lightning.js');
    expect(invoicePaid({ type: 'incoming', preimage: 'ab'.repeat(32), state: 'pending' })).toBe(false);
    expect(invoicePaid({ type: 'incoming', preimage: 'ab'.repeat(32) })).toBe(false);
    expect(invoicePaid({ type: 'incoming', state: 'settled' })).toBe(true);
    expect(invoicePaid({ type: 'incoming', settled_at: 1_700_000_000 })).toBe(true);
    expect(invoicePaid({ type: 'incoming', settled_at: 0 })).toBe(false);
    expect(invoicePaid({ type: 'outgoing', preimage: 'ab'.repeat(32) })).toBe(true);
  });

  it('rejects an NWC URI with a bad secret or relay', async () => {
    const { lightningFrom } = await import('../packages/pactd/src/lightning.js');
    expect(lightningFrom(NWC)).not.toBeNull();
    expect(() => lightningFrom(NWC.replace('b'.repeat(64), 'zz'))).toThrow(/secret/);
    expect(() => lightningFrom(NWC.replace('wss%3A%2F%2Frelay.example', 'http%3A%2F%2Frelay.example'))).toThrow(/relay/);
  });
});

describe('verification ledger persistence', () => {
  it.skipIf(process.getuid?.() === 0)('a consume that cannot be persisted throws and stays redeemable', async () => {
    const ledger = await import('../packages/pactd/src/ledger.js');
    ledger.recordVerificationInvoice('hashA', 'urn:mate:1');
    chmodSync(dir, 0o500); // read-only PACT_HOME
    expect(() => ledger.consumeVerification('hashA', 'urn:mate:1')).toThrow();
    expect(ledger.verificationStatus('hashA', 'urn:mate:1')).toBe('ok');
    chmodSync(dir, 0o700);
    expect(ledger.consumeVerification('hashA', 'urn:mate:1')).toBe(true);
    vi.resetModules();
    const reloaded = await import('../packages/pactd/src/ledger.js');
    expect(reloaded.verificationStatus('hashA', 'urn:mate:1')).toBe('spent');
  });

  it.skipIf(process.getuid?.() === 0)('an invoice that cannot be recorded is not handed out', async () => {
    const ledger = await import('../packages/pactd/src/ledger.js');
    chmodSync(dir, 0o500);
    expect(() => ledger.recordVerificationInvoice('hashB', 'urn:mate:1')).toThrow();
    expect(ledger.verificationStatus('hashB', 'urn:mate:1')).toBe('unknown');
  });
});

describe('keystore force', () => {
  it('backs up the old key (0600) and writes the new one 0600', async () => {
    const ks = await import('../packages/core/src/keystore.js');
    const first = ks.ensureIdentity();
    const firstRaw = readFileSync(join(dir, 'identity.json'), 'utf8');
    const second = ks.ensureIdentity(true);
    expect(second.pubkeyHex).not.toBe(first.pubkeyHex);
    expect(second.backup).toBeDefined();
    expect(existsSync(second.backup!)).toBe(true);
    expect(readFileSync(second.backup!, 'utf8')).toBe(firstRaw);
    expect(statSync(second.backup!).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'identity.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('status UI', () => {
  it('esc() is safe inside double-quoted attributes', async () => {
    const { renderUI } = await import('../packages/pactd/src/ui.js');
    const html = renderUI('secret-token', undefined, undefined, false);
    expect(html).not.toContain('secret-token');
    const src = html.match(/const esc = (\(s\) => .*);\n/)?.[1];
    expect(src).toBeDefined();
    const esc = new Function(`return ${src}`)() as (s: string) => string;
    const payload = 'x" autofocus onfocus="alert(1)';
    const attr = `<button data-bond="${esc(payload)}">`;
    expect(attr).not.toContain('" autofocus');
    expect(esc(`'<>&`)).toBe('&#39;&lt;&gt;&amp;');
  });

  it('embeds the token only when told it sits behind an authenticating proxy', async () => {
    const { renderUI } = await import('../packages/pactd/src/ui.js');
    expect(renderUI('tok</script>', undefined, undefined, true)).toContain('tok\\u003c/script>');
    expect(renderUI('tok', undefined, undefined, true)).toContain('const EMBEDDED = "tok"');
  });
});

describe('bond states', () => {
  it('pact-mcp offers exactly the states pact-core (and so pactd and the CLI) accept', async () => {
    const mcp = await import('../packages/mcp/src/server.js');
    expect([...mcp.BOND_STATES]).toEqual([...BOND_STATES]);
  });
});
