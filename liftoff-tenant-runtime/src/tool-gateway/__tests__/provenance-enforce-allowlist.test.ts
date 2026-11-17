// Enforcement is per connector because declaration coverage is.
//
// gmail has thirteen response paths declared; github has none, and vendor-
// hosted MCP has no home for them yet. A single global flip would start
// refusing writes on the 123 connectors covered by nothing but the heuristic
// floor — the half of this that guesses, and which spent its first week
// flagging every workspace file write because it asked a run where it had
// heard of its own invocation id.

import {
  provenanceGateMode,
  provenanceEnforcedConnectors,
  provenanceEnforcedFor,
} from '../record-provenance';

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

describe('the global mode alone never refuses', () => {
  it('enforces nothing when no connector is listed', () => {
    // Two deliberate settings are required to reach a refusal, and the list is
    // the one that names what was actually checked.
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    delete process.env.PROVENANCE_ENFORCE_CONNECTORS;
    expect(provenanceGateMode()).toBe('enforce');
    expect(provenanceEnforcedFor('gmail')).toBe(false);
  });

  it('enforces nothing when the list is empty or whitespace', () => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    for (const v of ['', '  ', ',', ' , ']) {
      process.env.PROVENANCE_ENFORCE_CONNECTORS = v;
      expect(provenanceEnforcedFor('gmail')).toBe(false);
    }
  });
});

describe('a listed connector is enforced and its neighbours are not', () => {
  beforeEach(() => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'gmail, slack';
  });

  it('enforces the ones named', () => {
    expect(provenanceEnforcedFor('gmail')).toBe(true);
    expect(provenanceEnforcedFor('slack')).toBe(true);
  });

  it('leaves an undeclared connector in shadow', () => {
    // github is the case this exists for: the pilot's own connector, with no
    // declarations and no home for them.
    expect(provenanceEnforcedFor('github')).toBe(false);
  });

  it('tolerates spacing and case, since this is hand-edited config', () => {
    process.env.PROVENANCE_ENFORCE_CONNECTORS = '  GMail ,slack ';
    expect(provenanceEnforcedFor('gmail')).toBe(true);
    expect(provenanceEnforcedFor('GMAIL')).toBe(true);
  });

  it('parses the list itself', () => {
    expect([...provenanceEnforcedConnectors()].sort()).toEqual(['gmail', 'slack']);
  });
});

describe('shadow and off never refuse, whatever the list says', () => {
  it.each(['shadow', 'off', 'typo', ''])('mode %p refuses nothing', (mode) => {
    process.env.PROVENANCE_GATE_MODE = mode;
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'gmail,slack';
    expect(provenanceEnforcedFor('gmail')).toBe(false);
  });

  it('refuses nothing for a call that names no connector', () => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'gmail';
    expect(provenanceEnforcedFor(undefined)).toBe(false);
  });
});

describe('`declared`: enforce wherever there is a declaration to enforce on', () => {
  beforeEach(() => {
    process.env.PROVENANCE_GATE_MODE = 'enforce';
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'declared';
  });

  it('enforces any connector whose write carries a declaration', () => {
    expect(provenanceEnforcedFor('notion-0badf00d', { idArgs: ['page_id'] })).toBe(true);
    expect(provenanceEnforcedFor('custom-mcp-d144a7ea', { idArgs: ['id'] })).toBe(true);
  });

  it('never enforces a write nothing declares — the floor reports, the floor does not refuse', () => {
    expect(provenanceEnforcedFor('notion-0badf00d', undefined)).toBe(false);
    expect(provenanceEnforcedFor('notion-0badf00d', { idArgs: [] })).toBe(false);
    // A read-side declaration alone is not a declaration to judge a write by.
    expect(provenanceEnforcedFor('notion-0badf00d', { returnsIds: [{ entityType: 'page', path: 'id' }] })).toBe(false);
  });

  it('mixes with explicit names', () => {
    process.env.PROVENANCE_ENFORCE_CONNECTORS = 'github, declared';
    // Named: enforced whatever the declaration, as before.
    expect(provenanceEnforcedFor('github-dd4c4689', undefined)).toBe(true);
    // Not named, declared: enforced by the word.
    expect(provenanceEnforcedFor('notion-0badf00d', { idArgs: ['page_id'] })).toBe(true);
    expect(provenanceEnforcedFor('notion-0badf00d', undefined)).toBe(false);
  });

  it('is a word on the list, not a connector', () => {
    expect(provenanceEnforcedFor('declared', undefined)).toBe(false);
  });
});
