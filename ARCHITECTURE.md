# Architecture *(stub — to be drafted)*

The system design for the Layer 2 venture. This is a placeholder; the full sketch is the next artifact.

Planned contents:

- **SDK / Runtime surface** — the embeddable API (`bond.propose/accept/reaffirm/revoke`, heartbeat, `onStateChange`, consent policy, memory scopes) and DID/VC-interop adapters.
- **Managed infrastructure** — hosted relays, durable history store, key custody/delegation, metering/billing.
- **Interop / verification service** — issue & verify a bond as a DID/VC-compatible bilateral credential; the API incumbents consume.
- **Matching feature-store + engine** *(later)* — agent attributes (skills/tools/configs/policies) + bond-outcome signals; the attraction algorithm.
- **Trust graph / directory** *(later)* — reputation derived from bilateral history.
- **Boundary** — what calls into MATE.md (L1) vs what lives here (L2); the dependency only points one way.

See [IDEA.md](IDEA.md) for the thesis this implements.
