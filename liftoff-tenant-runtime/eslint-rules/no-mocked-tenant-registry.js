'use strict';

/**
 * A test may not mock the tenant registry.
 *
 * `infrastructure/tenant-registry` decides which tenants a sweep covers and
 * which tenants' events are accepted. Mocking it replaces that decision with
 * the test author's assumption, and the assumption is exactly what goes wrong:
 * a suite named `subscriber-tenant-isolation` mocked "the tenant this runtime
 * serves" to a single fixed id, then asserted that foreign traffic was dropped
 * and that the handler ran. Both were true of the mock. A real runtime can
 * serve many tenants, so "foreign" can mean real customers, and the test
 * could not fail because the premise it encoded WAS the defect.
 *
 * Stub the database instead and let the real registry read it:
 *
 *     import { servedTenantsPool } from '../../test-utils/served-tenants';
 *     jest.mock('../../infrastructure/database', () => ({
 *       getPool: () => servedTenantsPool([TENANT_A, TENANT_B]),
 *     }));
 *
 * Give a suite two tenants and a fan-out that covers only the first one fails,
 * which is the property that actually matters. One tenant in a fixture cannot
 * tell the two apart.
 *
 * Also flags a `getPool` stub in a `jest.mock` factory whose tenant list is a
 * single id, for the same reason: the fixture is what makes the test able to
 * fail, so a one-tenant fixture is the defect wearing the fix's clothes.
 */

const REGISTRY_MODULE_RE = /(^|\/)infrastructure\/tenant-registry$/;
const FIXTURE_HINT =
  'Stub the database with servedTenantsPool([tenantA, tenantB]) from '
  + 'src/test-utils/served-tenants and let the real registry read it.';

function isJestMockCall(node) {
  const callee = node.callee;
  return (
    callee
    && callee.type === 'MemberExpression'
    && callee.object
    && callee.object.type === 'Identifier'
    && callee.object.name === 'jest'
    && callee.property
    && callee.property.type === 'Identifier'
    && (callee.property.name === 'mock' || callee.property.name === 'doMock')
  );
}

/** The array literal passed to servedTenantsPool(...), when it is a literal. */
function servedTenantsArrayFrom(node) {
  if (
    node.type === 'CallExpression'
    && node.callee
    && node.callee.type === 'Identifier'
    && node.callee.name === 'servedTenantsPool'
    && node.arguments.length === 1
    && node.arguments[0].type === 'ArrayExpression'
  ) {
    return node.arguments[0];
  }
  return null;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Tests must not mock the tenant registry; stub the database and use a '
        + 'fixture with more than one tenant.',
    },
    schema: [],
    messages: {
      mockedRegistry:
        'Do not mock infrastructure/tenant-registry. It decides which tenants a '
        + 'sweep covers, so mocking it asserts this file\'s assumption instead of '
        + 'the behaviour. {{hint}}',
      singleTenantFixture:
        'servedTenantsPool() needs at least two tenants. A one-tenant fixture '
        + 'cannot tell a fan-out that covers every tenant apart from one that '
        + 'covers the first and returns — which is the bug this fixture exists to catch.',
    },
  },

  create(context) {
    const filename = context.filename ?? context.getFilename();
    const isTest = filename.includes('__tests__') || /\.test\.tsx?$/.test(filename);
    if (!isTest) return {};

    return {
      CallExpression(node) {
        if (isJestMockCall(node)) {
          const first = node.arguments[0];
          if (
            first
            && first.type === 'Literal'
            && typeof first.value === 'string'
            && REGISTRY_MODULE_RE.test(first.value.replace(/\.\.?\//g, '/'))
          ) {
            context.report({
              node: first,
              messageId: 'mockedRegistry',
              data: { hint: FIXTURE_HINT },
            });
          }
          return;
        }

        const arr = servedTenantsArrayFrom(node);
        if (arr && arr.elements.length < 2) {
          context.report({ node: arr, messageId: 'singleTenantFixture' });
        }
      },
    };
  },
};
