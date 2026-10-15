// Sovereign-default local keystore: the agent's key lives on the user's own
// machine under ~/.pact (mode 600). Architecture §6 — later swappable for OS
// keychain / NIP-46 remote signer / hardware.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { generateNostrKeypair, secretFromNsec, type NostrKeypair } from '@mate-protocol/core';

export function pactHome(): string {
  return process.env.PACT_HOME ?? join(homedir(), '.pact');
}

function identityPath(): string {
  return join(pactHome(), 'identity.json');
}

export function hasIdentity(): boolean {
  return existsSync(identityPath());
}

export function loadIdentity(): NostrKeypair {
  if (!hasIdentity()) {
    throw new Error('no Pact identity found — create one first');
  }
  return JSON.parse(readFileSync(identityPath(), 'utf8')) as NostrKeypair;
}

export interface PublicIdentity {
  did: string;
  npub: string;
  pubkeyHex: string;
  created: boolean;
  /** When `force` replaced a key: where the previous identity was moved. */
  backup?: string;
}

/**
 * Create an identity if none exists (or if force), persist it 0600, return public parts.
 *
 * `force` never destroys a key: the current identity.json is first moved
 * aside to identity.<unix>.bak (0600), so every bond made with it stays
 * recoverable. The new key is written to a temp file and renamed into place,
 * so a crash can't leave a half-written identity.
 */
export function ensureIdentity(force = false): PublicIdentity {
  if (hasIdentity() && !force) {
    const id = loadIdentity();
    return { did: id.did, npub: id.npub, pubkeyHex: id.pubkeyHex, created: false };
  }
  mkdirSync(pactHome(), { recursive: true });
  try {
    chmodSync(pactHome(), 0o700);
  } catch {
    /* best effort */
  }
  let backup: string | undefined;
  if (hasIdentity()) {
    backup = join(pactHome(), `identity.${Math.floor(Date.now() / 1000)}.bak`);
    for (let n = 1; existsSync(backup); n++) backup = join(pactHome(), `identity.${Math.floor(Date.now() / 1000)}-${n}.bak`);
    renameSync(identityPath(), backup);
    chmodSync(backup, 0o600);
  }
  const keypair = generateNostrKeypair();
  const tmp = `${identityPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(keypair, null, 2) + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, identityPath());
  return { did: keypair.did, npub: keypair.npub, pubkeyHex: keypair.pubkeyHex, created: true, ...(backup ? { backup } : {}) };
}

export function loadSecret(): Uint8Array {
  return secretFromNsec(loadIdentity().nsec);
}
