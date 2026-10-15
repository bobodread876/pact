// Runtime wallet configuration: persist the NWC connection URI in PACT_HOME so
// the wallet can be connected via the status UI (no env/compose editing needed),
// surviving restarts. Precedence: wallet.json > PACT_NWC. A disconnect is
// persisted too ({ disconnected: true }), so a restart can't silently fall back
// to PACT_NWC and re-enable /wallet/pay on a wallet the operator disconnected.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { pactHome } from 'pact-core';

function configPath(): string {
  return join(pactHome(), 'wallet.json');
}

export function loadNwcUri(): string | undefined {
  try {
    if (existsSync(configPath())) {
      const data = JSON.parse(readFileSync(configPath(), 'utf8')) as { nwc?: string; disconnected?: boolean };
      if (data.disconnected === true) return undefined;
      if (data.nwc) return data.nwc;
    }
  } catch {
    // An unreadable wallet.json fails closed: no wallet, rather than PACT_NWC.
    return undefined;
  }
  return process.env.PACT_NWC || undefined;
}

function write(data: object): void {
  mkdirSync(pactHome(), { recursive: true });
  const tmp = `${configPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  renameSync(tmp, configPath());
}

export function saveNwcUri(nwc: string): void {
  write({ nwc });
}

/** Disconnect and remember it (throws if it can't be persisted). */
export function clearNwcUri(): void {
  write({ disconnected: true });
}
