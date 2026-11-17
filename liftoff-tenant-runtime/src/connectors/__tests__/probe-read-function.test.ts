// The probe's question has to be one the function says it can answer with
// no input. Hunter's `get_account` takes nothing and proves the key; its
// `combined_enrichment` needs an email, and '' is not one — the vendor's
// "missing parameter" answer measured the probe, not the binding.

import { pickProbeReadFunction, isPayloadRejection } from '../probe-read-function';

const fn = (
  name: string,
  categories: string[],
  schema: { required?: string[]; properties?: Record<string, unknown> } = {},
) => ({ name, categories, inputSchema: schema });

describe('pickProbeReadFunction', () => {
  it('prefers a read function that declares no inputs at all', () => {
    const picked = pickProbeReadFunction([
      fn('combined_enrichment', ['read'], { required: ['email'], properties: { email: { type: 'string' } } }),
      fn('find_people', ['read'], { properties: { query: { type: 'string' }, limit: { type: 'number' } } }),
      fn('get_account', ['read'], {}),
    ]);
    expect(picked?.name).toBe('get_account');
  });

  it('falls back to a read function whose inputs are all optional', () => {
    const picked = pickProbeReadFunction([
      fn('enrich_ip', ['read'], { required: ['ip'], properties: { ip: { type: 'string' } } }),
      fn('enrich_person', ['read'], { properties: { email: { type: 'string' } } }),
    ]);
    expect(picked?.name).toBe('enrich_person');
  });

  it('never picks a function with a required input — there is nothing honest to send', () => {
    expect(pickProbeReadFunction([
      fn('autocomplete_fields', ['read'], { required: ['field'], properties: { field: { type: 'string' } } }),
    ])).toBeNull();
  });

  it('never picks a write, destructive, outbound or sensitive function, whatever it requires', () => {
    expect(pickProbeReadFunction([
      fn('list_pii', ['read', 'sensitive'], {}),
      fn('send', ['outbound'], {}),
      fn('drop', ['read', 'destructive'], {}),
      fn('upsert', ['read', 'write'], {}),
    ])).toBeNull();
  });

  it('returns null for nothing', () => {
    expect(pickProbeReadFunction([])).toBeNull();
    expect(pickProbeReadFunction(null)).toBeNull();
  });
});

describe('isPayloadRejection', () => {
  it('recognises a vendor complaining about the request', () => {
    expect(isPayloadRejection('hunter.combined_enrichment: You are missing one of the following parameters: email, linkedin_handle')).toBe(true);
    expect(isPayloadRejection("pdl.autocomplete_fields: The 'field' parameter is required.")).toBe(true);
    expect(isPayloadRejection('HTTP 422 Unprocessable Entity')).toBe(true);
  });

  it('does not mistake a refusal or an outage for a malformed request', () => {
    expect(isPayloadRejection('401 Unauthorized — token revoked')).toBe(false);
    expect(isPayloadRejection('503 Service Unavailable')).toBe(false);
    expect(isPayloadRejection('connection reset by peer')).toBe(false);
  });
});
