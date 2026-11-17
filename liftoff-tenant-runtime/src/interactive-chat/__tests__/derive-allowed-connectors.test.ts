import { deriveAllowedConnectors } from '../connector-utils';

describe('deriveAllowedConnectors', () => {
  it('uses type when present', () => {
    const result = deriveAllowedConnectors([
      { id: 'uuid-1', type: 'github' },
      { id: 'uuid-2', type: 'slack' },
    ]);
    expect(result).toEqual(['github', 'slack']);
  });

  it('falls back to UUID when type is absent (old records — SQL resolves via connectors table)', () => {
    const result = deriveAllowedConnectors([
      { id: 'uuid-abc' } as any,
    ]);
    expect(result).toEqual(['uuid-abc']);
  });

  it('returns empty array for no integrations → no connector tools loaded', () => {
    expect(deriveAllowedConnectors([])).toEqual([]);
  });

  it('filters out entries with neither type nor id', () => {
    const result = deriveAllowedConnectors([
      { id: '', type: '' },
      { id: 'uuid-1', type: 'github' },
    ]);
    // id='' and type='' both falsy — entry dropped; only 'github' survives
    expect(result).toEqual(['github']);
  });

  it('mixes typed and untyped integrations', () => {
    const result = deriveAllowedConnectors([
      { id: 'uuid-1', type: 'github' },
      { id: 'uuid-2' },              // no type → falls back to UUID
    ]);
    expect(result).toEqual(['github', 'uuid-2']);
  });
});
