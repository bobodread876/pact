#!/usr/bin/env node
// Release-consistency checks (run in CI):
//
// 1. The pactd version is the same everywhere it is written: package.json,
//    the server's VERSION, the image tag in both composes, and the Umbrel app
//    version. A drifted tag ships an image without the documented features.
// 2. pact-mcp's package.json version matches the version its server reports.
// 3. Every workspace whose source or manifest changed since the last release
//    tag also bumped its version, so `npm publish` is never refused for
//    republishing a version, and npm users get the change.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = (dir) => JSON.parse(read(`packages/${dir}/package.json`));
const errors = [];

// 1. pactd version
const pactd = pkg('pactd').version;
const serverVersion = read('packages/pactd/src/server.ts').match(/export const VERSION = '([^']+)'/)?.[1];
const tagIn = (p) => read(p).match(/ghcr\.io\/bobodread876\/pactd:([^\s"']+)/)?.[1];
const umbrelApp = read('packages/stack/umbrel/pact-pactd/umbrel-app.yml').match(/^version:\s*"?([^"\n]+)"?/m)?.[1];
const pins = {
  'packages/pactd/src/server.ts VERSION': serverVersion,
  'packages/stack/docker-compose.yml image tag': tagIn('packages/stack/docker-compose.yml'),
  'packages/stack/umbrel/pact-pactd/docker-compose.yml image tag': tagIn('packages/stack/umbrel/pact-pactd/docker-compose.yml'),
  'packages/stack/umbrel/pact-pactd/umbrel-app.yml version': umbrelApp,
};
for (const [where, value] of Object.entries(pins)) {
  if (value !== pactd) errors.push(`${where} is ${value ?? '(missing)'}, but packages/pactd/package.json is ${pactd}`);
}

// 2. pact-mcp reported version
const mcp = pkg('mcp').version;
const mcpReported = read('packages/mcp/src/server.ts').match(/name: 'pact-mcp', version: '([^']+)'/)?.[1];
if (mcpReported !== mcp) errors.push(`pact-mcp reports version ${mcpReported ?? '(missing)'}, package.json is ${mcp}`);

// 3. changed since the last release tag ⇒ bumped
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
let lastTag = null;
try {
  lastTag = git('describe', '--tags', '--abbrev=0', '--match', 'v*', '--match', 'pactd-v*');
} catch {
  console.log('check-versions: no release tag found (shallow clone?) — skipping the bump check');
}
if (lastTag) {
  for (const dir of ['core', 'mcp', 'sdk', 'cli', 'pactd']) {
    const paths = [`packages/${dir}/src`, `packages/${dir}/package.json`];
    const changed = git('diff', '--name-only', lastTag, 'HEAD', '--', ...paths);
    if (!changed) continue;
    let then = null;
    try {
      then = JSON.parse(git('show', `${lastTag}:packages/${dir}/package.json`)).version;
    } catch {
      continue; // package didn't exist at the tag
    }
    const now = pkg(dir).version;
    if (then === now) errors.push(`packages/${dir} changed since ${lastTag} but is still ${now} — bump its version`);
  }
}

if (errors.length) {
  console.error(`check-versions: ${errors.length} problem(s):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log(`check-versions: ok (pactd ${pactd}, pact-mcp ${mcp}${lastTag ? `, bumps checked since ${lastTag}` : ''})`);
