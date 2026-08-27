import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted at every level, so a client that serializes the same payload
 * with a different key order does not get a false MUTATION_ID_REUSED (§9).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    return Object.fromEntries(entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]));
  }

  return value;
}

/** The hash of (type, payload, orderId) that decides retry versus mutation-id reuse (§9). */
export function requestHash(orderId: string, type: string, payload: unknown): string {
  const canonical = JSON.stringify(canonicalize({ orderId, type, payload }));
  return createHash('sha256').update(canonical).digest('hex');
}
