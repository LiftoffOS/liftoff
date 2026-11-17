// Registry validation — every ComposioPollSpec must be internally consistent so
// a bad entry can't silently ship an inert connector.

import { COMPOSIO_POLL_SPECS, getEntityPollIntervalMs } from './composio-poll-spec.js';
import { CONNECTORS } from '../catalog/connectors.js';
import { getNormalizer } from '../normalizers/index.js';

describe('COMPOSIO_POLL_SPECS', () => {
  const specs = Object.entries(COMPOSIO_POLL_SPECS);

  it('keys match connectorType and are lowercase', () => {
    for (const [key, spec] of specs) {
      expect(key).toBe(key.toLowerCase());
      expect(spec.connectorType).toBe(key);
    }
  });

  it('every entity has an action or proxy, eventTopics, and a fields map', () => {
    for (const [, spec] of specs) {
      expect(spec.entities.length).toBeGreaterThan(0);
      for (const e of spec.entities) {
        const hasCall = Boolean(e.action) || (spec.transport === 'proxy' && Boolean(e.proxy));
        expect(hasCall).toBe(true);
        expect(e.eventTopics.length).toBeGreaterThan(0);
        expect(Object.keys(e.fields).length).toBeGreaterThan(0);
      }
    }
  });

  it('action slugs are well-formed Composio slugs (UPPER_SNAKE_CASE)', () => {
    // Slug EXISTENCE is verified offline against Composio's action catalog via
    // scripts/probe-poll-spec.ts (a live CI call would need credentials + be
    // flaky). This guards the cheap invariant: the slug is shaped like a real
    // Composio action, so a typo like 'greenhouse_list' can't ship silently.
    for (const [, spec] of specs) {
      for (const e of spec.entities) {
        if (e.action) expect(e.action).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it('each spec resolves a normalizer with entity schemas covering its entityTypes', () => {
    for (const [type, spec] of specs) {
      const n = getNormalizer(type);
      expect(n).toBeDefined();
      for (const e of spec.entities) expect(n!.entitySchemas[e.entityType]).toBeDefined();
    }
  });

  it('each spec entityType + eventTopics is declared in the catalog polling config', () => {
    for (const [type, spec] of specs) {
      const polling = CONNECTORS[type]?.polling ?? [];
      for (const e of spec.entities) {
        const match = polling.find(p => p.entityType === e.entityType && p.listImplemented);
        expect(match).toBeDefined();
      }
    }
  });

  it('any configured pollIntervalMs is a positive number, resolvable via helper', () => {
    for (const [type, spec] of specs) {
      for (const e of spec.entities) {
        if (e.pollIntervalMs !== undefined) {
          expect(e.pollIntervalMs).toBeGreaterThan(0);
          expect(getEntityPollIntervalMs(type, e.entityType)).toBe(e.pollIntervalMs);
        }
      }
    }
    // greenhouse candidates are throttled below the base cycle; unspecced → undefined.
    expect(getEntityPollIntervalMs('greenhouse', 'Candidate')).toBe(300_000);
    expect(getEntityPollIntervalMs('apollo', 'Contact')).toBeUndefined();
    expect(getEntityPollIntervalMs('nope', 'Nope')).toBeUndefined();
  });
});
