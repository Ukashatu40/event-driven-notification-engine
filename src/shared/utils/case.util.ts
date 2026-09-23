// src/shared/utils/case.util.ts

/**
 * Key-case conversion for the HTTP boundary.
 *
 * The API contract (spec Appendix A) is snake_case, the codebase is camelCase.
 * These helpers convert at the edge only, and deliberately leave two things
 * alone:
 *  - free-form JSON supplied by producers/templates (`payload`, `metadata`,
 *    `rendered_content`, …) — their keys are data, not schema;
 *  - the `channels` maps, whose keys are channel ids such as `in_app`.
 */
const OPAQUE_KEYS = new Set([
  'payload',
  'metadata',
  'personalisation_data',
  'personalisationData',
  'rendered_content',
  'renderedContent',
  'channels',
  'details',
]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

// Only rewrite identifiers that are actually camelCase / snake_case words
// (so `CRITICAL`, `TXNX-001`, `in_app` and `2026-01` style keys are left as-is).
const toSnake = (key: string): string =>
  /^[a-z][a-zA-Z0-9]*$/.test(key)
    ? key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
    : key;

const toCamel = (key: string): string =>
  /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(key)
    ? key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
    : key;

function convert(
  value: unknown,
  rename: (k: string) => string,
  opaque: Set<string>,
): unknown {
  if (Array.isArray(value)) return value.map((v) => convert(v, rename, opaque));
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[rename(key)] = opaque.has(key) ? val : convert(val, rename, opaque);
  }
  return out;
}

export const snakeKeys = (value: unknown): unknown =>
  convert(value, toSnake, OPAQUE_KEYS);

export const camelKeys = (value: unknown): unknown =>
  convert(value, toCamel, OPAQUE_KEYS);
