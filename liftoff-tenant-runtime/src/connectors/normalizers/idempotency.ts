import { createHash } from 'node:crypto';

export function hashCanonicalJson(value: unknown): string {
  const normalized = value === undefined ? '' : JSON.stringify(value);
  return createHash('sha256').update(normalized).digest('hex');
}
