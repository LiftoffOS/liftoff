// The distiller teaches the graph author what the guard can answer, so it has
// to name the answers the guard actually gives.
//
// `have_i_acted_on` returned `not_acted` once. It was renamed to `no_record`
// because the old name was a claim about the world the ledger is in no position
// to make: the ledger records dispatch, so "nothing recorded" and "did not
// happen" are different facts. The runtime union changed; two places in this
// prompt kept teaching the retired name.
//
// A graph authored against a verdict the tool never emits has a branch that can
// never be taken, and the model has no way to discover that — it is being told
// the contract, not reading it.
//
// The runtime is the source of truth: PriorActionVerdict in the tenant
// runtime's src/action-ledger/service.ts. It cannot be imported across the
// repository boundary, so it is restated here and this test is what keeps the
// restatement honest. A rename there is a two-repository landing and this is
// the half that fails in this one.

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'distill-service.ts'), 'utf8');

const RUNTIME_VERDICTS = ['acted', 'acted_at_other_version', 'acted_version_unknown', 'no_record'];
const RETIRED_VERDICTS = ['not_acted'];

describe('the prompt names the verdicts the runtime returns', () => {
  it.each(RUNTIME_VERDICTS)('teaches "%s"', (verdict) => {
    expect(SRC).toContain(`"${verdict}"`);
  });

  it.each(RETIRED_VERDICTS)('never teaches the retired "%s"', (verdict) => {
    expect(SRC).not.toContain(verdict);
  });

  // The field that says whether the verdict could discriminate at all. Without
  // it a graph reads `acted` as "the work is still there", which on every
  // connector but GitHub it cannot mean.
  it('teaches versionBasis and what its unavailable case implies', () => {
    expect(SRC).toContain('versionBasis');
    expect(SRC).toContain('unavailable_for_connector');
  });
});
