// Regression tests for the secret-write hardening (audit F-18 follow-through):
// pactd's persisted secrets (API token, NWC wallet URI) must never be written
// through a symlink or left with attacker-planted loose permissions.

import { chmodSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveToken, tokenPath } from '../packages/pactd/src/tokenconfig.js';
import { loadNwcUri, saveNwcUri } from '../packages/pactd/src/walletconfig.js';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PACT_HOME;
  home = mkdtempSync(join(tmpdir(), 'pact-secret-writes-'));
  process.env.PACT_HOME = home;
  delete process.env.PACT_TOKEN; // force the load-or-create path
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PACT_HOME;
  else process.env.PACT_HOME = previousHome;
});

describe('pactd token persistence', () => {
  it('writes a fresh token with 0600 permissions that resolveToken reads back', () => {
    const token = resolveToken();
    expect(token).toBeTruthy();
    expect(lstatSync(tokenPath()).mode & 0o777).toBe(0o600);
    expect(lstatSync(home).mode & 0o777).toBe(0o700);
    // A second resolution reads the persisted token, not a new one.
    expect(resolveToken()).toBe(token);
  });

  it('never writes a token through a symlinked path', () => {
    const target = join(home, 'victim.txt');
    writeFileSync(target, 'do-not-clobber');
    symlinkSync(target, tokenPath());

    const token = resolveToken();
    expect(token).toBeTruthy(); // in-memory fallback still protects this run

    // The attacker's file is untouched and the link survived (not replaced).
    expect(readFileSync(target, 'utf8')).toBe('do-not-clobber');
    expect(lstatSync(tokenPath()).isSymbolicLink()).toBe(true);
  });

  it('tightens a pre-created 0644 token file to 0600 on the next read', () => {
    writeFileSync(tokenPath(), 'operator-set-token\n');
    chmodSync(tokenPath(), 0o644); // planted loose permissions

    expect(resolveToken()).toBe('operator-set-token');
    expect(lstatSync(tokenPath()).mode & 0o777).toBe(0o600);
  });
});

describe('pactd wallet (NWC URI) persistence', () => {
  it('saves with 0600 and round-trips', () => {
    saveNwcUri('nostr+walletconnect://walletpub?relay=ws%3A%2F%2F127.0.0.1%3A7777&secret=abc');
    expect(loadNwcUri()).toContain('nostr+walletconnect://');
    expect(lstatSync(join(home, 'wallet.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses to save over a symlinked wallet.json', () => {
    const target = join(home, 'victim.txt');
    writeFileSync(target, 'do-not-clobber');
    symlinkSync(target, join(home, 'wallet.json'));

    expect(() => saveNwcUri('nostr+walletconnect://whatever')).toThrow(/non-regular/);
    expect(readFileSync(target, 'utf8')).toBe('do-not-clobber');
  });
});
