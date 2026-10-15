// Payment policy for pact-mcp (security audit F-05).
//
// MCP agents execute LLM-suggested tool calls, and this server exposes wallet
// payment next to tools that return raw relay text — indirect prompt injection
// would otherwise have a live path to money movement. So wallet-spending tools
// consult paymentPolicyViolation() on every call:
//
//   1. Payments require an explicit operator opt-in: PACT_MCP_ALLOW_PAYMENTS=1
//      (exactly "1"). Unset, the tool answers with a structured refusal.
//   2. Even then, PACT_MCP_MAX_PAYMENT_SATS caps one payment (default 1000
//      sats, parsed with the same whole-sats env semantics pactd uses);
//      over-cap requests are refused with a structured error.
//
// Both env vars are read per call — never cached at module load — so the
// policy can change on a live server (and a test process can vary it).

/** The structured refusal a gated tool answers with (undefined = may proceed). */
export interface PaymentPolicyRefusal {
  error: string;
  /** Present on the disabled-by-policy refusal: how the operator opts in. */
  howToEnable?: string;
  /** Present on over-cap refusals: the cap in force, and the request's sats. */
  capSats?: number;
  amountSats?: number;
}

/** Wallet-spending tools may run only on an explicit operator opt-in. */
function paymentsEnabled(): boolean {
  return process.env.PACT_MCP_ALLOW_PAYMENTS === '1';
}

/** Per-payment cap in whole sats — same env parsing pactd uses for sats. */
function paymentCapSats(): number {
  return Math.max(0, Math.floor(Number(process.env.PACT_MCP_MAX_PAYMENT_SATS) || 1000));
}

/** bolt11 HRP amount multipliers, in sats (no suffix = whole BTC). */
function bolt11MultiplierSats(suffix: string): number {
  switch (suffix) {
    case 'm':
      return 1e5;
    case 'u':
      return 100;
    case 'n':
      return 0.1;
    case 'p':
      return 1e-4;
    default:
      return 1e8;
  }
}

/**
 * Amount encoded in a bolt11 invoice's human-readable part, in whole sats
 * (same HRP parse and rounding as pactd's invoiceAmountSats), or undefined
 * when the invoice is amountless/unparseable — no bech32 decode needed.
 */
function invoiceAmountSats(invoice: string): number | undefined {
  const lower = invoice.toLowerCase();
  const sep = lower.lastIndexOf('1'); // bech32 separator; HRP and data contain no other '1'
  if (sep < 0) return undefined;
  const match = /([0-9]+)([munp]?)$/.exec(lower.slice(0, sep));
  if (!match) return undefined; // no amount in the HRP → amountless
  return Math.round(Number(match[1]) * bolt11MultiplierSats(match[2] ?? ''));
}

/**
 * Gate consulted per call by every wallet-spending tool. Returns the refusal
 * object to answer with, or undefined when the payment may go to the daemon.
 */
export function paymentPolicyViolation(request: {
  invoice: string;
  amountSats?: number;
}): PaymentPolicyRefusal | undefined {
  if (!paymentsEnabled()) {
    return { error: 'payments disabled by policy', howToEnable: 'set PACT_MCP_ALLOW_PAYMENTS=1' };
  }
  const capSats = paymentCapSats();
  // The operative amount is the larger of the explicit argument and whatever
  // the invoice itself encodes — either one over the cap refuses the payment.
  const known = [request.amountSats, invoiceAmountSats(request.invoice)].filter(
    (n): n is number => n !== undefined,
  );
  if (known.length === 0) return undefined; // amountless: the wallet rejects it; nothing moves
  const amountSats = Math.max(...known);
  if (amountSats > capSats) {
    return {
      error: `payment exceeds the per-payment cap (PACT_MCP_MAX_PAYMENT_SATS=${capSats} sats)`,
      capSats,
      amountSats,
    };
  }
  return undefined;
}
