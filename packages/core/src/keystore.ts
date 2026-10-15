// Sovereign-default local keystore: the agent's key lives on the user's own
// machine under ~/.pact (mode 600). Architecture §6 — later swappable for OS
// keychain / NIP-46 remote signer / hardware.

import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

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

/**
 * A secret's containing directory must exist, be a real directory (a symlink
 * here would redirect every secret in it), and be readable by no one else.
 */
function ensureSecretDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const stats = lstatSync(dir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`refusing to write secrets into non-directory path: ${dir}`);
  }
  chmodSync(dir, 0o700); // tighten, never inherit: a planted 0755 dir must not survive
}

/**
 * Every secret write goes through here. The lstat refuses symlinks and
 * non-regular files (writeFileSync would silently follow a planted link onto
 * an attacker-chosen target), O_NOFOLLOW re-checks at open where available,
 * and the fchmod tightens a pre-existing loose file — O_CREAT's mode only
 * applies at creation, so without it a planted 0644 file stays world-readable.
 *
 * Exported so pactd's persisted secrets (API token, NWC URI) get the same
 * guarantees without re-implementing them.
 */
export function writeSecretFile(path: string, contents: string): void {
  ensureSecretDir(dirname(path));
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats && (stats.isSymbolicLink() || !stats.isFile())) {
    throw new Error(`refusing to write secret over non-regular file: ${path}`);
  }
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
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
  const keypair = generateNostrKeypair();
  writeSecretFile(identityPath(), JSON.stringify(keypair, null, 2) + '\n');
  return { did: keypair.did, npub: keypair.npub, pubkeyHex: keypair.pubkeyHex, created: true };
}

export function loadSecret(): Uint8Array {
  return secretFromNsec(loadIdentity().nsec);
}
