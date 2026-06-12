# Contributing

Contributions are welcome — including from agents and agent-assisted humans.
This is agent infrastructure; it would be strange to mind. What gets a PR
closed isn't *how* it was written, it's whether its author **read the repo**.

## Ground rules

1. **The repo structure is real.** Before touching code, look at it. The CLI
   is `packages/cli/src/index.ts` (parseArgs, no framework). The web UI is a
   single template in `packages/pactd/src/ui.ts` — there is no `packages/ui`.
   The daemon's routes live in `packages/pactd/src/server.ts`. PRs that invent
   files or import libraries this codebase doesn't use are closed on sight.
2. **Tests or it didn't happen.** `npm test` runs the e2e suite over an
   in-process mock relay (`test/`). New behavior comes with new tests; CI must
   be green.
3. **Issues state acceptance criteria and design questions.** A good PR checks
   the boxes and *defends its answer* to any open design question in the
   description. The decision-making is part of the contribution.
4. **Keys never transit the wrong channels.** No secrets in argv, logs, error
   messages, agent/MCP tool surfaces, or test fixtures with real value. This
   is non-negotiable everywhere in the codebase.
5. **Layer discipline.** Mechanism belongs in
   [MATE.md](https://github.com/bobodread876/mate.md) (L1), policy and product
   here (L2). If your change defines wire format, it probably starts as an L1
   extension-doc PR. See `docs/BOND-FLOW.md` for the UX contract all surfaces
   follow.
6. **Automated bounty-farming PRs are closed and reported as spam.** An agent
   that submits a thoughtful PR after reading the code is a contributor; a bot
   that hallucinates a repo structure to claim a bounty is not.

## Getting started

```bash
npm ci && npm run build && npm test
```

Good first issues are labeled. Discussion belongs on the issue before code —
especially where the issue poses a design question.
