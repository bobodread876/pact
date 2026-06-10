// pact-sdk — embed Pact bonds directly in your TypeScript agent, in-process.
// No daemon, no MCP server: bring your own key (a raw secret, an nsec, or the
// sovereign local ~/.pact keystore) and form / resolve / verify bonds over Nostr.

import {
  DEFAULT_RELAYS,
  acceptBond as coreAcceptBond,
  ensureIdentity,
  formBond as coreFormBond,
  generateNostrKeypair,
  hasIdentity,
  keypairFromSecret,
  listBonds as coreListBonds,
  loadSecret,
  pubkeyHexFromIdentity,
  secretFromNsec,
  verifyBond as coreVerifyBond,
  type BondState,
  type BondView,
  type FormBondResult,
  type VerifyBondResult,
} from 'pact-core';

export type { BondState, BondView, FormBondResult, VerifyBondResult } from 'pact-core';

export interface PactOptions {
  /** Relays to publish/resolve on. Defaults to the protocol's default relays. */
  relays?: string[];
}

export interface PactIdentity {
  did: string;
  npub: string;
  pubkeyHex: string;
}

export interface FormBondArgs {
  /** Counterparty identity (did:nostr / npub / hex). */
  counterparty: string;
  /** Opaque bond id. Omit to auto-generate `urn:mate:<uuid>`. */
  bondId?: string;
  /** Defaults to 'proposed'. */
  state?: BondState;
  kind?: string;
  /** Also publish a kind:1317 history event (default true). */
  history?: boolean;
  relays?: string[];
}

export interface ListBondsArgs {
  /** Filter to bonds authored by this identity. */
  author?: string;
  /** Filter to bonds that p-tag this identity. */
  counterparty?: string;
  bondId?: string;
  relays?: string[];
}

export interface BondQueryResult {
  relaysReached: string[];
  bonds: BondView[];
}

/**
 * In-process Pact client. Construct it with a key, then form, resolve, and
 * verify agent bonds — the same engine pactd and pact-mcp use, just embedded.
 */
export class Pact {
  /** This client's public identity. */
  readonly identity: PactIdentity;

  private readonly secret: Uint8Array;
  private readonly relays: string[];

  private constructor(secret: Uint8Array, relays: string[]) {
    this.secret = secret;
    this.relays = relays.length ? relays : DEFAULT_RELAYS;
    const kp = keypairFromSecret(secret);
    this.identity = { did: kp.did, npub: kp.npub, pubkeyHex: kp.pubkeyHex };
  }

  /** Use a raw 32-byte secret key. */
  static fromSecret(secret: Uint8Array, opts: PactOptions = {}): Pact {
    return new Pact(secret, opts.relays ?? []);
  }

  /** Use an `nsec1…` bech32 secret. */
  static fromNsec(nsec: string, opts: PactOptions = {}): Pact {
    return new Pact(secretFromNsec(nsec), opts.relays ?? []);
  }

  /** Generate a brand-new, ephemeral identity (not persisted anywhere). */
  static generate(opts: PactOptions = {}): Pact {
    return new Pact(secretFromNsec(generateNostrKeypair().nsec), opts.relays ?? []);
  }

  /**
   * Use the sovereign local keystore at `~/.pact` (or `$PACT_HOME`). Creates an
   * identity if none exists, unless `create: false` (then it throws).
   */
  static fromKeystore(opts: PactOptions & { create?: boolean } = {}): Pact {
    if (!hasIdentity()) {
      if (opts.create === false) {
        throw new Error('no Pact identity in keystore — create one or pass { create: true }');
      }
      ensureIdentity();
    }
    return new Pact(loadSecret(), opts.relays ?? []);
  }

  /** Whether the local keystore already holds an identity. */
  static keystoreHasIdentity(): boolean {
    return hasIdentity();
  }

  /** Assemble, sign, and publish a bond state (and, by default, a history event). */
  formBond(args: FormBondArgs): Promise<FormBondResult> {
    return coreFormBond(this.secret, {
      counterparty: args.counterparty,
      bondId: args.bondId,
      state: args.state ?? 'proposed',
      kind: args.kind,
      history: args.history ?? true,
      relays: args.relays ?? this.relays,
    });
  }

  /** Resolve bonds matching a filter (defaults to bonds this identity authored). */
  listBonds(args: ListBondsArgs = {}): Promise<BondQueryResult> {
    const filter: { authors?: string[]; '#p'?: string[]; '#d'?: string[] } = {};
    if (args.author) filter.authors = [pubkeyHexFromIdentity(args.author)];
    if (args.counterparty) filter['#p'] = [pubkeyHexFromIdentity(args.counterparty)];
    if (args.bondId) filter['#d'] = [args.bondId];
    if (!args.author && !args.counterparty && !args.bondId) {
      filter.authors = [this.identity.pubkeyHex];
    }
    return coreListBonds(filter, args.relays ?? this.relays);
  }

  /** Bonds this identity has authored. */
  myBonds(relays?: string[]): Promise<BondQueryResult> {
    return this.listBonds({ author: this.identity.did, relays });
  }

  /** Inbound bonds that p-tag this identity (proposals + counterparty updates). */
  inbox(relays?: string[]): Promise<BondQueryResult> {
    return this.listBonds({ counterparty: this.identity.did, relays });
  }

  /** Resolve and verify a bond by id (mutual = both sides signed & cross-reference). */
  verifyBond(bondId: string, relays?: string[]): Promise<VerifyBondResult> {
    return coreVerifyBond(bondId, relays ?? this.relays);
  }

  /**
   * Accept a proposed bond by echoing the proposer's id (so both sides share one
   * `d` tag and resolve as mutual). The proposer (`counterparty`) is auto-resolved
   * from the inbound proposal if not given. State defaults to `active`.
   */
  acceptBond(
    bondId: string,
    opts: { counterparty?: string; state?: BondState; kind?: string; history?: boolean; relays?: string[] } = {},
  ): Promise<FormBondResult> {
    return coreAcceptBond(this.secret, {
      bondId,
      counterparty: opts.counterparty,
      state: opts.state,
      kind: opts.kind,
      history: opts.history,
      relays: opts.relays ?? this.relays,
    });
  }

  /**
   * Poll the inbox on an interval, invoking `onBond` once per newly-seen bond
   * state (keyed by bond id + author). Returns a `stop()` function. A simple
   * poll loop — for a long-lived push stream, pactd's `/events` SSE is the
   * heavier option.
   */
  watch(
    onBond: (bond: BondView) => void,
    opts: { intervalMs?: number; relays?: string[] } = {},
  ): () => void {
    const intervalMs = Math.max(2000, opts.intervalMs ?? 30_000);
    const seen = new Map<string, string>();
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const { bonds } = await this.inbox(opts.relays);
        for (const b of bonds) {
          const key = `${b.bond}:${b.author}`;
          if (seen.get(key) !== (b.state ?? '')) {
            seen.set(key, b.state ?? '');
            if (!stopped) onBond(b);
          }
        }
      } catch {
        // swallow; the next tick retries
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}

export default Pact;
