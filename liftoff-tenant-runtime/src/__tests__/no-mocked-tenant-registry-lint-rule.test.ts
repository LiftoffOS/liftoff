// Enforcement tests for `r5/no-mocked-tenant-registry`.
//
// The rule exists because a suite can prove the wrong thing by mocking the
// decision it is meant to test. `subscriber-tenant-isolation.test.ts` mocked the
// tenant identity to a single id and asserted that everything else was dropped;
// that assertion held for the mock and was catastrophic in a runtime serving
// sixteen tenants. A rule with no tests of its own can stop enforcing without
// anyone noticing, so both halves are pinned here: the module ban, and the
// one-tenant fixture that would let the same mistake back in through the door
// the rule opens.

import { RuleTester } from 'eslint';
import tsParser from '@typescript-eslint/parser';

 
const rule = require('../../eslint-rules/no-mocked-tenant-registry.js');

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser as never,
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

const TEST_FILE = '/repo/src/corrections/__tests__/subscriber.test.ts';
const SRC_FILE = '/repo/src/corrections/subscriber.ts';

ruleTester.run('no-mocked-tenant-registry', rule, {
  valid: [
    {
      // The supported shape: stub the database, let the real registry read it,
      // and give it more than one tenant.
      filename: TEST_FILE,
      code: `
        jest.mock('../../infrastructure/database', () => ({
          getPool: () => servedTenantsPool([A, B]),
        }));
      `,
    },
    {
      // Production code is not the rule's business — it is free to import the
      // registry, which is the entire point of the module.
      filename: SRC_FILE,
      code: `
        import { forEachTenant } from '../infrastructure/tenant-registry';
        export const run = () => forEachTenant('x', async () => undefined);
      `,
    },
    {
      // A three-tenant fixture is fine; the floor is two.
      filename: TEST_FILE,
      code: `const p = servedTenantsPool([A, B, C]);`,
    },
    {
      // Mocking an unrelated module stays allowed.
      filename: TEST_FILE,
      code: `jest.mock('../../infrastructure/logging', () => ({ logger: {} }));`,
    },
  ],

  invalid: [
    {
      // The shape that made the old suite unfailable.
      filename: TEST_FILE,
      code: `
        jest.mock('../../infrastructure/tenant-registry', () => ({
          isKnownTenant: async () => true,
        }));
      `,
      errors: [{ messageId: 'mockedRegistry' }],
    },
    {
      // jest.doMock is the same hazard with a different name.
      filename: TEST_FILE,
      code: `jest.doMock('../infrastructure/tenant-registry', () => ({}));`,
      errors: [{ messageId: 'mockedRegistry' }],
    },
    {
      // One tenant cannot distinguish "covers every tenant" from "covers the
      // first and returns", which is the defect the fixture exists to catch.
      filename: TEST_FILE,
      code: `const p = servedTenantsPool([ONLY_TENANT]);`,
      errors: [{ messageId: 'singleTenantFixture' }],
    },
    {
      filename: TEST_FILE,
      code: `const p = servedTenantsPool([]);`,
      errors: [{ messageId: 'singleTenantFixture' }],
    },
  ],
});
