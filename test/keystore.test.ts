// Keystore filesystem hardening (F-18): secret writes must not follow
// attacker-planted symlinks, must tighten pre-existing loose permissions
// instead of inheriting them, and must hold ~/.pact at 0700. tmp homes via
// PACT_HOME, the same override the ledger tests use.

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureIdentity } from '../packages/core/src/index.js';

const mode = (path: string) => statSync(path).mode & 0o777;

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pact-keystore-'));
  process.env.PACT_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.PACT_HOME;
});

describe('keystore filesystem hardening', () => {
  it('tightens a pre-created 0644 identity file to 0600 on write', () => {
    const identity = join(home, 'identity.json');
    writeFileSync(identity, '{"planted":true}\n');
    chmodSync(identity, 0o644);

    const result = ensureIdentity(true);
    expect(result.created).toBe(true);
    expect(mode(identity)).toBe(0o600);
  });

  it('refuses a symlinked identity path and leaves the target untouched', () => {
    const target = join(home, 'target.json');
    writeFileSync(target, 'sentinel-bytes');
    symlinkSync(target, join(home, 'identity.json'));

    expect(() => ensureIdentity(true)).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('sentinel-bytes');
  });

  it('writes a fresh identity at 0600', () => {
    const result = ensureIdentity();
    expect(result.created).toBe(true);
    expect(mode(join(home, 'identity.json'))).toBe(0o600);
  });

  it('locks the containing directory down to 0700', () => {
    chmodSync(home, 0o755);
    ensureIdentity();
    expect(mode(home)).toBe(0o700);
  });
});
