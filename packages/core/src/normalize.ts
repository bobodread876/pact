// Canonical JSON for bond documents.
//
// NOTE (MVP): this is a faithful, byte-compatible port of MATE.md core's
// `normalizeMateDocument` so Pact bonds interoperate with existing
// MATE.md/NIP-BD bonds. It is duplicated here only because @mate-protocol/core
// is not yet published to npm. TODO: replace this file with a dependency on
// @mate-protocol/core once published (preserves the L1→L2 boundary; see
// ../../../ARCHITECTURE.md §13).

import type { BondDocument } from './bond.js';

const TOP_LEVEL_FIELD_ORDER = [
  'mate_version',
  'subject',
  'object',
  'bond',
  'consent',
  'policies',
  'events',
  'runtime',
  'extensions',
];

type CanonicalValue = string | number | boolean | CanonicalValue[] | { [key: string]: CanonicalValue };

export function normalizeBondDocument(data: BondDocument): string {
  const normalized = normalizeRecord(data as unknown as Record<string, unknown>, {
    topLevel: true,
    omitProofs: true,
  });
  return JSON.stringify(normalized);
}

function normalizeValue(key: string, value: unknown): CanonicalValue | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'string') {
    const normalized = isTimestampKey(key) ? normalizeTimestamp(value) : value;
    return normalized.normalize('NFC');
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`Canonical bond JSON forbids non-integer number at ${key}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeValue(key, item))
      .filter((item): item is CanonicalValue => item !== undefined);
  }
  if (isRecord(value)) {
    return normalizeRecord(value, { topLevel: false, omitProofs: false });
  }
  throw new Error(`Unsupported canonical value for ${key}`);
}

function normalizeRecord(
  record: Record<string, unknown>,
  options: { topLevel: boolean; omitProofs: boolean },
): { [key: string]: CanonicalValue } {
  const output: { [key: string]: CanonicalValue } = {};
  const keys = options.topLevel ? topLevelKeys(record) : Object.keys(record).sort(compareCodePoints);

  for (const key of keys) {
    if (options.omitProofs && key === 'proofs') continue;
    const value = normalizeValue(key, record[key]);
    if (value !== undefined) output[key.normalize('NFC')] = value;
  }
  return output;
}

function topLevelKeys(record: Record<string, unknown>): string[] {
  const known = TOP_LEVEL_FIELD_ORDER.filter((key) => Object.prototype.hasOwnProperty.call(record, key));
  const unknown = Object.keys(record)
    .filter((key) => key !== 'proofs' && !TOP_LEVEL_FIELD_ORDER.includes(key))
    .sort(compareCodePoints);
  return [...known, ...unknown];
}

function normalizeTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${value}`);
  const iso = date.toISOString();
  return `${iso.slice(0, 19)}.${iso.slice(20, 23)}000Z`;
}

function isTimestampKey(key: string): boolean {
  return key.endsWith('_at');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
