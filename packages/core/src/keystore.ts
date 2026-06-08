// Sovereign-default local keystore: the agent's key lives on the user's own
// machine under ~/.pact (mode 600). Architecture §6 — later swappable for OS
// keychain / NIP-46 remote signer / hardware.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
}

/** Create an identity if none exists (or if force), persist it 0600, return public parts. */
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
  const keypair = generateNostrKeypair();
  writeFileSync(identityPath(), JSON.stringify(keypair, null, 2) + '\n', { mode: 0o600 });
  return { did: keypair.did, npub: keypair.npub, pubkeyHex: keypair.pubkeyHex, created: true };
}

export function loadSecret(): Uint8Array {
  return secretFromNsec(loadIdentity().nsec);
}
