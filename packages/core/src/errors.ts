// Typed runtime errors, so surfaces (pactd, CLI) can map a refusal to the
// right status instead of reporting every failure as a server error.

export type PactErrorCode = 'not_found' | 'conflict' | 'invalid';

export class PactError extends Error {
  constructor(
    readonly code: PactErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PactError';
  }
}
