import { secretFromNsec } from './utils';
import { PublicIdentity } from './types';

/**
 * Import an existing secret; persists like ensureIdentity. Returns public parts only.
 * 
 * @param secret - The secret to import (nsec1... or 64-hex)
 * @param force - Whether to overwrite an existing identity (default: false)
 * @returns The public identity
 */
export function importIdentity(secret: string, force = false): PublicIdentity {
  // Check if an identity already exists
  if (getIdentity() && !force) {
    throw new Error('Identity already exists. Use --force to overwrite.');
  }

  // Validate and parse the secret
  let parsedSecret: Uint8Array;
  if (secret.startsWith('nsec1')) {
    parsedSecret = secretFromNsec(secret);
  } else if (secret.length === 64) {
    parsedSecret = new Uint8Array(secret.match(/.{2}/g).map(byte => parseInt(byte, 16)));
  } else {
    throw new Error('Invalid secret format. Use nsec1... or 64-hex.');
  }

  // Back up the old identity if force is true
  if (force && getIdentity()) {
    const oldIdentity = getIdentity();
    const backupPath = `identity.json.bak.${Date.now()}`;
    fs.writeFileSync(backupPath, JSON.stringify(oldIdentity), { mode: 0o600 });
  }

  // Persist the new identity
  const identity = { secret: parsedSecret };
  fs.writeFileSync('identity.json', JSON.stringify(identity), { mode: 0o600 });

  // Return the public parts only
  return { publicKey: getPublicKeyFromSecret(parsedSecret) };
}