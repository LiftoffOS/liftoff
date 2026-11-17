// Vendor registry routing tests — verifies vendor resolution from headers/URL.

import { resolveVendorFromRequest } from '../vendor/registry.js';

test('defaults to anthropic for /v1/* paths', () => {
  expect(resolveVendorFromRequest({}, '/v1/messages')).toBe('anthropic');
});

test('X-Liftoff-Vendor header takes precedence', () => {
  expect(resolveVendorFromRequest({ 'x-vendor': 'anthropic' }, '/v1/messages')).toBe('anthropic');
});

test('X-Liftoff-Vendor array value uses first entry', () => {
  expect(resolveVendorFromRequest({ 'x-vendor': ['anthropic', 'openai'] }, '/v1/messages')).toBe('anthropic');
});

test('unknown X-Liftoff-Vendor header throws', () => {
  expect(() => resolveVendorFromRequest({ 'x-vendor': 'gemini' }, '/v1/messages')).toThrow('Unknown vendor: gemini');
});

test('/claude-code/* prefix routes to anthropic', () => {
  expect(resolveVendorFromRequest({}, '/claude-code/v1/messages')).toBe('anthropic');
});

test('/codex/* prefix routes to openai (future)', () => {
  expect(resolveVendorFromRequest({}, '/codex/v1/chat/completions')).toBe('openai');
});
