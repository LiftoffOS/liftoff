// `memories.scope_key` in the tenant runtime is CHECK-constrained to
// `^[a-zA-Z0-9_-]+$` (migration 014). Anything derived from free text — an
// agent's role ("Program Manager"), a key supplied by an MCP caller — has to be
// slugged or the write is rejected at validation.
//
// Deliberately its own module rather than a method on the runtime client: it is
// a pure string rule, and tests that mock the client should not have to stub it.

export function toScopeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 255) || 'unscoped';
}
