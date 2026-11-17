// The guardrail lifts a field AND the surface can still collect it.
//
// These are the two halves of one promise, and only the first half existed: the
// value was replaced with a placeholder in the model's copy and then dropped, so
// "the model cannot see this" and "nobody can see this" were the same outcome.
// The renderer built for it had no producer. This asserts the pair together,
// because either alone is a defect wearing the other's clothes.
jest.mock('../../connectors/tool-schema-cache', () => ({
  catalogTypeFor: (t: string) => t,
  // NOT categorised sensitive, and the value is an ordinary URL. Before step
  // (c) this combination was declared and then ignored.
  getToolSchema: () => ({ egressOnly: ['data.downloadUrl'], categories: [] }),
}));

import { BUILTIN_OUTPUT_GUARDRAILS } from '../output-guardrails';
import { drainHostDelivered, _resetHostDeliveredForTesting } from '../host-delivered';

const egress = BUILTIN_OUTPUT_GUARDRAILS.find((g) => g.name === 'egress-only')!;

beforeEach(() => _resetHostDeliveredForTesting());

describe('egress-only', () => {
  const output = { data: { downloadUrl: 'https://example.test/signed', name: 'report.pdf' } };

  it('removes the value from what the model sees and delivers it to the surface', async () => {
    const seen = await egress.check('drive__get_file', {}, output, 'tenant-1', { invocationId: 'inv-1' });

    // Gone from the model's copy...
    expect(JSON.stringify(seen)).not.toContain('https://example.test/signed');
    // ...and recoverable by the person it was lifted for.
    expect(drainHostDelivered('inv-1')).toEqual([
      { toolName: 'drive__get_file', fields: { 'data.downloadUrl': 'https://example.test/signed' } },
    ]);
  });

  it('leaves everything it did not lift alone', async () => {
    const seen = await egress.check('drive__get_file', {}, output, 'tenant-1', { invocationId: 'inv-1' });
    expect((seen as typeof output).data.name).toBe('report.pdf');
  });

  it('leaves an ordinary field in place when there is nobody to deliver it to', async () => {
    // The safety property step (c) had to keep. A declared download link with
    // no turn to carry it would be removed from the model's copy and land
    // nowhere — the person reads "here is your file" with no file, which is
    // indistinguishable from a tool that failed. Better left where it is.
    const seen = await egress.check('drive__get_file', {}, output, 'tenant-1', undefined);
    expect(JSON.stringify(seen)).toContain('https://example.test/signed');
    expect(drainHostDelivered(undefined)).toEqual([]);
  });
});

// A secret is lifted whether or not anyone is listening.
//
// Separate from the deliverable case on purpose: nobody needed to see it, so
// losing it costs nothing while leaving it in model context costs plenty. The
// `canDeliver` condition is about fields the PERSON wants, not about secrets.
describe('a secret-shaped value', () => {
  it('is lifted even with no invocation to deliver it to', async () => {
    const withSecret = { data: { downloadUrl: 'AKIAIOSFODNN7EXAMPLE' } };
    const seen = await egress.check('drive__get_file', {}, withSecret, 'tenant-1', undefined);
    expect(JSON.stringify(seen)).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});
