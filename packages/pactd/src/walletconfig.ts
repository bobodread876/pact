// Runtime wallet configuration: persist the NWC connection URI in PACT_HOME so
// the wallet can be connected via the status UI (no env/compose editing needed),
// surviving restarts. Falls back to the PACT_NWC env var.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { pactHome, writeSecretFile } from 'pact-core';

function configPath(): string {
  return join(pactHome(), 'wallet.json');
}

export function loadNwcUri(): string | undefined {
  // wallet.json records the operator's EXPLICIT choice — connect or disconnect.
  // When it exists (parseable), its answer is final: an env PACT_NWC must not
  // resurrect a wallet the operator disconnected. The env is the fallback only
  // when no choice has been recorded yet.
  try {
    if (existsSync(configPath())) {
      const data = JSON.parse(readFileSync(configPath(), 'utf8')) as { nwc?: string; disconnected?: boolean };
      if (data.disconnected === true) return undefined;
      return data.nwc || undefined;
    }
  } catch {
    // ignore
  }
  return process.env.PACT_NWC || undefined;
}

export function saveNwcUri(nwc: string): void {
  writeSecretFile(configPath(), JSON.stringify({ nwc }));
}

export function clearNwcUri(): void {
  try {
    writeSecretFile(configPath(), JSON.stringify({}));
  } catch {
    // ignore
  }
}
