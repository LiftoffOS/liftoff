import { judgeCandidates } from '../judge';
import type { Candidate, CapabilitySpec } from '../types';

jest.mock('../../llm/client', () => ({
  llmClient: { complete: jest.fn() },
}));

import { llmClient } from '../../llm/client';

const SPEC: CapabilitySpec = {
  targetSystem: 'instagram',
  operation: 'monitor',
  entity: 'posts',
  mode: 'public_data',
  availableInputs: ['search_terms'],
  requiredOutputFields: ['url'],
  tenantId: 't-1',
  boundConnectorTypes: [],
};

const CANDIDATES: Candidate[] = [
  {
    source: 'apify_store',
    sourceRef: 'apify/instagram-scraper',
    title: 'Instagram Scraper',
    description: 'scrapes posts',
    mode: 'public_data',
  },
];

describe('judgeCandidates', () => {
  it('parses a well-formed batched verdict', async () => {
    (llmClient.complete as jest.Mock).mockResolvedValue({
      content: JSON.stringify({
        verdicts: [
          { index: 0, capabilityMatch: 3, inputSupplyable: 'yes', outputCovers: 'yes', shapeMatch: true, reason: 'direct match' },
        ],
      }),
    });
    const out = await judgeCandidates(SPEC, CANDIDATES);
    expect(out.degraded).toBe(false);
    expect(out.verdicts[0]).toMatchObject({ capabilityMatch: 3, inputSupplyable: 'yes' });
  });

  it('degrades to neutral verdicts on parse failure — candidates pass through', async () => {
    (llmClient.complete as jest.Mock).mockResolvedValue({ content: 'not json' });
    const out = await judgeCandidates(SPEC, CANDIDATES);
    expect(out.degraded).toBe(true);
    expect(out.verdicts).toHaveLength(1);
    expect(out.verdicts[0].inputSupplyable).toBe('partial');
  });

  it('degrades on a thrown call', async () => {
    (llmClient.complete as jest.Mock).mockRejectedValue(new Error('provider down'));
    const out = await judgeCandidates(SPEC, CANDIDATES);
    expect(out.degraded).toBe(true);
    expect(out.verdicts).toHaveLength(1);
  });

  it('answers empty input without a call', async () => {
    (llmClient.complete as jest.Mock).mockClear();
    const out = await judgeCandidates(SPEC, []);
    expect(out).toEqual({ verdicts: [], degraded: false });
    expect(llmClient.complete).not.toHaveBeenCalled();
  });
});
