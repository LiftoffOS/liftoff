// The egress guardrail finds the declaration the way the gateway calls it.
//
// The guardrail resolved the tool's schema from its NAME, expecting
// `<type>__<action>`. The gateway hands it the bare action — `find_file`,
// the way every catalog call is addressed — so the lookup was
// `getToolSchema('', 'find_file')`: null, on every call, and a connector's
// `egressOnly` declaration was never once read on the path every catalog
// call takes. The unit test beside this one stubbed the lookup to ignore its
// arguments and named the tool the way the guardrail wanted, so it passed
// against a caller that never existed.
//
// This drives the guardrail with the caller's real arguments against the real
// cache: the bare action, and the connector on the context.

import { __setToolSchemaCacheForTests, __clearToolSchemaCacheForTests } from '../../connectors/tool-schema-cache';
import { BUILTIN_OUTPUT_GUARDRAILS, EGRESS_ONLY_PLACEHOLDER } from '../output-guardrails';
import { drainHostDelivered, _resetHostDeliveredForTesting } from '../host-delivered';

const egress = BUILTIN_OUTPUT_GUARDRAILS.find((g) => g.name === 'egress-only')!;

beforeEach(() => {
  _resetHostDeliveredForTesting();
  __setToolSchemaCacheForTests([{
    connectorType: 'google_drive',
    functions: [{
      name: 'find_file',
      description: '',
      categories: ['read'],
      inputSchema: { type: 'object', properties: {} },
      egressOnly: ['files[].webViewLink'],
    }],
  }]);
});
afterEach(() => __clearToolSchemaCacheForTests());

const output = { files: [{ id: 'f1', name: 'report.pdf', webViewLink: 'https://drive.google.com/file/d/f1/view' }] };

it('lifts the declared field when addressed as the gateway addresses it: bare action, connector alias on the context', async () => {
  const seen = await egress.check('find_file', {}, output, 'tenant-1', { invocationId: 'inv-1', connector: 'google_drive-8fd9fc68' });
  expect((seen as typeof output).files[0].webViewLink).toBe(EGRESS_ONLY_PLACEHOLDER);
  expect(drainHostDelivered('inv-1')).toEqual([
    { toolName: 'find_file', fields: { 'files[].webViewLink': 'https://drive.google.com/file/d/f1/view' } },
  ]);
});

it('still resolves a caller that carries the type in the name', async () => {
  const seen = await egress.check('google_drive__find_file', {}, output, 'tenant-1', { invocationId: 'inv-2' });
  expect((seen as typeof output).files[0].webViewLink).toBe(EGRESS_ONLY_PLACEHOLDER);
});

it('with neither, there is no declaration to honour and the result is untouched', async () => {
  // What every gateway call looked like before the connector rode the context.
  const seen = await egress.check('find_file', {}, output, 'tenant-1', { invocationId: 'inv-3' });
  expect(seen).toEqual(output);
  expect(drainHostDelivered('inv-3')).toEqual([]);
});
