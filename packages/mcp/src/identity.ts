import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { generateNostrKeypair, secretFromNsec, type NostrKeypair } from '@pact/core';

// Sovereign default: the key lives locally under the user's home, mode 600.
// (Architecture §6 — later swappable for OS keychain / NIP-46 remote signer.)
const PACT_DIR = process.env.PACT_HOME ?? join(homedir(), '.pact');
const IDENTITY_PATH = join(PACT_DIR, 'identity.json');

export function hasIdentity(): boolean {
  return existsSync(IDENTITY_PATH);
}

export function loadIdentity(): NostrKeypair {
  if (!hasIdentity()) {
    throw new Error('no Pact identity found — run the `pact_keygen` tool first');
  }
  return JSON.parse(readFileSync(IDENTITY_PATH, 'utf8')) as NostrKeypair;
}

/** Create an identity if none exists (or if force), persist it 0600, and return the public parts. */
export function ensureIdentity(force = false): { did: string; npub: string; pubkeyHex: string; created: boolean } {
  if (hasIdentity() && !force) {
    const id = loadIdentity();
    return { did: id.did, npub: id.npub, pubkeyHex: id.pubkeyHex, created: false };
  }
  mkdirSync(PACT_DIR, { recursive: true });
  try {
    chmodSync(PACT_DIR, 0o700);
  } catch {
    /* best effort */
  }
  const keypair = generateNostrKeypair();
  writeFileSync(IDENTITY_PATH, JSON.stringify(keypair, null, 2) + '\n', { mode: 0o600 });
  return { did: keypair.did, npub: keypair.npub, pubkeyHex: keypair.pubkeyHex, created: true };
}

export function loadSecret(): Uint8Array {
  return secretFromNsec(loadIdentity().nsec);
}
